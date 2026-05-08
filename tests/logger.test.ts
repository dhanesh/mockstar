// @constraint O1 — structured JSON logs per request
// @constraint G15 — logger format test coverage
// @constraint RT-12.4 — deterministic timestamp in deterministic mode

import { describe, it, expect } from "bun:test";
import { createLogger } from "../src/core/observability/logger.ts";

function capture(): { logger: ReturnType<typeof createLogger>; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logger = createLogger({
    deterministic: true,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { logger, stdout, stderr };
}

describe("structured JSON logger (O1)", () => {
  it("emits a valid JSON object per call on stdout for info/warn", () => {
    const { logger, stdout } = capture();
    logger.info({ event: "request", tenant: "acme", path: "/x", status: 200 });
    logger.warn({ event: "config_reload_rejected", tenant: "acme", details: "bad json" });
    expect(stdout).toHaveLength(2);
    for (const line of stdout) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed.ts).toBe("number");
      expect(typeof parsed.event).toBe("string");
      expect(typeof parsed.level).toBe("string");
    }
  });

  it("routes error-level events to stderr (O1, RT-3.2)", () => {
    const { logger, stdout, stderr } = capture();
    logger.error({ event: "process_fault", kind: "unhandledRejection", message: "oops" });
    expect(stderr).toHaveLength(1);
    expect(stdout).toHaveLength(0);
    const parsed = JSON.parse(stderr[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.level).toBe("error");
    expect(parsed.kind).toBe("unhandledRejection");
  });

  it("serializes Error objects with name + message + stack", () => {
    const { logger, stderr } = capture();
    logger.error({ event: "boom", err: new Error("kaboom") });
    const parsed = JSON.parse(stderr[0] ?? "{}") as { err: { name: string; message: string; stack: string } };
    expect(parsed.err.name).toBe("Error");
    expect(parsed.err.message).toBe("kaboom");
    expect(parsed.err.stack).toMatch(/kaboom/);
  });

  it("uses monotonic counter for timestamps in deterministic mode (RT-12.4)", () => {
    const { logger, stdout } = capture();
    logger.info({ event: "a" });
    logger.info({ event: "b" });
    logger.info({ event: "c" });
    const tsValues = stdout.map((l) => (JSON.parse(l) as { ts: number }).ts);
    expect(tsValues).toEqual([1, 2, 3]);
  });
});
