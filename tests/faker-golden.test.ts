// @constraint RT-12.2 — deterministic mode: seeded faker output is byte-stable
// @constraint U4 — faker template helpers are an explicit allowlist (#50)
//
// @faker-js/faker does not promise stable seeded output across releases — it changed between
// 9.x -> 10.x AND between 10.5 -> 10.6. MOCKSTAR_DETERMINISTIC users commit fixtures built from
// this output, so package.json pins faker exactly and this test pins the seed-0 sequence. If a
// faker bump fails here, the bump changes user fixtures: update the golden values deliberately,
// add a note to docs/SDET.md, and use a `feat:` commit (semantic-release puts only the subject
// line in the release notes — the docs carry the detail).

import { describe, expect, it, setSystemTime } from "bun:test";
import { type TemplateContext, compileTemplate } from "../src/core/templating/compiler.ts";
import { FAKER_METHODS, createFaker } from "../src/core/templating/faker.ts";
import { createIdHelpers } from "../src/core/templating/tier2/id.ts";
import { DEFAULT_FIXED_EPOCH_MS, createClock } from "../src/core/templating/tier2/now.ts";

const GOLDEN_SEED_0 = [
  "8b986a7e-f6c8-49e1-910d-cdfc7c1a2f86",
  "Aisha_Morissette@yahoo.com",
  "Amie Osinski",
  13,
  "a",
  true,
  "2025-12-31T13:41:04.431Z",
];

function seed0Sequence(): unknown[] {
  const f = createFaker({ deterministic: true, seed: 0 });
  return [
    f.uuid(),
    f.email(),
    f.name(),
    f.integer(1, 100),
    f.pick(["a", "b", "c"]),
    f.boolean(),
    f.dateIso(),
  ];
}

describe("deterministic faker golden output", () => {
  it("seed 0 yields the pinned sequence (fails on a fixture-changing faker bump)", () => {
    expect(seed0Sequence()).toEqual(GOLDEN_SEED_0);
  });

  it("dateIso is independent of wall-clock time (anchored to the deterministic epoch)", () => {
    // setSystemTime, not a Date.now override: faker calls `new Date()`, which in Bun ignores
    // a reassigned Date.now. Two far-apart system times must give the same value, and that
    // value must sit in the 24 h before DEFAULT_FIXED_EPOCH_MS (date.recent's default window).
    const dateAt = (ms: number): string => {
      setSystemTime(new Date(ms));
      return createFaker({ deterministic: true, seed: 0 }).dateIso();
    };
    try {
      const a = dateAt(Date.UTC(2020, 0, 1));
      const b = dateAt(Date.UTC(2031, 5, 15));
      expect(a).toBe(b);
      const ms = Date.parse(a);
      expect(ms).toBeLessThanOrEqual(DEFAULT_FIXED_EPOCH_MS);
      expect(ms).toBeGreaterThanOrEqual(DEFAULT_FIXED_EPOCH_MS - 24 * 60 * 60 * 1000);
    } finally {
      setSystemTime();
    }
  });
});

describe("faker template method allowlist", () => {
  const ctx: TemplateContext = {
    faker: createFaker({ deterministic: true, seed: 0 }),
    tenant: "acme",
    requestId: "req-1",
    clock: createClock({ deterministic: true }),
    idHelpers: createIdHelpers({ deterministic: true, tenant: "acme", endpoint: "t", requestCounter: 1 }),
    request: { method: "GET", path: "/", query: {}, headers: {}, body: null, params: {} },
  };

  it("exposes exactly the documented helpers", () => {
    expect([...FAKER_METHODS].sort()).toEqual([
      "boolean",
      "dateIso",
      "email",
      "integer",
      "name",
      "pick",
      "uuid",
    ]);
  });

  it.each([
    "faker.uuidd",
    "faker.constructor",
    "faker.toString",
    'faker.hasOwnProperty("uuid")',
    "faker.__proto__",
  ])("renders %s literally instead of reaching non-allowlisted properties", (expr) => {
    expect(compileTemplate(`{{${expr}}}`).render(ctx)).toBe(`{{${expr}}}`);
  });

  it("still renders allowlisted helpers", () => {
    expect(compileTemplate("{{faker.integer(5, 5)}}").render(ctx)).toBe("5");
  });
});
