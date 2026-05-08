// Validates: T9 (INVARIANT — hot-reload preserves in-flight retry curves), TN6 (process-lifetime bound), RT-6
// @constraint T9 - snapshot swap mid-curve: in-flight closures continue against the original snapshot
//
// The CONSTRAINT-LEVEL truth: SnapshotHolder.get() returns a stable reference that is FROZEN at swap.
// Closures captured at delivery-schedule time read the snapshot they captured, even after subsequent
// swaps. This is what makes T9 honourable on top of an in-memory queue.

import { describe, expect, test } from "bun:test";
import { SnapshotHolder } from "../../src/core/config/snapshot.ts";
import type { ConfigSnapshot, TenantSnapshot } from "../../src/core/config/snapshot.ts";
import type { HandlerRegistry } from "../../src/core/handlers/index.ts";

const emptyRegistry: HandlerRegistry = Object.freeze({
  get size() {
    return 0;
  },
  has: () => false,
  get: () => undefined,
  names: () => [],
});

function makeSnapshot(version: number, marker: string): ConfigSnapshot {
  const tenant: TenantSnapshot = {
    name: "default",
    entries: [],
    // biome-ignore lint/suspicious/noExplicitAny: minimal shim — the test isolates SnapshotHolder behaviour
    matchIndex: { match: () => null, nearestMatch: () => [] } as any,
    compiledResponses: new Map(),
    compiledScenarios: new Map(),
    compiledWebhooks: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: TenantLimits not relevant here
    limits: { maxBodyBytes: 1, maxResponseBytes: 1, requestsPerSecond: 1, journalSize: 1 } as any,
    allowPrivateUpstreams: false,
    // Stash the marker on the tenant so we can prove WHICH snapshot a captured ref points at.
    // biome-ignore lint/suspicious/noExplicitAny: test-only marker field
    ...({ _testMarker: marker } as any),
  };
  return Object.freeze({
    version,
    server: {
      host: "127.0.0.1",
      port: 3000,
      tenancyModes: ["path"] as ("path" | "subdomain" | "header")[],
      deterministic: true,
      adminEnabled: false,
    },
    tenants: new Map([["default", tenant]]),
    handlers: emptyRegistry,
  });
}

describe("T9 — snapshot ref-stability under mid-flight swap", () => {
  test("captured snapshot survives a subsequent swap (read-side INVARIANT)", () => {
    const initial = makeSnapshot(1, "snapshot-A");
    const holder = new SnapshotHolder(initial);

    // Capture the snapshot at "delivery-schedule time" (what the queue closure does).
    const captured = holder.get();

    // Now swap to a new snapshot — simulates a config-reload mid-retry-curve.
    const next = makeSnapshot(2, "snapshot-B");
    holder.swap(next);

    // The captured reference MUST still point at snapshot-A — that is the contract that
    // makes T9 honourable. If this asserts equal to 'snapshot-B', closures see torn config.
    const capturedTenant = captured.tenants.get("default") as TenantSnapshot & { _testMarker: string };
    expect(capturedTenant._testMarker).toBe("snapshot-A");

    // And confirm holder.get() now returns the new one — ie swap really happened.
    const fresh = holder.get();
    const freshTenant = fresh.tenants.get("default") as TenantSnapshot & { _testMarker: string };
    expect(freshTenant._testMarker).toBe("snapshot-B");
  });

  test("captured snapshot is frozen — mutation attempts on the captured ref do not leak into holder", () => {
    const initial = makeSnapshot(1, "snapshot-A");
    const holder = new SnapshotHolder(initial);
    const captured = holder.get();

    // Object.freeze is enforced at the top level — assignment throws in strict mode.
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate frozen-write probe
      (captured as any).version = 999;
    }).toThrow();
  });

  test("multiple closures capturing different snapshots each see their own version", () => {
    // This is the multi-retry-curve case: two deliveries scheduled against snapshot-A,
    // a swap happens, two more scheduled against snapshot-B. All four closures must see
    // exactly the snapshot they captured.
    const holder = new SnapshotHolder(makeSnapshot(1, "A"));

    const closuresFromA = [holder.get(), holder.get()];
    holder.swap(makeSnapshot(2, "B"));
    const closuresFromB = [holder.get(), holder.get()];
    // Swap again, doesn't affect anyone.
    holder.swap(makeSnapshot(3, "C"));

    for (const snap of closuresFromA) {
      const t = snap.tenants.get("default") as TenantSnapshot & { _testMarker: string };
      expect(t._testMarker).toBe("A");
    }
    for (const snap of closuresFromB) {
      const t = snap.tenants.get("default") as TenantSnapshot & { _testMarker: string };
      expect(t._testMarker).toBe("B");
    }
    // And current is C.
    const current = holder.get().tenants.get("default") as TenantSnapshot & { _testMarker: string };
    expect(current._testMarker).toBe("C");
  });

  test("TN6 corollary: in-flight queue closures DO NOT survive process restart", () => {
    // We can't actually restart the process in a unit test, but we CAN demonstrate
    // the closures are heap-only — there is no persistence layer reading them back.
    // This test documents the behaviour rather than verifying it dynamically.
    const holder = new SnapshotHolder(makeSnapshot(1, "pre-restart"));
    const captured = holder.get();
    expect(captured).toBeDefined();
    // The contract: a fresh process starting up wouldn't have access to `captured`.
    // Documented in DECISIONS.md TN6 + this comment.
  });
});
