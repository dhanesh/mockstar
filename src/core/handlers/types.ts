// Satisfies: T5, T6, RT-1
// Types shared by the handler registry and its callers.

import type { Context } from "hono";

/**
 * A named dynamic-mock handler. Receives the Hono context plus a
 * per-request helper bundle. Must await any async work it spawns —
 * fire-and-forget rejections escape to the process-level hook (RT-3).
 */
export type MockHandler = (ctx: Context, helpers: HandlerHelpers) => Response | Promise<Response>;

export interface HandlerHelpers {
  readonly tenant: string;
  readonly requestId: string;
  readonly faker: FakerBundle;
}

export interface FakerBundle {
  uuid(): string;
  email(): string;
  name(): string;
  integer(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

export interface HandlerRegistry {
  readonly size: number;
  has(name: string): boolean;
  get(name: string): MockHandler | undefined;
  /** All handler names, sorted — used by diagnostics on missing-reference boot failures. */
  names(): readonly string[];
}

export class HandlerLoadError extends Error {
  constructor(
    public readonly file: string,
    // `cause` is declared on the base Error class (ES2022) — explicit override quiets TS4115.
    public override readonly cause: unknown,
  ) {
    super(
      `Failed to load handler module '${file}': ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "HandlerLoadError";
  }
}

export class MissingHandlerError extends Error {
  constructor(
    public readonly missing: readonly { name: string; configPath: string }[],
    available: readonly string[],
  ) {
    const lines = missing.map((m) => `  - '${m.name}' referenced by ${m.configPath}`);
    super(
      `Config references ${missing.length} handler(s) not found in the handlers/ directory:\n${lines.join("\n")}\n\nAvailable handlers: ${available.length === 0 ? "(none)" : available.join(", ")}`,
    );
    this.name = "MissingHandlerError";
  }
}
