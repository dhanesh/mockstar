// @constraint RT-7 — Install is append-only-journaled and LIFO-reversible
// @constraint U1, U2, O6

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStep,
  readJournal,
  reverseSteps,
  clearJournal,
  journalFacts,
  atomicInstall,
  type Mutation,
} from "../src/features/proxy/install-journal.ts";
import type { ReverseCommand } from "../src/features/proxy/types.ts";

async function tempJournal(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mockstar-journal-"));
  return join(dir, "install-state.json");
}

describe("install journal (RT-7)", () => {
  it("appends steps with increasing step numbers and checksums", async () => {
    const path = await tempJournal();
    const s1 = await appendStep(path, {
      action: "first mutation",
      reverseCommand: { kind: "noop", reason: "test" } as ReverseCommand,
    });
    const s2 = await appendStep(path, {
      action: "second mutation",
      reverseCommand: { kind: "noop", reason: "test" } as ReverseCommand,
    });
    expect(s1.step).toBe(1);
    expect(s2.step).toBe(2);
    expect(s1.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(s2.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("readJournal returns steps in chronological order", async () => {
    const path = await tempJournal();
    await appendStep(path, { action: "a", reverseCommand: { kind: "noop", reason: "" } });
    await appendStep(path, { action: "b", reverseCommand: { kind: "noop", reason: "" } });
    await appendStep(path, { action: "c", reverseCommand: { kind: "noop", reason: "" } });
    const steps = await readJournal(path);
    expect(steps.map((s) => s.action)).toEqual(["a", "b", "c"]);
  });

  it("reverseSteps yields LIFO", async () => {
    const path = await tempJournal();
    await appendStep(path, { action: "a", reverseCommand: { kind: "noop", reason: "" } });
    await appendStep(path, { action: "b", reverseCommand: { kind: "noop", reason: "" } });
    await appendStep(path, { action: "c", reverseCommand: { kind: "noop", reason: "" } });
    const order: string[] = [];
    for await (const s of reverseSteps(path)) order.push(s.action);
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("detects checksum corruption", async () => {
    const path = await tempJournal();
    await appendStep(path, { action: "a", reverseCommand: { kind: "noop", reason: "" } });
    const raw = await readFile(path, "utf8");
    const tampered = raw.replace('"a"', '"a-tampered"');
    await Bun.write(path, tampered);
    await expect(readJournal(path)).rejects.toThrow(/checksum mismatch/);
  });

  it("journalFacts reports corruption non-throwing", async () => {
    const path = await tempJournal();
    await appendStep(path, { action: "a", reverseCommand: { kind: "noop", reason: "" } });
    const raw = await readFile(path, "utf8");
    await Bun.write(path, raw.replace('"a"', '"X"'));
    const facts = await journalFacts(path);
    expect(facts.corrupt).toBe(true);
  });

  it("clearJournal removes the file", async () => {
    const path = await tempJournal();
    await appendStep(path, { action: "a", reverseCommand: { kind: "noop", reason: "" } });
    await clearJournal(path);
    const facts = await journalFacts(path);
    expect(facts.exists).toBe(false);
  });

  it("atomicInstall commits on success", async () => {
    const path = await tempJournal();
    const applied: string[] = [];
    const muts: Mutation[] = [
      {
        action: "A",
        reverseCommand: { kind: "noop", reason: "" },
        apply: async () => {
          applied.push("A");
        },
      },
      {
        action: "B",
        reverseCommand: { kind: "noop", reason: "" },
        apply: async () => {
          applied.push("B");
        },
      },
    ];
    await atomicInstall(path, muts);
    expect(applied).toEqual(["A", "B"]);
    const steps = await readJournal(path);
    expect(steps.map((s) => s.action)).toEqual(["A", "B"]);
  });

  it("atomicInstall rolls back on partial failure", async () => {
    const path = await tempJournal();
    const applied: string[] = [];
    const muts: Mutation[] = [
      {
        action: "A",
        reverseCommand: { kind: "noop", reason: "" },
        apply: async () => {
          applied.push("A");
        },
      },
      {
        action: "B-will-fail",
        reverseCommand: { kind: "noop", reason: "" },
        apply: async () => {
          applied.push("B");
          throw new Error("B failed");
        },
      },
    ];
    await expect(atomicInstall(path, muts)).rejects.toThrow(/B failed/);
    // Journal file should be cleared (rollback completed).
    const facts = await journalFacts(path);
    expect(facts.exists).toBe(false);
  });
});
