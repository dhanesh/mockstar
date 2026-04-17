// Satisfies: RT-1.2 (type-preserving numbers for unix/millis), U4 (helper generators),
//            T4 (deterministic mode: clock is injectable so byte-identity holds across runs)
// Priority: binding — feeds the walker's `{{now.unix}}`, `{{now.millis}}`, `{{now.iso}}` placeholders.

export interface Clock {
  /** Unix seconds (integer). */
  unix(): number;
  /** Unix milliseconds (integer). */
  millis(): number;
  /** RFC 3339 / ISO-8601 timestamp string. */
  iso(): string;
}

export interface ClockOptions {
  deterministic: boolean;
  /** When deterministic, the fixed epoch used for every call. Default: 2026-01-01T00:00:00Z. */
  fixedEpochMs?: number;
}

const DEFAULT_FIXED_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export function createClock(opts: ClockOptions): Clock {
  if (opts.deterministic) {
    const ms = opts.fixedEpochMs ?? DEFAULT_FIXED_EPOCH_MS;
    const iso = new Date(ms).toISOString();
    const unix = Math.floor(ms / 1000);
    return {
      unix: () => unix,
      millis: () => ms,
      iso: () => iso,
    };
  }
  return {
    unix: () => Math.floor(Date.now() / 1000),
    millis: () => Date.now(),
    iso: () => new Date().toISOString(),
  };
}
