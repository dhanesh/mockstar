// @constraint RT-12.2 — deterministic mode: seeded faker output is byte-stable
// @constraint U4 — faker template helpers are an explicit allowlist (#50)
//
// @faker-js/faker does not promise stable seeded output across releases — it changed between
// 9.x -> 10.x AND between 10.5 -> 10.6. MOCKSTAR_DETERMINISTIC users commit fixtures built from
// this output, so this test pins the exact seed-0 sequence. If a faker bump fails here, the
// bump changes user fixtures: update the golden values deliberately and say so in the
// release notes (a `feat:` commit, not a silent `fix:`).

import { describe, expect, it } from "bun:test";
import { type TemplateContext, compileTemplate } from "../src/core/templating/compiler.ts";
import { FAKER_METHODS, createFaker } from "../src/core/templating/faker.ts";
import { createIdHelpers } from "../src/core/templating/tier2/id.ts";
import { createClock } from "../src/core/templating/tier2/now.ts";

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
    const realNow = Date.now;
    try {
      Date.now = () => Date.UTC(2031, 5, 15);
      expect(seed0Sequence()[6]).toBe(GOLDEN_SEED_0[6]);
    } finally {
      Date.now = realNow;
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
