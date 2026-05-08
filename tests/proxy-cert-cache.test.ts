// @constraint RT-4 — Versioned snapshots + atomic swap + evicted hostname detection (STRUCTURAL)
// @constraint T5, T8, O5

import { describe, it, expect } from "bun:test";
import { SnapshotHolder, evictedHostnames, needsRefresh } from "../src/features/proxy/cert-cache.ts";
import type { LeafCert, ProxySnapshot } from "../src/features/proxy/types.ts";

function makeSnapshot(
  version: number,
  hosts: Array<{ host: string; tenant: string }>,
  leafCertPem: (host: string) => string = () => "PEM-CERT",
): ProxySnapshot {
  const hostMap = new Map(hosts.map((h) => [h.host, { host: h.host, tenant: h.tenant }]));
  const leaves = new Map<string, LeafCert>();
  for (const h of hosts) {
    leaves.set(h.host, {
      host: h.host,
      certPem: leafCertPem(h.host),
      keyPem: "PEM-KEY",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      snapshotVersion: version,
    });
  }
  return Object.freeze({
    version,
    hosts: hostMap,
    leaves,
    config: {
      hosts: hosts as never,
      mockstarUrl: "http://127.0.0.1:3000",
      listenHost: "127.0.0.1",
      listenPort: 443,
      upstreamTimeoutMs: 5000,
      leafTtlHours: 24,
      dnsMode: "dnsmasq",
    },
  }) as unknown as ProxySnapshot;
}

describe("SnapshotHolder", () => {
  it("atomic get returns the current snapshot", () => {
    const initial = makeSnapshot(1, [{ host: "api.razorpay.com", tenant: "razorpay" }]);
    const holder = new SnapshotHolder(initial);
    expect(holder.get().version).toBe(1);
    expect(holder.get().hosts.has("api.razorpay.com")).toBe(true);
  });

  it("swap replaces the pointer and returns previous", () => {
    const v1 = makeSnapshot(1, [{ host: "a.example.com", tenant: "t1" }]);
    const v2 = makeSnapshot(2, [
      { host: "a.example.com", tenant: "t1" },
      { host: "b.example.com", tenant: "t2" },
    ]);
    const holder = new SnapshotHolder(v1);
    const { previous, next } = holder.swap(v2);
    expect(previous.version).toBe(1);
    expect(next.version).toBe(2);
    expect(holder.get().version).toBe(2);
  });

  it("captured snapshot survives swap (immutable reader semantics)", () => {
    const v1 = makeSnapshot(1, [{ host: "a.com", tenant: "t" }]);
    const v2 = makeSnapshot(2, [{ host: "b.com", tenant: "t" }]);
    const holder = new SnapshotHolder(v1);
    const captured = holder.get();
    holder.swap(v2);
    // The captured reference still reads as v1.
    expect(captured.version).toBe(1);
    expect(captured.hosts.has("a.com")).toBe(true);
  });
});

describe("evictedHostnames", () => {
  it("returns hosts removed in the next snapshot", () => {
    const prev = makeSnapshot(1, [
      { host: "a.com", tenant: "t" },
      { host: "b.com", tenant: "t" },
    ]);
    const next = makeSnapshot(2, [{ host: "a.com", tenant: "t" }]);
    expect([...evictedHostnames(prev, next)]).toEqual(["b.com"]);
  });

  it("detects cert-changed hosts as evicted (forces session close)", () => {
    const prev = makeSnapshot(1, [{ host: "a.com", tenant: "t" }], () => "PEM-CERT-V1");
    const next = makeSnapshot(2, [{ host: "a.com", tenant: "t" }], () => "PEM-CERT-V2");
    expect([...evictedHostnames(prev, next)]).toEqual(["a.com"]);
  });

  it("returns empty when nothing changes", () => {
    const prev = makeSnapshot(1, [{ host: "a.com", tenant: "t" }]);
    const next = makeSnapshot(2, [{ host: "a.com", tenant: "t" }]);
    expect([...evictedHostnames(prev, next)]).toEqual([]);
  });
});

describe("needsRefresh", () => {
  it("returns true for imminently expiring leaves", () => {
    const leaf: LeafCert = {
      host: "x.com",
      certPem: "PEM",
      keyPem: "KEY",
      expiresAt: Date.now() + 10 * 1000, // 10 seconds
      snapshotVersion: 1,
    };
    expect(needsRefresh(leaf, 60 * 1000)).toBe(true); // 1 min window
  });

  it("returns false for long-lived leaves", () => {
    const leaf: LeafCert = {
      host: "x.com",
      certPem: "PEM",
      keyPem: "KEY",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      snapshotVersion: 1,
    };
    expect(needsRefresh(leaf, 60 * 60 * 1000)).toBe(false);
  });
});
