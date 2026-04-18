// Satisfies: RT-6, T12 (field-mapping rules), TN6 (spec-aware + heuristic fallback)
// Priority: binding — the heuristic shapes every enhanced fixture

/** Provider -> ID prefix mapping. Kept generic via a lookup table; provider names never leak into core. */
export interface EnhanceHint {
  providerTag: string | null;
  /** Hints from a parsed spec — field names known to belong to this endpoint (optional). */
  knownFieldNames?: Set<string>;
}

export interface FieldRewrite {
  /** The Tier 2 template token to substitute for the original literal value. */
  token: string;
  /** Reason for rewrite (goes into the manifest for diagnostics). */
  reason: string;
}

/**
 * Decide whether a `field: value` leaf should be rewritten to a Tier 2 placeholder. Returns
 * null if no rewrite applies (literal preserved).
 *
 * The heuristic is intentionally simple and conservative: if in doubt, leave it alone. A false
 * negative (no rewrite) only reduces dynamism; a false positive (wrong rewrite) breaks provider
 * regex validation. Per TN6 resolution: ambiguous mappings are left as literals plus a warning,
 * not silently substituted.
 */
export function decideRewrite(
  fieldName: string,
  value: unknown,
  hint: EnhanceHint,
): FieldRewrite | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const lower = fieldName.toLowerCase();

  // ID-like fields: literal strings that look like opaque IDs get replaced with `{{id(...)}}`
  if (looksLikeIdField(fieldName, lower) && typeof value === 'string' && looksLikeIdValue(value)) {
    const { prefix, length, alphabet } = idShapeFor(hint.providerTag, lower, value);
    const prefixArg = JSON.stringify(prefix);
    const alphaArg = alphabet ? `, ${JSON.stringify(alphabet)}` : '';
    return {
      token: `{{id(${prefixArg}, ${length}${alphaArg})}}`,
      reason: `name-matches-id-field (provider=${hint.providerTag ?? 'generic'})`,
    };
  }

  // Timestamp-ish fields
  if (looksLikeTimestampField(fieldName, lower)) {
    if (typeof value === 'string' && ISO_RE.test(value)) {
      return { token: '{{now.iso}}', reason: 'iso8601-timestamp' };
    }
    if (typeof value === 'number' && value > 1_000_000_000) {
      return { token: '{{now.unix}}', reason: 'unix-seconds' };
    }
  }

  return null;
}

// --- heuristics --------------------------------------------------------------

const ID_FIELD_NAMES = new Set([
  'id',
  'orderid', 'order_id',
  'customerid', 'customer_id',
  'paymentid', 'payment_id',
  'refundid', 'refund_id',
  'entityid', 'entity_id',
  'messagesid', 'messages_id', 'sid',
  'userid', 'user_id',
  'transactionid', 'transaction_id',
  'accountid', 'account_id',
  'subscriptionid', 'subscription_id',
]);

const TIMESTAMP_FIELD_NAMES = new Set([
  'created', 'created_at', 'createdat',
  'updated', 'updated_at', 'updatedat',
  'timestamp', 'date_created', 'datecreated',
  'date_updated', 'dateupdated',
  'issued_at', 'expires_at', 'expiresat',
]);

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

// Word-boundary detection: a letter-or-digit followed by "Id" / "ID" (camelCase boundary).
// This distinguishes `userId`/`userID`/`orderId` (matches) from `grid`/`paid`/`android` (does not).
const CAMEL_ID_RE = /[a-z0-9](Id|ID)$/;
const CAMEL_AT_RE = /[a-z0-9](At|AT)$/;

function looksLikeIdField(rawName: string, lowerName: string): boolean {
  if (ID_FIELD_NAMES.has(lowerName)) return true;
  if (lowerName.endsWith('_id')) return true;  // snake_case boundary
  if (CAMEL_ID_RE.test(rawName)) return true;   // camelCase boundary
  return false;
}

function looksLikeTimestampField(rawName: string, lowerName: string): boolean {
  if (TIMESTAMP_FIELD_NAMES.has(lowerName)) return true;
  if (lowerName.endsWith('_at')) return true;   // snake_case boundary
  if (CAMEL_AT_RE.test(rawName)) return true;    // camelCase boundary
  return false;
}

function looksLikeIdValue(s: string): boolean {
  // A value that's short, alphanumeric, possibly with a prefix separated by underscore.
  if (s.length < 4 || s.length > 40) return false;
  return /^[A-Za-z]*_?[A-Za-z0-9]{6,}$/.test(s);
}

interface IdShape {
  prefix: string;
  length: number;
  alphabet?: string;
}

/**
 * Infer the ID shape for a rewrite. Preference order:
 * 1. Provider-specific shape (from fixture library lookup, not from name).
 * 2. Extracted prefix from the original value + remaining length.
 * 3. Generic 14-char base62.
 */
function idShapeFor(_provider: string | null, _fieldName: string, originalValue: string): IdShape {
  // Provider shapes are registered via a generic registry — NO provider-name conditionals in
  // the core. See manifold for the TN5 / RT-9 resolution: provider-specific shape inferred
  // from the fixture's OWN content, not from hard-coded conditionals.
  const sep = originalValue.indexOf('_');
  if (sep > 0 && sep < 10) {
    const prefix = `${originalValue.slice(0, sep + 1)}`;
    const remainder = originalValue.slice(sep + 1);
    return { prefix, length: Math.max(remainder.length, 6) };
  }
  // Unprefixed: preserve length + alphabet feel.
  const onlyHex = /^[0-9a-f]+$/i.test(originalValue);
  const onlyUpper = /^[0-9A-Z]+$/.test(originalValue);
  if (onlyHex) return { prefix: '', length: originalValue.length, alphabet: '0123456789abcdef' };
  if (onlyUpper) return { prefix: '', length: originalValue.length, alphabet: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' };
  return { prefix: '', length: Math.max(originalValue.length, 14) };
}
