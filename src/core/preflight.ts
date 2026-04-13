// Satisfies: O6 (Bun version policy runtime check)
// Minimum Bun version must have reliable unhandledRejection/uncaughtException hooks (TN2 tier 2/3).

export const MIN_BUN_VERSION = '1.1.8';

export interface PreflightResult {
  ok: boolean;
  detected: string | null;
  min: string;
  warning?: string;
}

/** Compare two SemVer-ish strings (major.minor.patch, ignoring pre-release). */
export function compareVersion(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a1 = 0, a2 = 0, a3 = 0] = parse(a);
  const [b1 = 0, b2 = 0, b3 = 0] = parse(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

function detectBunVersion(): string | null {
  return (globalThis as { Bun?: { version: string } }).Bun?.version ?? null;
}

/**
 * Check at startup that the Bun runtime meets the minimum supported version.
 * Returns a result (does NOT exit) so callers control the response — library
 * users may want to warn-and-continue; CLI users probably want to fail-hard.
 *
 * Pass `null` to simulate "not running on Bun" (used by tests + library embed).
 */
export function preflight(bunVersion: string | null | undefined = detectBunVersion()): PreflightResult {
  if (!bunVersion) {
    return {
      ok: true,
      detected: null,
      min: MIN_BUN_VERSION,
      warning: 'Runtime is not Bun (library embed in Node.js). Process-level crash hooks (RT-3) will not fire the same way — operators must provide orchestrator-level restart policy.',
    };
  }
  const ok = compareVersion(bunVersion, MIN_BUN_VERSION) >= 0;
  return {
    ok,
    detected: bunVersion,
    min: MIN_BUN_VERSION,
    warning: ok
      ? undefined
      : `Bun ${bunVersion} is below the minimum supported ${MIN_BUN_VERSION}. unhandledRejection / uncaughtException hooks may not fire correctly. Upgrade to Bun ${MIN_BUN_VERSION} or later.`,
  };
}
