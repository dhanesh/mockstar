// Satisfies: U4 (faker-style generators), RT-12.2 (deterministic mode: seeded faker)
// G3 fix: use `new Faker({ locale: [en] })` per call so two createFaker invocations with
// the same seed produce byte-identical outputs. Previously we reseeded the global
// `faker` singleton, so the advancing state was shared across closures.
//
// Seeded output is stable only within one @faker-js/faker major (upstream does not promise
// cross-version stability). tests/faker-golden.test.ts pins the seed-0 sequence so a faker
// bump that changes deterministic fixtures fails CI instead of shipping silently (#50).

import { Faker, en } from "@faker-js/faker";
import { fnv1a } from "./tier2/id.ts";
import { DEFAULT_FIXED_EPOCH_MS } from "./tier2/now.ts";

export interface FakerInstance {
  uuid(): string;
  email(): string;
  name(): string;
  integer(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  boolean(): boolean;
  dateIso(): string;
}

/**
 * The only method names a `{{faker.<name>}}` template may call. The compiler checks against
 * this set so a template cannot reach Object.prototype members (`faker.constructor`,
 * `faker.hasOwnProperty`, ...) and so typos render literally instead of throwing per request.
 */
// A Record over keyof FakerInstance makes a missing entry a type error: adding a method to
// FakerInstance without allowlisting it fails `tsc`, not just a hand-maintained test list.
const FAKER_METHOD_FLAGS: Record<keyof FakerInstance, true> = {
  uuid: true,
  email: true,
  name: true,
  integer: true,
  pick: true,
  boolean: true,
  dateIso: true,
};

export const FAKER_METHODS: ReadonlySet<keyof FakerInstance> = new Set(
  Object.keys(FAKER_METHOD_FLAGS) as (keyof FakerInstance)[],
);

export function isFakerMethod(name: string): name is keyof FakerInstance {
  return (FAKER_METHODS as ReadonlySet<string>).has(name);
}

/** Identifies one rendering stream: a request (or its webhook fan-out) against one mock entry. */
export interface FakerScope {
  tenant: string;
  /** Mock entry id; suffix it (e.g. `#webhooks`) to give a second stream for the same request. */
  endpoint: string;
  /**
   * Deterministic hit number of this mock entry for this tenant (1, 2, 3, ...). Not the public
   * request id: that is a server-wide arrival counter, so other tenants' traffic would shift it.
   */
  hit: number;
}

export type FakerFactory = (scope: FakerScope) => FakerInstance;

/**
 * Per-request faker (TN8, same model as `createIdHelpers`). In deterministic mode every scope
 * gets a FRESH instance seeded from FNV-1a(seed | tenant | endpoint | hit), so a request's
 * faker values depend only on which hit of that mock entry it is — not on other tenants' or
 * other mocks' traffic, nor on how many faker calls earlier requests made (#52, #53). Repeat
 * hits on the SAME entry are still ordered. Non-deterministic mode shares one unseeded
 * instance: there is nothing to isolate.
 */
export function createFakerFactory(opts: { deterministic: boolean; seed?: number }): FakerFactory {
  if (!opts.deterministic) {
    const shared = createFaker({ deterministic: false });
    return () => shared;
  }
  const base = opts.seed ?? 0;
  return (scope) =>
    createFaker({
      deterministic: true,
      seed: fnv1a(`${base}|${scope.tenant}|${scope.endpoint}|${scope.hit}`),
    });
}

export function createFaker(opts: { deterministic: boolean; seed?: number }): FakerInstance {
  const instance = new Faker({ locale: [en] });
  if (opts.deterministic) {
    instance.seed(opts.seed ?? 0);
    // date.recent() counts back from the reference date, which defaults to wall-clock now.
    // Pin it to the deterministic clock's epoch so faker.dateIso is byte-stable across runs.
    instance.setDefaultRefDate(new Date(DEFAULT_FIXED_EPOCH_MS));
  }
  return {
    uuid: (): string => instance.string.uuid(),
    email: (): string => instance.internet.email(),
    name: (): string => instance.person.fullName(),
    integer: (min: number, max: number): number => instance.number.int({ min, max }),
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error("faker.pick called with empty array");
      return instance.helpers.arrayElement(items);
    },
    boolean: (): boolean => instance.datatype.boolean(),
    dateIso: (): string => instance.date.recent().toISOString(),
  };
}
