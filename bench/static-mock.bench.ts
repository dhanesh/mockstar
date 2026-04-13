// Satisfies: RT-10.2 (per-channel benchmark); validates RT-6 (hot-path budget)
// This scenario: 1000-mock config, sustained RPS, measure p50/p99/p999 + boot time.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../src/index.ts';
import { computePercentiles } from './harness.ts';

export interface ScenarioOptions {
  rps: number;
  durationSec: number;
  channel: 'bunx' | 'library' | 'docker' | 'binary';
}

export interface ScenarioResult {
  sampleCount: number;
  p50: number;
  p99: number;
  p999: number;
  mean: number;
  bootMs: number | null;
}

export async function runStaticMockBench(opts: ScenarioOptions): Promise<ScenarioResult> {
  const configRoot = await generate1000MockTenant();
  const bootStart = performance.now();
  const launched = await launch({
    configRoot: join(configRoot, 'mocks'),
    handlersDir: join(configRoot, 'handlers'),
    deterministic: true,
    watch: false,
    installCrashHandlers: false,
    server: { tenancyModes: ['header'] },
  });
  const bootMs = performance.now() - bootStart;

  const samples: number[] = [];
  const intervalMs = 1000 / opts.rps;
  const endAt = performance.now() + opts.durationSec * 1000;

  while (performance.now() < endAt) {
    const t0 = performance.now();
    const res = await launched.server.hono.request('http://localhost/entries/500', {
      headers: { 'x-mockstar-tenant': 'bench' },
    });
    const t1 = performance.now();
    if (res.status !== 200) throw new Error(`bench got ${res.status}`);
    samples.push((t1 - t0) * 1000); // microseconds
    const slack = intervalMs - (t1 - t0);
    if (slack > 0) await new Promise((r) => setTimeout(r, slack));
  }

  await launched.stop();

  return {
    sampleCount: samples.length,
    ...computePercentiles(samples),
    bootMs,
  };
}

async function generate1000MockTenant(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mockstar-bench-'));
  await mkdir(join(root, 'mocks', 'bench'), { recursive: true });
  await mkdir(join(root, 'handlers'), { recursive: true });
  const mocks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 1000; i++) {
    mocks.push({
      id: `mock-${i}`,
      match: { method: 'GET', path: `/entries/${i}` },
      response: { kind: 'static', status: 200, body: { id: i, label: `entry ${i}` } },
    });
  }
  await writeFile(join(root, 'mocks', 'bench', 'entries.json'), JSON.stringify({ mocks }));
  return root;
}
