// Satisfies: U4 (faker-style generators), RT-12.2 (deterministic mode: seeded faker)
// G3 fix: use `new Faker({ locale: [en] })` per call so two createFaker invocations with
// the same seed produce byte-identical outputs. Previously we reseeded the global
// `faker` singleton, so the advancing state was shared across closures.

import { Faker, en } from "@faker-js/faker";

export interface FakerInstance {
  uuid(): string;
  email(): string;
  name(): string;
  integer(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  boolean(): boolean;
  dateIso(): string;
}

export function createFaker(opts: { deterministic: boolean; seed?: number }): FakerInstance {
  const instance = new Faker({ locale: [en] });
  if (opts.deterministic) {
    instance.seed(opts.seed ?? 0);
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
