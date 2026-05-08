// Satisfies: RT-6, TN7 resolution (`_mockstarGenerated` as the stable boundary between enhancer-owned
//            and user-owned fields — see manifold for full reasoning).
// Priority: binding — idempotency hinges on this boundary

export const GENERATED_KEY = "_mockstarGenerated";
export const GENERATED_VERSION = 1;

/** Rewrite recorded per-mock entry. */
export interface GeneratedEntry {
  /** Mock entry id (from `mocks[].id`). */
  entry: string;
  /** JSON-pointer-ish dot path into the response body where a substitution was made. */
  path: string;
  /** The Tier 2 template token that was injected (e.g. `{{id("order_", 14)}}`). */
  token: string;
  /** The original literal value, preserved so re-enhance can detect drift vs. user edits. */
  original: unknown;
}

export interface GeneratedManifest {
  version: typeof GENERATED_VERSION;
  enhancedAt: string;
  entries: GeneratedEntry[];
  providerTag: string | null;
}

/** Extract the generated manifest from a raw mock-file object, if present. */
export function readManifest(raw: Record<string, unknown>): GeneratedManifest | null {
  const v = raw[GENERATED_KEY];
  if (typeof v !== "object" || v === null) return null;
  const m = v as Partial<GeneratedManifest>;
  if (m.version !== GENERATED_VERSION) return null;
  if (!Array.isArray(m.entries)) return null;
  return {
    version: GENERATED_VERSION,
    enhancedAt: typeof m.enhancedAt === "string" ? m.enhancedAt : new Date(0).toISOString(),
    entries: m.entries as GeneratedEntry[],
    providerTag: typeof m.providerTag === "string" ? m.providerTag : null,
  };
}

/** Write a fresh manifest into the mock-file object, replacing any prior generated block. */
export function writeManifest(raw: Record<string, unknown>, manifest: GeneratedManifest): void {
  raw[GENERATED_KEY] = manifest;
}

/** Remove the generated manifest entirely (for reset-before-re-enhance). */
export function clearManifest(raw: Record<string, unknown>): void {
  delete raw[GENERATED_KEY];
}
