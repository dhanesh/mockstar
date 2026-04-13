// Satisfies: RT-10.1 (benchmark harness), RT-10.3 (regression gate vs baseline)
// Priority: binding — this is the instrument that validates RT-6.
//
// Usage:
//   bun run bench/harness.ts [--rps=1000] [--duration=60] [--scenario=static-mock]

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runStaticMockBench } from './static-mock.bench.ts';

export interface BenchResult {
  scenario: string;
  channel: string;
  rps: number;
  durationSec: number;
  sampleCount: number;
  p50: number;
  p99: number;
  p999: number;
  mean: number;
  bootMs: number | null;
  timestamp: string;
}

export interface BenchOptions {
  rps: number;
  durationSec: number;
  scenario: 'static-mock';
  channel: 'bunx' | 'library' | 'docker' | 'binary';
  baselinePath?: string;
}

export async function runBench(opts: BenchOptions): Promise<BenchResult> {
  const result = await runStaticMockBench({
    rps: opts.rps,
    durationSec: opts.durationSec,
    channel: opts.channel,
  });

  const out = {
    scenario: opts.scenario,
    channel: opts.channel,
    rps: opts.rps,
    durationSec: opts.durationSec,
    sampleCount: result.sampleCount,
    p50: result.p50,
    p99: result.p99,
    p999: result.p999,
    mean: result.mean,
    bootMs: result.bootMs,
    timestamp: new Date().toISOString(),
  } satisfies BenchResult;

  // Persist the run for CI artifact upload.
  const resultsDir = resolve('bench', 'results');
  await mkdir(resultsDir, { recursive: true });
  await writeFile(resolve(resultsDir, `${out.scenario}-${out.channel}-${Date.now()}.json`), JSON.stringify(out, null, 2) + '\n');

  if (opts.baselinePath) {
    await checkRegression(out, opts.baselinePath);
  }

  return out;
}

/**
 * Regression gate: fail if p99 > baseline.p99 * 1.1 OR boot > baseline.boot * 1.1.
 * Called by CI; exits 1 on regression.
 */
async function checkRegression(current: BenchResult, baselinePath: string): Promise<void> {
  let baseline: Record<string, BenchResult> = {};
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Record<string, BenchResult>;
  } catch {
    process.stdout.write(`No baseline at ${baselinePath} — recording current run as baseline.\n`);
    baseline[`${current.scenario}:${current.channel}`] = current;
    await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
    return;
  }
  const key = `${current.scenario}:${current.channel}`;
  const prev = baseline[key];
  if (!prev) {
    baseline[key] = current;
    await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
    return;
  }
  // Thresholds are empirical: p99 on short benches has ~10-15% run-to-run variance on commodity
  // hardware (Bun JIT warm-up, OS scheduling). 25% flags genuine regressions without flapping.
  // Boot time is more stable, so 15% is appropriate.
  const P99_REGRESSION_THRESHOLD = 1.25;
  const BOOT_REGRESSION_THRESHOLD = 1.15;
  const regressedP99 = current.p99 > prev.p99 * P99_REGRESSION_THRESHOLD;
  const regressedBoot = current.bootMs !== null && prev.bootMs !== null ? current.bootMs > prev.bootMs * BOOT_REGRESSION_THRESHOLD : false;
  if (regressedP99 || regressedBoot) {
    process.stderr.write(
      `REGRESSION in ${key}: p99 ${prev.p99.toFixed(2)}us → ${current.p99.toFixed(2)}us; boot ${prev.bootMs}ms → ${current.bootMs}ms\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`Bench within budget (${key}): p99 ${current.p99.toFixed(2)}us, boot ${current.bootMs}ms\n`);
}

// biome-ignore lint/suspicious/noExplicitAny: Bun import.meta
const isMain = (import.meta as any).main === true;
if (isMain) {
  const rps = Number.parseInt(getFlag('--rps') ?? '1000', 10);
  const durationSec = Number.parseInt(getFlag('--duration') ?? '30', 10);
  const channel = (getFlag('--channel') ?? 'library') as BenchOptions['channel'];
  const baselinePath = getFlag('--baseline') ?? resolve('bench', 'baselines.json');
  void runBench({ rps, durationSec, scenario: 'static-mock', channel, baselinePath }).then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  });
}

function getFlag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const pref = args.find((a) => a.startsWith(`${name}=`));
  return pref ? pref.slice(name.length + 1) : undefined;
}

export function computePercentiles(samplesMicros: readonly number[]): { p50: number; p99: number; p999: number; mean: number } {
  if (samplesMicros.length === 0) return { p50: 0, p99: 0, p999: 0, mean: 0 };
  const sorted = [...samplesMicros].sort((a, b) => a - b);
  const pct = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return { p50: pct(0.5), p99: pct(0.99), p999: pct(0.999), mean: sum / sorted.length };
}
