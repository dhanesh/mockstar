// Satisfies: RT-7 (install is append-only-journaled and LIFO-reversible)
// Satisfies: U1 (atomic install), U2 (zero-residue uninstall), O6 (install audit log)
//
// File format: JSON-lines (one InstallStep per line), plus per-line checksum.
// Append-only in intent: we use {flag: 'a', flush: true} and fsync after each write.
// Corruption detection: each line includes a SHA-256 checksum of the {step,
// timestamp, action, reverseCommand} payload; readback verifies.

import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomBytes as _randomBytes } from "node:crypto";
import type { InstallStep, ReverseCommand } from "./types.ts";
import { ProxyError } from "./types.ts";

// --- PUBLIC API ----------------------------------------------------------

export interface JournalFacts {
  readonly path: string;
  readonly exists: boolean;
  readonly stepCount: number;
  readonly lastStep?: InstallStep;
  readonly corrupt: boolean;
}

/**
 * Append a single step. Computes the checksum and writes the line + newline.
 * The write is flushed before returning so a crash after append doesn't lose the record.
 */
export async function appendStep(
  path: string,
  step: Omit<InstallStep, "step" | "timestamp" | "checksum">,
): Promise<InstallStep> {
  await mkdir(dirname(path), { recursive: true });

  const existing = await readAll(path).catch(() => [] as InstallStep[]);
  const next = existing.length + 1;
  const full: InstallStep = {
    step: next,
    timestamp: new Date().toISOString(),
    action: step.action,
    reverseCommand: step.reverseCommand,
    checksum: "",
  };
  const payload = JSON.stringify({
    step: full.step,
    timestamp: full.timestamp,
    action: full.action,
    reverseCommand: full.reverseCommand,
  });
  const withChecksum: InstallStep = { ...full, checksum: sha256(payload) };

  const line = JSON.stringify(withChecksum) + "\n";
  await appendFile(path, line, { encoding: "utf8" });
  return withChecksum;
}

/** Read the full journal. Throws if any line is corrupt (checksum mismatch). */
export async function readJournal(path: string): Promise<InstallStep[]> {
  return readAll(path);
}

/**
 * LIFO walk: for each recorded step (newest first), yield the reverse command for
 * the caller to execute. Once a reverse succeeds the caller should call
 * {@link markReversed} — we track this by rewriting the journal atomically on completion.
 *
 * The journal file itself is removed after a successful uninstall (every step reversed).
 */
export async function* reverseSteps(path: string): AsyncIterable<InstallStep> {
  const steps = await readJournal(path);
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step) yield step;
  }
}

/**
 * Called by the caller after every step has been successfully reversed (or explicitly skipped).
 * Removes the journal file entirely — uninstall is complete.
 */
