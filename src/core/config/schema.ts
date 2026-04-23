// Satisfies: T7 (Zod-validated config with fail-fast boot and tolerant hot-reload)
// Satisfies: RT-5.1 (snapshot builder reads config + runs Zod validation)
// Contributes to: RT-7 (two-tier admin auth schema)
// Satisfies: RT-3 (scenario types — binding constraint for scenario-routing)

import { z } from 'zod';

// -- Request matching predicates --

export const MatchMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*']);

const StringMatch = z.union([
  z.string(),
  z.object({ equals: z.string() }).strict(),
  z.object({ regex: z.string() }).strict(),
  z.object({ startsWith: z.string() }).strict(),
  z.object({ contains: z.string() }).strict(),
]);

// Detects nested quantifier patterns that cause catastrophic backtracking (S1/TN3 resolution).
// Rejects: (a+)+, (a{1,3})+, (a|b)+ etc. Accepts bounded patterns like /^[A-Z]{2,4}$/.
function isUnsafeRegex(pattern: string): boolean {
  return /\([^)]*[*+{][^)]*\)[*+{]/.test(pattern) ||
         /\([^)]*\|[^)]*\)[*+{]/.test(pattern);
}

// StringMatch with a ReDoS guard on the regex variant (S1/TN3). Same inferred TS type.
const StringMatchWithRegexGuard = z.union([
  z.string(),
  z.object({ equals: z.string() }).strict(),
  z.object({ regex: z.string() }).strict().refine(
    (v) => !isUnsafeRegex(v.regex),
    (v) => ({ message: `scenario regex '${v.regex}' may cause catastrophic backtracking — use exact/startsWith/contains instead` }),
  ),
  z.object({ startsWith: z.string() }).strict(),
  z.object({ contains: z.string() }).strict(),
]);

const BodyMatch = z.object({
  jsonpath: z.string().optional(),
  equals: z.unknown().optional(),
  partial: z.record(z.unknown()).optional(),
}).strict();

export const MatchPredicate = z.object({
  method: MatchMethod.default('*'),
  path: z.string().min(1), // hono-style: /users/:id
  query: z.record(StringMatch).optional(),
  headers: z.record(StringMatch).optional(),
  body: BodyMatch.optional(),
  priority: z.number().int().default(0),
}).strict();

// -- Response descriptors --

const DelaySpec = z.union([
  z.number().int().nonnegative(),
  z.object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() }).strict(),
]);

export const StaticResponse = z.object({
  kind: z.literal('static'),
  status: z.number().int().min(100).max(599).default(200),
  headers: z.record(z.string()).optional(),
  // String body may contain {{ }} templating; object/array body is JSON-serialised.
  body: z.unknown().optional(),
  delay: DelaySpec.optional(),
}).strict();

export const DynamicResponse = z.object({
  kind: z.literal('dynamic'),
  handler: z.string().min(1),
  delay: DelaySpec.optional(),
}).strict();

export const PassThroughResponse = z.object({
  kind: z.literal('passthrough'),
  upstream: z.string().url(), // further validated against URL validator (RT-8)
  timeoutMs: z.number().int().positive().default(30_000),
  forwardHeaders: z.boolean().default(true),
}).strict();

export const MockResponse = z.discriminatedUnion('kind', [StaticResponse, DynamicResponse, PassThroughResponse]);

// -- Scenario routing (RT-3: binding constraint) --

// Predicate for one scenario rule: matches against request attribute dimensions (T3, T6).
// At least one dimension must be specified. Body keys are dot-path strings.
export const ScenarioPredicate = z.object({
  params: z.record(StringMatchWithRegexGuard).optional(),
  query: z.record(StringMatchWithRegexGuard).optional(),
  headers: z.record(StringMatchWithRegexGuard).optional(),
  body: z.record(StringMatchWithRegexGuard).optional(),
}).strict().refine(
  (v) => v.params !== undefined || v.query !== undefined || v.headers !== undefined || v.body !== undefined,
  { message: 'scenario predicate must specify at least one of: params, query, headers, body' },
);

