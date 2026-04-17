// Satisfies: RT-3 (dual-mode ID generator), T4 (deterministic + authentic), T6 (0 collisions in burst),
//            T9 (nanoid-compatible primitive), T10 (per-request PRNG scoping), O6 (0 collisions over 1M at L=14)
// Priority: binding — feeds the walker's `{{id(prefix, length)}}` placeholder
//
// Design:
//   - Non-deterministic mode: nanoid-style pool draw backed by `crypto.getRandomValues`.
//   - Deterministic mode: same algorithm, but random bytes are drawn from a seeded Mulberry32 PRNG.
//     Seed = FNV-1a(tenant | endpoint | requestCounter).
//   - Per-request isolation (TN8): `createIdHelpers(seed)` is called fresh for every request,
//     so PRNG state never leaks across concurrent requests even in deterministic mode.

export const BASE62 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export interface IdSeed {
  deterministic: boolean;
  tenant: string;
  endpoint: string;
  requestCounter: number;
}

export interface IdHelpers {
  /** Generate an opaque ID of `length` characters prefixed with `prefix` from `alphabet` (default base62). */
  id(prefix: string, length: number, alphabet?: string): string;
}

export function createIdHelpers(seed: IdSeed): IdHelpers {
  const rand = seed.deterministic
    ? mulberry32(fnv1a(`${seed.tenant}|${seed.endpoint}|${seed.requestCounter}`))
    : cryptoRand;
  return {
    id(prefix: string, length: number, alphabet: string = BASE62): string {
      if (length <= 0) throw new Error(`id(): length must be positive, got ${length}`);
      if (alphabet.length < 2) throw new Error(`id(): alphabet too small (${alphabet.length})`);
      return `${prefix}${draw(alphabet, length, rand)}`;
    },
  };
}

// --- internals ---------------------------------------------------------------

type RandBytes = (size: number) => Uint8Array;

function cryptoRand(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

/**
 * nanoid-compatible unbiased draw. Uses rejection sampling against a power-of-two mask
 * so every alphabet index has exactly equal probability (no modulo bias).
 */
function draw(alphabet: string, size: number, rand: RandBytes): string {
  const aLen = alphabet.length;
  const mask = (2 << (31 - Math.clz32((aLen - 1) | 1))) - 1;
  const step = Math.ceil((1.6 * mask * size) / aLen);
  let out = '';
  while (out.length < size) {
    const bytes = rand(step);
    for (let i = 0; i < step; i++) {
      const byte = bytes[i];
      if (byte === undefined) continue;
      const idx = byte & mask;
      const ch = alphabet[idx];
      if (ch !== undefined) {
        out += ch;
        if (out.length === size) return out;
      }
    }
  }
  return out;
}

/** 32-bit FNV-1a hash. Produces a 32-bit unsigned seed from a string. */
export function fnv1a(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Mulberry32 PRNG — 32-bit state, chosen for being small, fast, and well-tested in JS contexts. */
export function mulberry32(seed: number): RandBytes {
  let s = seed >>> 0;
  return (size: number): Uint8Array => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      out[i] = (t ^ (t >>> 14)) & 0xff;
    }
    return out;
  };
}
