// @constraint RT-1 — Local CA installed + accessible to proxy (BINDING)
// @constraint T2 — mkcert-managed CA
// @constraint U4 — Node.js NODE_EXTRA_CA_CERTS gotcha surfaced
// @constraint S5 — CA common name is self-identifying
// @constraint S1 — rootCA-key.pem enforced 0600 (closes G7)

import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enforceKeyPermissions,
  nodeExtraCaCertsMessage,
  scopedCommonName,
} from "../src/features/proxy/ca.ts";

describe("scopedCommonName (S5)", () => {
  it("includes sanitized user and hostname", () => {
    expect(scopedCommonName("alice", "macbook-pro")).toBe("mockstar-dev-ca-alice@macbook-pro");
  });

  it("sanitises special characters (only [a-zA-Z0-9_-] survive)", () => {
    // Both '@' in user and '.' in hostname get replaced with '_'
    expect(scopedCommonName("bob@corp", "host.with.dots")).toBe("mockstar-dev-ca-bob_corp@host_with_dots");
  });

  it("truncates excessively long user names to 32 chars", () => {
    const longUser = "a".repeat(100);
    const cn = scopedCommonName(longUser, "host");
    expect(cn.startsWith("mockstar-dev-ca-")).toBe(true);
    // Payload after prefix should be <= 32 + 1 + 32 chars
    expect(cn.length).toBeLessThanOrEqual("mockstar-dev-ca-".length + 32 + 1 + 32);
  });

  it("handles empty / weird inputs", () => {
    expect(scopedCommonName("", "")).toMatch(/^mockstar-dev-ca-anon@anon$/);
  });
});

describe("nodeExtraCaCertsMessage (U4)", () => {
  it("includes a copy-pasteable export command", () => {
    const msg = nodeExtraCaCertsMessage({
      caRoot: "/Users/alice/Library/mkcert",
      rootCertPem: "/Users/alice/Library/mkcert/rootCA.pem",
      rootKeyPem: "/Users/alice/Library/mkcert/rootCA-key.pem",
    });
    expect(msg).toContain("NODE_EXTRA_CA_CERTS");
    expect(msg).toContain("/Users/alice/Library/mkcert/rootCA.pem");
    expect(msg).toContain("~/.zshrc");
  });

  it("warns explicitly about SDKs failing without the env var", () => {
    const msg = nodeExtraCaCertsMessage({
      caRoot: "/x",
      rootCertPem: "/x/rootCA.pem",
      rootKeyPem: "/x/rootCA-key.pem",
    });
    expect(msg).toContain("Without this");
    expect(msg).toMatch(/CERT_UNKNOWN_AUTHORITY|reject/);
  });
});

describe("enforceKeyPermissions (S1 / G7)", () => {
  async function makeKeyFile(
    mode: number,
  ): Promise<{ caRoot: string; rootCertPem: string; rootKeyPem: string }> {
    const caRoot = await mkdtemp(join(tmpdir(), "mockstar-ca-perms-"));
    const rootCertPem = join(caRoot, "rootCA.pem");
    const rootKeyPem = join(caRoot, "rootCA-key.pem");
    await writeFile(rootCertPem, "CERT", "utf8");
    await writeFile(rootKeyPem, "KEY", { encoding: "utf8", mode });
    await chmod(rootKeyPem, mode);
    return { caRoot, rootCertPem, rootKeyPem };
  }

  it("normalises 0644 key to 0600", async () => {
    const paths = await makeKeyFile(0o644);
    const result = await enforceKeyPermissions(paths);
    expect(result).toBe(0o600);
    const after = await stat(paths.rootKeyPem);
    expect(after.mode & 0o777).toBe(0o600);
  });

  it("leaves an already-0600 key unchanged", async () => {
    const paths = await makeKeyFile(0o600);
    const result = await enforceKeyPermissions(paths);
    expect(result).toBe(0o600);
    const after = await stat(paths.rootKeyPem);
    expect(after.mode & 0o777).toBe(0o600);
  });

  it("normalises 0640 (group-readable) to 0600", async () => {
    const paths = await makeKeyFile(0o640);
    const result = await enforceKeyPermissions(paths);
    expect(result).toBe(0o600);
    const after = await stat(paths.rootKeyPem);
    expect(after.mode & 0o777).toBe(0o600);
  });
});