// Override response for a matched scenario. Absent fields inherit from the default (U2).
// Dynamic/passthrough entries must declare all of status, headers, body — see MockEntry.superRefine.
export const ScenarioResponse = z.object({
  status: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  delay: DelaySpec.optional(),
}).strict().refine(
  (v) => v.status !== undefined || v.headers !== undefined || v.body !== undefined,
  { message: 'scenario response must specify at least one of: status, headers, body' },
);

// A single named scenario rule — id, predicate, and override response.
export const ScenarioRule = z.object({
  id: z.string().min(1),
  when: ScenarioPredicate,
  response: ScenarioResponse,
}).strict();

// -- Full mock entry --

export const MockEntry = z.object({
  id: z.string().min(1),
  match: MatchPredicate,
  response: MockResponse,
  // Up to 50 scenario rules per entry (T4). Ceiling error names the limit and suggests split-entry pattern.
  scenarios: z.array(ScenarioRule).max(
    50,
    'scenario ceiling is 50 rules per entry — split into multiple entries with different priority values to cover more cases',
  ).optional(),
}).strict().superRefine((entry, ctx) => {
  // TN1 resolution: dynamic/passthrough scenario responses must be self-contained because there is
  // no computed default to inherit unspecified fields from at scenario evaluation time.
  const kind = entry.response.kind;
  if (kind === 'static' || !entry.scenarios) return;
  for (let idx = 0; idx < entry.scenarios.length; idx++) {
    const rule = entry.scenarios[idx];
    if (!rule) continue;
    const resp = rule.response;
    if (resp.status === undefined || resp.headers === undefined || resp.body === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `mock '${entry.id}' scenario[${idx}] ('${rule.id}'): ${kind} entries require scenario responses to declare all of: status, headers, body`,
        path: ['scenarios', idx, 'response'],
      });
    }
  }
});

export const MocksFile = z.object({
  mocks: z.array(MockEntry).min(1),
}).strict();

// -- Per-tenant config --

export const TenantLimits = z.object({
  maxBodyBytes: z.number().int().positive().default(1_048_576),      // S5: inbound request cap, 1 MB default
  maxResponseBytes: z.number().int().positive().default(1_048_576),  // S4: outbound response cap (Tier 2 render), 1 MB default
  requestsPerSecond: z.number().int().positive().default(1000),      // S5: 1000 rps default
  journalSize: z.number().int().positive().default(1000),             // O3: 1000 entries default
}).strict();

export const TenantConfig = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/).min(1).max(64),
  adminToken: z.string().min(16).optional(), // RT-7.1 per-tenant token
  limits: TenantLimits.default({}),
  allowPrivateUpstreams: z.boolean().default(false), // RT-8.1
  mocks: z.array(MockEntry).min(0),
}).strict();

// -- Top-level server config --

export const TenancyMode = z.enum(['path', 'subdomain', 'header']);

export const ServerConfig = z.object({
  host: z.string().default('127.0.0.1'), // S4: localhost bind default
  port: z.number().int().min(1).max(65535).default(3000),
  tenancyModes: z.array(TenancyMode).min(1).default(['path', 'header']),
  deterministic: z.boolean().default(false), // RT-12
  rootToken: z.string().min(16).optional(), // RT-7.2
  // When unset, admin endpoints are disabled (S3).
  adminEnabled: z.boolean().default(false),
}).strict();

export type Mocks = z.infer<typeof MocksFile>;
export type Tenant = z.infer<typeof TenantConfig>;
export type Server = z.infer<typeof ServerConfig>;
export type Entry = z.infer<typeof MockEntry>;
export type Predicate = z.infer<typeof MatchPredicate>;
export type Response_ = z.infer<typeof MockResponse>;
export type TenancyModeT = z.infer<typeof TenancyMode>;
export type ScenarioRuleT = z.infer<typeof ScenarioRule>;
export type ScenarioPredicateT = z.infer<typeof ScenarioPredicate>;
export type ScenarioResponseT = z.infer<typeof ScenarioResponse>;
