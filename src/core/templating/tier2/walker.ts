// Satisfies: RT-1 (type-aware JSON walker — binding constraint),
//            RT-1.3 (cycle + max-depth), RT-1.4 (deterministic key ordering),
//            RT-1.5 (incremental size bound), S4 (bounded response size), T14 (depth/cycle safeguard)
// Priority: binding — every Tier 2 response body flows through the budget.
//
// Contract:
//   - `RenderBudget` is created fresh per request (ctor: maxBytes, maxDepth).
//   - The walker (in compiler.ts#renderCompiledJson) increments `bytes` for each leaf/structure,
//     calls `enterDepth()` on recursion and `exitDepth()` on unwind.
//   - Any violation throws a typed Tier2RenderError so the HTTP boundary returns 413/500 consistently
//     instead of a runtime RangeError/stack overflow.
//   - Cycle detection is second-line defence: the response tree is acyclic by construction (JSON config),
//     but request-body values substituted via `{{request.body.x}}` can in theory reference objects
//     the walker has already visited in the SAME render pass. The cycle set tracks by identity.

export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000; // 1 MB — inherits S4 / mockstar core body cap.
export const DEFAULT_MAX_DEPTH = 64; // T14 — depth cap independent of cycles.

export type Tier2ErrorCode = "PAYLOAD_TOO_LARGE" | "MAX_DEPTH_EXCEEDED" | "CYCLE_DETECTED";

export class Tier2RenderError extends Error {
  readonly code: Tier2ErrorCode;
  readonly httpStatus: number;
  constructor(code: Tier2ErrorCode, message: string) {
    super(message);
    this.name = "Tier2RenderError";
    this.code = code;
    this.httpStatus = code === "PAYLOAD_TOO_LARGE" ? 413 : 500;
  }
}

export interface RenderBudgetOptions {
  maxBytes?: number;
  maxDepth?: number;
}

/**
 * Mutable per-request state. Single instance threaded through the walker; we avoid closure/allocation
 * overhead on the hot path by mutating in place.
 */
export class RenderBudget {
  readonly maxBytes: number;
  readonly maxDepth: number;
  bytes: number = 0;
  depth: number = 0;
  /** Visit set for cycle detection. Keyed by object identity (objects/arrays only). */
  private readonly seen: WeakSet<object> = new WeakSet();

  constructor(opts: RenderBudgetOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /** Add `delta` bytes; throw 413 if this would exceed the cap. Check happens BEFORE the write. */
  consume(delta: number): void {
    this.bytes += delta;
    if (this.bytes > this.maxBytes) {
      throw new Tier2RenderError(
        "PAYLOAD_TOO_LARGE",
        `Response body would exceed ${this.maxBytes} bytes (walker saw ${this.bytes}).`,
      );
    }
  }

  enterDepth(): void {
    this.depth++;
    if (this.depth > this.maxDepth) {
      throw new Tier2RenderError("MAX_DEPTH_EXCEEDED", `Response tree exceeded max depth ${this.maxDepth}.`);
    }
  }

  exitDepth(): void {
    this.depth--;
  }

  /** Register a visited object for cycle detection. Returns true if already seen (cycle). */
  markSeen(obj: object): boolean {
    if (this.seen.has(obj)) return true;
    this.seen.add(obj);
    return false;
  }

  /** Remove from visit set on unwind (objects can legitimately appear twice in siblings, not ancestry). */
  forget(obj: object): void {
    this.seen.delete(obj);
  }
}

/**
 * Estimate the on-wire size of a fully-rendered JSON value. Used for leaves produced by
 * `{{request.body.x}}` substitutions that materialise foreign (non-template) values — we need
 * to know their size BEFORE JSON.stringify allocates the whole response string.
 *
 * Tight enough for the budget check; does NOT have to match JSON.stringify byte-for-byte
 * (it's intentionally a lower bound with small overhead).
 */
export function estimateJsonSize(value: unknown, budget: RenderBudget): number {
  if (value === null || value === undefined) return 4; // "null"
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "string") return value.length + 2; // quotes
  if (Array.isArray(value)) {
    if (budget.markSeen(value)) {
      throw new Tier2RenderError("CYCLE_DETECTED", "Cycle detected in substituted request-body value.");
    }
    budget.enterDepth();
    let total = 2; // []
    for (let i = 0; i < value.length; i++) {
      total += estimateJsonSize(value[i], budget);
      if (i < value.length - 1) total += 1; // comma
    }
    budget.exitDepth();
    budget.forget(value);
    return total;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (budget.markSeen(obj)) {
      throw new Tier2RenderError("CYCLE_DETECTED", "Cycle detected in substituted request-body value.");
    }
    budget.enterDepth();
    let total = 2; // {}
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      total += k.length + 3; // "k":
      total += estimateJsonSize(obj[k], budget);
      if (i < keys.length - 1) total += 1; // comma
    }
    budget.exitDepth();
    budget.forget(obj);
    return total;
  }
  return String(value).length + 2;
}