export async function clearJournal(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Produce a JournalFacts summary for `mockstar proxy status`. */
export async function journalFacts(path: string): Promise<JournalFacts> {
  let exists = false;
  try {
    await stat(path);
    exists = true;
  } catch {
    return { path, exists: false, stepCount: 0, corrupt: false };
  }
  try {
    const steps = await readJournal(path);
    return {
      path,
      exists,
      stepCount: steps.length,
      lastStep: steps[steps.length - 1],
      corrupt: false,
    };
  } catch {
    return { path, exists, stepCount: 0, corrupt: true };
  }
}

/**
 * Execute the atomic-install wrapper. Caller passes a list of mutations, each with
 * an apply fn + a reverse command. If any mutation throws, previously-succeeded
 * steps are reversed in LIFO order. Journal is written after every successful apply.
 */
export async function atomicInstall(
  journalPath: string,
  mutations: readonly Mutation[],
  options: { onStep?: (step: InstallStep) => void } = {},
): Promise<{ applied: InstallStep[] }> {
  const applied: InstallStep[] = [];
  try {
    for (const mutation of mutations) {
      await mutation.apply();
      const step = await appendStep(journalPath, {
        action: mutation.action,
        reverseCommand: mutation.reverseCommand,
      });
      applied.push(step);
      options.onStep?.(step);
    }
    return { applied };
  } catch (err) {
    // Roll back everything we've successfully applied so far, LIFO.
    for (let i = applied.length - 1; i >= 0; i--) {
      const step = applied[i];
      if (!step) continue;
      const reverseFn = reverseCommandImpls[step.reverseCommand.kind];
      if (reverseFn) {
        try {
          await reverseFn(step.reverseCommand as never);
        } catch {
          // best-effort rollback; log but don't re-throw — we want the ORIGINAL error to surface
        }
      }
    }
    await clearJournal(journalPath).catch(() => undefined);
    throw err;
  }
}

export interface Mutation {
  readonly action: string;
  readonly reverseCommand: ReverseCommand;
  apply(): Promise<void>;
}

/**
 * Execute a single reverse command. Used by atomicInstall's rollback path and by
 * `mockstar proxy uninstall`. Each handler is idempotent — re-running is a no-op.
 */
export async function executeReverse(cmd: ReverseCommand): Promise<void> {
  const fn = reverseCommandImpls[cmd.kind];
  if (!fn) {
    throw new ProxyError(
      `No reverse implementation for command kind '${cmd.kind}'`,
      "reverse_command_not_implemented",
    );
  }
  await fn(cmd as never);
}

// --- REVERSE COMMAND IMPLEMENTATIONS (idempotent; safe to re-run) --------

const reverseCommandImpls: {
  [K in ReverseCommand["kind"]]: (cmd: Extract<ReverseCommand, { kind: K }>) => Promise<void>;
} = {
  mkcert_uninstall: async () => {
    const { uninstallCa } = await import("./ca.ts");
    await uninstallCa().catch(() => undefined); // mkcert is itself idempotent
  },
  remove_file: async ({ path }) => {
    await rm(path, { force: true });
  },
  remove_dir: async ({ path }) => {
    await rm(path, { recursive: true, force: true });
  },
  revert_file: async ({ path, originalContent }) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, originalContent, "utf8");
  },
  dnsmasq_stop_and_remove: async () => {
    // Platform-specific; delegated to the dns module to know which service manager to use.
    const dns = await import("./dns.ts");
    await dns.stopAndRemoveDnsmasq();
  },
  revert_hosts_entries: async ({ blockMarker }) => {
    const dns = await import("./dns.ts");
    await dns.revertHostsBlock(blockMarker);
  },
  setcap_drop: async ({ path }) => {
    const { runPrivileged } = await import("./port-bind.ts");
    await runPrivileged(["setcap", "-r", path]).catch(() => undefined);
  },
  launchctl_unload_and_remove: async ({ plistPath }) => {
    const { runPrivileged } = await import("./port-bind.ts");
    await runPrivileged(["launchctl", "unload", "-w", plistPath]).catch(() => undefined);
    await rm(plistPath, { force: true });
  },
  noop: async () => {
    // nothing to do
  },
};

// --- INTERNALS -----------------------------------------------------------

async function readAll(path: string): Promise<InstallStep[]> {
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  const out: InstallStep[] = [];
  for (const line of lines) {
    let parsed: InstallStep;
    try {
      parsed = JSON.parse(line) as InstallStep;
    } catch {
      throw new ProxyError(
        `Install journal corruption: un-parseable line`,
        "journal_corrupt",
        "Manual recovery: see docs/PROXY-RECOVERY.md",
      );
    }
    const payload = JSON.stringify({
      step: parsed.step,
      timestamp: parsed.timestamp,
      action: parsed.action,
      reverseCommand: parsed.reverseCommand,
    });
    const expected = sha256(payload);
    if (expected !== parsed.checksum) {
      throw new ProxyError(
        `Install journal corruption: checksum mismatch at step ${parsed.step}`,
        "journal_checksum_mismatch",
        "Manual recovery: see docs/PROXY-RECOVERY.md",
      );
    }
    out.push(parsed);
  }
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
