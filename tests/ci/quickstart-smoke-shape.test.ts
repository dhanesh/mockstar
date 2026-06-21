// Satisfies: RT-13 (quickstart-smoke workflow exists + enforces 5-min SLO per persona)

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const WORKFLOW = resolve(import.meta.dir, "..", "..", ".github", "workflows", "quickstart-smoke.yml");

async function workflowText(): Promise<string> {
  return Bun.file(WORKFLOW).text();
}

describe("RT-13: quickstart-smoke workflow shape", () => {
  it("all three persona jobs exist", async () => {
    const text = await workflowText();
    expect(text).toMatch(/dev-persona:/);
    expect(text).toMatch(/sdet-persona:/);
    expect(text).toMatch(/devops-persona:/);
  });

  it("every persona job carries timeout-minutes: 5 (the 5-min SLO IS the test)", async () => {
    const text = await workflowText();
    const timeoutLines = text.split("\n").filter((l) => l.includes("timeout-minutes:"));
    expect(timeoutLines.length).toBeGreaterThanOrEqual(3);
    for (const line of timeoutLines) {
      expect(line).toMatch(/timeout-minutes:\s*5\b/);
    }
  });

  it("Dev job actually exercises `mockstar init` + `mockstar ./mocks` + curl", async () => {
    const text = await workflowText();
    expect(text).toMatch(/bunx @dhanesh\/mockstar init/);
    expect(text).toMatch(/bunx @dhanesh\/mockstar \.\/mocks/);
    expect(text).toMatch(/curl .*?\/hello/);
  });

  it("DevOps job actually exercises docker run + /health", async () => {
    const text = await workflowText();
    expect(text).toMatch(/docker run/);
    expect(text).toMatch(/\/health/);
  });
});
