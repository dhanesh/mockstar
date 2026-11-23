// Satisfies: U4 (faker-style generators), RT-12.2 (deterministic mode: seeded faker)
// G3 fix: use `new Faker({ locale: [en] })` per call so two createFaker invocations with
// the same seed produce byte-identical outputs. Previously we reseeded the global
// `faker` singleton, so the advancing state was shared across closures.
//
// Seeded output is stable only within one @faker-js/faker major (upstream does not promise
// cross-version stability). tests/faker-golden.test.ts pins the seed-0 sequence so a faker
// bump that changes deterministic fixtures fails CI instead of shipping silently (#50).

import { Faker, en } from "@faker-js/faker";
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
export const FAKER_METHODS: ReadonlySet<keyof FakerInstance> = new Set<keyof FakerInstance>([
  "uuid",
  "email",
  "name",
  "integer",
  "pick",
  "boolean",
  "dateIso",
] satisfies (keyof FakerInstance)[]);

export function isFakerMethod(name: string): name is keyof FakerInstance {
  return (FAKER_METHODS as ReadonlySet<string>).has(name);
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
