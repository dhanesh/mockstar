// @constraint T10 — handler crash isolation
// @constraint RT-2.1 — try/catch + timeout wrapping
// @constraint RT-2.2 — 500 with safe diagnostic body
// @constraint RT-3.2 — /ready flips to 503 on unhandledRejection

import { describe, it, expect } from "bun:test";
import { invokeWithBoundary, HandlerTimeoutError, installProcessHandlers } from "../src/core/errors/index.ts";
import { createLogger } from "../src/core/observability/index.ts";

const captureLogger = (): { logger: ReturnType<typeof createLogger>; lines: string[] } => {
  const lines: string[] = [];
  const logger = createLogger({
    stdout: (l) => lines.push(l),
    stderr: (l) => lines.push(l),
    deterministic: true,
  });
  return { logger, lines };
};

describe("invokeWithBoundary (tier 1 of TN2)", () => {
  it("returns handler response on success", async () => {
    const { logger } = captureLogger();
    const ctx = { var: { requestId: "r1", tenant: "t1" } } as unknown as Parameters<
      typeof invokeWithBoundary
    >[0];
    const result = await invokeWithBoundary(ctx, "myHandler", () => new Response("ok", { status: 200 }), {
      timeoutMs: 1000,
      logger,
    });
    expect(result.faulted).toBe(false);
    expect(result.response.status).toBe(200);
  });

  it("catches synchronous throw and returns 500 with safe body (no stack in response)", async () => {
    const { logger } = captureLogger();
    const ctx = { var: { requestId: "r1", tenant: "t1" } } as unknown as Parameters<
      typeof invokeWithBoundary
    >[0];
    const result = await invokeWithBoundary(
      ctx,
      "bad",
      () => {
        throw new Error("internal detail: secret=abc");
      },
      { timeoutMs: 1000, logger },
    );
    expect(result.faulted).toBe(true);
    expect(result.response.status).toBe(500);
    const body = (await result.response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "handler_fault", handler: "bad" });
    expect(JSON.stringify(body)).not.toContain("secret=abc"); // no leak
  });

  it("catches awaited promise rejection", async () => {
    const { logger } = captureLogger();
    const ctx = { var: { requestId: "r1", tenant: "t1" } } as unknown as Parameters<
      typeof invokeWithBoundary
    >[0];
    const result = await invokeWithBoundary(
      ctx,
      "badAsync",
      async () => {
        throw new Error("async fail");
      },
      { timeoutMs: 1000, logger },
    );
    expect(result.faulted).toBe(true);
    expect(result.response.status).toBe(500);
  });

  it("times out long-running handlers", async () => {
    const { logger } = captureLogger();
    const ctx = { var: { requestId: "r1", tenant: "t1" } } as unknown as Parameters<
      typeof invokeWithBoundary
    >[0];
    const result = await invokeWithBoundary(
      ctx,
      "slow",
      async () => {
        await new Promise((r) => setTimeout(r, 500));
        return new Response("too late");
      },
      { timeoutMs: 50, logger },
    );
    expect(result.faulted).toBe(true);
    expect(result.faultKind).toBe("timeout");
  });
});

describe("installProcessHandlers (tiers 2-4 of TN2)", () => {
  it("flips /ready to 503 on unhandledRejection and calls exit", async () => {
    const { logger } = captureLogger();
    let readyFlag = true;
    // Sentinel `-1` means exit() was never called. Using `number | null` here
    // would narrow the expect() overload to its `(null) => void` branch.
    let exitedWith = -1;
    const uninstall = installProcessHandlers({
      logger,
      setReady: (v) => {
        readyFlag = v;
      },
      exit: (code) => {
        exitedWith = code;
      },
      drainMs: 5,
    });
    try {
      process.emit("unhandledRejection" as never, new Error("oops"), Promise.resolve() as never);
      await new Promise((r) => setTimeout(r, 20));
      expect(readyFlag).toBe(false);
      expect(exitedWith).toBe(1);
    } finally {
      uninstall();
    }
  });
});

describe("HandlerTimeoutError", () => {
  it("exposes the budget that was exceeded", () => {
    const err = new HandlerTimeoutError(500);
    expect(err.ms).toBe(500);
    expect(err.message).toContain("500ms");
  });
});
