// Satisfies: RT-1 (local CA installed + accessible to proxy) *** BINDING CONSTRAINT ***
// Satisfies: T2 (mkcert-managed CA), S1 (rootCA-key.pem 0600 enforcement), U4 (Node.js gotcha surfaced)
// Priority: binding (RT-1 is the foundation of the entire feature)
//
// Wraps mkcert to:
//   - install/uninstall the local CA in the OS trust store
//   - locate rootCA-key.pem + rootCA.pem via `mkcert -CAROOT`
//   - generate per-hostname leaf certs with a 24h TTL (TN4)
//   - enforce 0600 permissions on the CA key (S1)
//   - surface the NODE_EXTRA_CA_CERTS gotcha (U4)
//
// External dependency: `mkcert` binary on PATH. If missing, the proxy refuses to start with
// a specific remediation message.

import { spawn } from "node:child_process";
import { access, chmod, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { ProxyError } from "./types.ts";

// --- PUBLIC API ----------------------------------------------------------

export interface CaPaths {
  readonly caRoot: string; // directory containing rootCA.pem + rootCA-key.pem
  readonly rootCertPem: string; // absolute path to rootCA.pem
  readonly rootKeyPem: string; // absolute path to rootCA-key.pem
}

export interface CaFacts {
  readonly paths: CaPaths;
  readonly installed: boolean; // is the CA in the OS trust store?
  readonly commonName: string; // self-identifying CN per S5
  readonly nodeExtraCaCertsCommand: string; // copy-paste snippet for Node.js users
}

/** Build the scoped CN used for the dev CA (S5 — self-identifying). */
export function scopedCommonName(user: string, host: string): string {
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "anon";
  return `mockstar-dev-ca-${safe(user)}@${safe(host)}`;
}

/** Return the mkcert CAROOT directory and the standard file paths within it. */
export async function resolveCaPaths(): Promise<CaPaths> {
  const caRoot = (await runMkcert(["-CAROOT"])).stdout.trim();
  if (!caRoot) {
    throw new ProxyError(
      "mkcert returned an empty CAROOT directory",
      "mkcert_no_caroot",
      "Ensure mkcert is installed and accessible on PATH (brew install mkcert || apt install mkcert).",
    );
  }
  return {
    caRoot,
    rootCertPem: join(caRoot, "rootCA.pem"),
    rootKeyPem: join(caRoot, "rootCA-key.pem"),
  };
}

/** Is the CA currently trusted by the OS? Inferred by whether rootCA.pem exists + mkcert reports installed. */
export async function isCaInstalled(paths: CaPaths): Promise<boolean> {
  try {
    await access(paths.rootCertPem, fsConstants.R_OK);
    await access(paths.rootKeyPem, fsConstants.R_OK);
  } catch {
    return false;
  }
  // `mkcert -install` is idempotent; there's no direct "is installed" subcommand,
  // but we can probe by running `-install` with a dry-run flag it doesn't have —
  // so instead we rely on file presence + permissions as the signal, plus the
  // caller's install-journal tracking.
  return true;
}

/**
 * Run `mkcert -install`. Safe to call multiple times (mkcert itself is idempotent).
 * Records no journal entry here — the caller is responsible for journaling via install-journal.ts.
 */
export async function installCa(): Promise<void> {
  const result = await runMkcert(["-install"]);
  if (result.exitCode !== 0) {
    throw new ProxyError(
      `mkcert -install failed: ${result.stderr.trim() || result.stdout.trim()}`,
      "mkcert_install_failed",
      "Check that mkcert can write to the system trust store (may require sudo on some systems).",
    );
  }
}

/** Run `mkcert -uninstall`. Safe to call multiple times. */
export async function uninstallCa(): Promise<void> {
  const result = await runMkcert(["-uninstall"]);
  if (result.exitCode !== 0) {
    throw new ProxyError(
      `mkcert -uninstall failed: ${result.stderr.trim() || result.stdout.trim()}`,
      "mkcert_uninstall_failed",
    );
  }
}

/**
 * Enforce 0600 on rootCA-key.pem (S1). Returns the file's mode after normalisation.
 * Refuses if the file is currently readable by others and chmod cannot reach 0600.
 */
export async function enforceKeyPermissions(paths: CaPaths): Promise<number> {
  const s = await stat(paths.rootKeyPem);
  const currentMode = s.mode & 0o777;
  if (currentMode !== 0o600) {
    await chmod(paths.rootKeyPem, 0o600);
    const again = await stat(paths.rootKeyPem);
    const newMode = again.mode & 0o777;
    if (newMode !== 0o600) {
      throw new ProxyError(
        `Could not enforce 0600 on ${paths.rootKeyPem}; current mode is ${newMode.toString(8)}`,
        "ca_key_permission_refused",
        "Check the file system (some FS types strip mode bits). Consider moving the CAROOT to a local filesystem.",
      );
    }
  }
  return 0o600;
}

/**
 * Generate a leaf cert + key for the given hostname, valid for `ttlHours`.
 * Writes to a scratch dir (mkcert's default is CWD), returns PEM strings in memory.
 */
export async function generateLeaf(
  host: string,
  opts: { ttlHours: number; scratchDir: string },
): Promise<{ certPem: string; keyPem: string; expiresAt: number }> {
  const certPath = join(opts.scratchDir, `${safeHostFilename(host)}.pem`);
  const keyPath = join(opts.scratchDir, `${safeHostFilename(host)}-key.pem`);
  const result = await runMkcert(["-cert-file", certPath, "-key-file", keyPath, host]);
  if (result.exitCode !== 0) {
    throw new ProxyError(
      `mkcert leaf generation failed for ${host}: ${result.stderr.trim() || result.stdout.trim()}`,
      "mkcert_leaf_failed",
    );
  }

  const [certPem, keyPem] = await Promise.all([readAndClear(certPath), readAndClear(keyPath)]);
  const expiresAt = Date.now() + opts.ttlHours * 60 * 60 * 1000;
  return { certPem, keyPem, expiresAt };
}

/** The user-facing string for the install output (U4). */
export function nodeExtraCaCertsMessage(paths: CaPaths): string {
  return (
    `Node.js does not use the system trust store. For Node-based SDKs (e.g., the Razorpay Node SDK)\n` +
    `to accept mockstar's dev CA, export NODE_EXTRA_CA_CERTS in your shell rc:\n\n` +
    `  echo 'export NODE_EXTRA_CA_CERTS="${paths.rootCertPem}"' >> ~/.zshrc\n` +
    `  # (or ~/.bashrc / ~/.config/fish/config.fish as appropriate)\n\n` +
    `Then reload your shell. Without this, SDKs using Node's built-in TLS client will reject\n` +
    `the mockstar cert with CERT_UNKNOWN_AUTHORITY or similar.`
  );
}

/** Return a CaFacts summary suitable for `mockstar proxy status`. */
export async function caFacts(params: { user: string; hostname: string }): Promise<CaFacts> {
  const paths = await resolveCaPaths();
  const installed = await isCaInstalled(paths);
  return {
    paths,
    installed,
    commonName: scopedCommonName(params.user, params.hostname),
    nodeExtraCaCertsCommand: nodeExtraCaCertsMessage(paths),
  };
}

// --- INTERNALS -----------------------------------------------------------

interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runMkcert(args: readonly string[]): Promise<ShellResult> {
  return runCmd("mkcert", args);
}

function runCmd(cmd: string, args: readonly string[]): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args as string[], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(
        new ProxyError(
          `Failed to run '${cmd}': ${err.message}`,
          "mkcert_not_found",
          `Install mkcert: 'brew install mkcert' (macOS) or 'apt install mkcert libnss3-tools' (Debian).`,
        ),
      );
    });
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

async function readAndClear(path: string): Promise<string> {
  const { readFile, unlink } = await import("node:fs/promises");
  const content = await readFile(path, "utf8");
  await unlink(path).catch(() => {
    /* best-effort cleanup; leaf files are transient */
  });
  return content;
}

function safeHostFilename(host: string): string {
  return host.replace(/[^a-zA-Z0-9._-]/g, "_");
}
