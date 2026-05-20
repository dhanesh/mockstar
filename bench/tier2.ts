#!/usr/bin/env bun
// Satisfies: O1 (Tier 2 render path stays within the latency budget)
// Validates: O1 — render p50/p95/p99 for request-derived-response path.
//
// Runs N iterations against a launched server, reports the latency distribution. Fails with a
// non-zero exit if p95 exceeds the budget. Intended to be run in CI on every PR touching
// src/core/templating/** or src/features/static-mock.ts.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launched, launch } from "../src/index.ts";

const ITERATIONS = Number(process.env.TIER2_BENCH_N ?? 5000);
const P95_BUDGET_US = Number(process.env.TIER2_BENCH_P95_US ?? 500); // 0.5 ms
const P99_BUDGET_US = Number(process.env.TIER2_BENCH_P99_US ?? 1500); // 1.5 ms

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tier2-bench-"));
  await mkdir(join(root, "mocks", "acme"), { recursive: true });
  await mkdir(join(root, "handlers"), { recursive: true });
  await writeFile(
    join(root, "mocks", "acme", "bench.json"),
    JSON.stringify({
      mocks: [
        {
          id: "create-order",
          match: { method: "POST", path: "/orders" },
          response: {
            kind: "static",
            status: 200,
            headers: { "content-type": "application/json" },
            body: {
              id: '{{id("order_", 14)}}',
              amount: "{{request.body.amount}}",
              notes: "{{request.body.notes}}",
              status: "created",
              currency: "INR",
              receipt: "rcpt_{{request.body.receipt}}",
              created_at: "{{now.unix}}",
              nested: {
                customer_id: '{{id("cust_", 14)}}',
                payment_id: '{{id("pay_", 14)}}',
              },
            },
          },
        },
      ],
    }),
  );
  return root;
}

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

async function main(): Promise<number> {
  const root = await setup();
  const launched: Launched = await launch({
    configRoot: join(root, "mocks"),
    handlersDir: join(root, "handlers"),
    deterministic: false,
    watch: false,
    installCrashHandlers: false,
    server: { tenancyModes: ["header"] },
  });

  const payload = JSON.stringify({ amount: 50000, notes: { a: 1 }, receipt: "r1" });
  const headers = { "x-mockstar-tenant": "acme", "content-type": "application/json" };

  // Warm-up
  for (let i = 0; i < 200; i++) {
    await launched.server.hono.request("http://localhost/orders", { method: "POST", headers, body: payload });
  }

  const samples = new Array<number>(ITERATIONS);
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const res = await launched.server.hono.request("http://localhost/orders", {
      method: "POST",
      headers,
      body: payload,
    });
    const durUs = Math.round((performance.now() - start) * 1000);
    await res.text();
    samples[i] = durUs;
  }

  samples.sort((a, b) => a - b);
  const mean = Math.round(samples.reduce((s, v) => s + v, 0) / samples.length);
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);
  const max = samples[samples.length - 1] ?? 0;

  process.stdout.write(`tier2 bench — ${ITERATIONS} iterations\n`);
  process.stdout.write(`  mean: ${mean}µs  p50: ${p50}µs  p95: ${p95}µs  p99: ${p99}µs  max: ${max}µs\n`);
  process.stdout.write(`  budget: p95 ≤ ${P95_BUDGET_US}µs, p99 ≤ ${P99_BUDGET_US}µs\n`);

  await launched.stop();
  await rm(root, { recursive: true, force: true });

  if (p95 > P95_BUDGET_US) {
    process.stderr.write(`FAIL: p95 ${p95}µs exceeds budget ${P95_BUDGET_US}µs\n`);
    return 1;
  }
  if (p99 > P99_BUDGET_US) {
    process.stderr.write(`FAIL: p99 ${p99}µs exceeds budget ${P99_BUDGET_US}µs\n`);
    return 1;
  }
  process.stdout.write("PASS\n");
  return 0;
}

void main().then((code) => process.exit(code));
