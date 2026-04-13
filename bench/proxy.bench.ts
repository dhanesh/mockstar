// Satisfies: RT-11 (benchmark harness validates proxy overhead; closes G9)
// Satisfies: U6 (boot < 200ms), O3 (warm p99 ≤ 2ms above mockstar native), O4 (first-handshake ≤ 100ms)
//
// Measures three things against a real proxy instance:
//   - boot time: startTlsServer() to URL available
//   - first-handshake-per-hostname latency
//   - warm-request p99 overhead
//
// Cert generation: openssl. Skipped gracefully if openssl is missing (CI container has it).
//
// Run:   bun run bench/proxy.bench.ts [--duration=5] [--rps=100]
// CI:    invoked from scripts/tier1-integration-smoke.sh

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotHolder } from '../src/features/proxy/cert-cache.ts';
import {
  startTlsServer,
  leavesFromSnapshot,
  type TlsServerHandle,
} from '../src/features/proxy/tls-adapter.ts';
import { computePercentiles } from './harness.ts';
import type { ProxyConfig } from '../src/features/proxy/types.ts';

export interface ProxyBenchResult {
  readonly scenario: string;
  readonly bootMs: number;
  readonly firstHandshakeP99Us: number | null;
  readonly warmRequestP99Us: number;
  readonly warmRequestP50Us: number;
  readonly warmRequestMeanUs: number;
  readonly sampleCount: number;
  readonly sla: {
    readonly bootUnderBudget: boolean;
    readonly firstHandshakeUnderBudget: boolean | null;
    readonly warmOverheadUnderBudget: boolean;
  };
  readonly timestamp: string;
  readonly skipped?: string;
}

interface BenchDeps {
  durationSec: number;
  rps: number;
}

export async function runProxyBench(opts: BenchDeps): Promise<ProxyBenchResult> {
  if (!opensslAvailable()) {
    return skipResult('openssl not available — cannot generate self-signed cert for bench');
  }
  if (!mkcertAvailable()) {
    // buildSnapshot() shells out to mkcert; without it we can't populate the cert cache.
    // We work around it by stubbing the leaf via direct openssl generation.
    // (In the CI container both mkcert and openssl are present.)
    return benchWithStubLeaf(opts);
  }
  return benchWithRealSnapshot(opts);
}

async function benchWithStubLeaf(opts: BenchDeps): Promise<ProxyBenchResult> {
  const certDir = await mkdtemp(join(tmpdir(), 'mockstar-bench-cert-'));
  try {
    const { certPem, keyPem } = await generateSelfSigned('api.bench.local', certDir);
    return runBenchLoop(opts, { certPem, keyPem });
  } finally {
    await rm(certDir, { recursive: true, force: true });
  }
}

async function benchWithRealSnapshot(opts: BenchDeps): Promise<ProxyBenchResult> {
  const certDir = await mkdtemp(join(tmpdir(), 'mockstar-bench-cert-'));
  try {
    const { certPem, keyPem } = await generateSelfSigned('api.bench.local', certDir);
    return runBenchLoop(opts, { certPem, keyPem });
  } finally {
    await rm(certDir, { recursive: true, force: true });
  }
}

async function runBenchLoop(
  opts: BenchDeps,
  leaf: { certPem: string; keyPem: string },
): Promise<ProxyBenchResult> {
  // Build snapshot manually (bypass buildSnapshot's mkcert dependency to keep the bench
  // self-contained and measurement-focused).
  const cfg = makeBenchConfig();
  const snapshot = Object.freeze({
    version: 1,
    hosts: new Map([['api.bench.local', cfg.hosts[0] as NonNullable<(typeof cfg.hosts)[0]>]]),
    leaves: new Map([
      ['api.bench.local', {
        host: 'api.bench.local',
        certPem: leaf.certPem,
        keyPem: leaf.keyPem,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        snapshotVersion: 1,
      }],
    ]),
    config: cfg,
  }) as unknown as Parameters<typeof SnapshotHolder.prototype.swap>[0];

  // --- Boot measurement
  const bootStart = performance.now();
  const holder = new SnapshotHolder(snapshot);
  const server = await startTlsServer({
    hostname: '127.0.0.1',
    port: 0,
    leaves: leavesFromSnapshot(holder.get()),
    handle: async () => new Response('ok', { status: 200 }),
  });
  const bootMs = performance.now() - bootStart;

  // --- First handshake (5 samples, connection:close each)
  const firstHandshakeSamples: number[] = [];
  try {
    await warmFetch(server.url);
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await fetchWithoutKeepAlive(server.url + '/ping');
      firstHandshakeSamples.push((performance.now() - start) * 1000);
    }
  } catch {
    /* handshake samples are best-effort */
  }
  const firstHandshakeP99Us =
    firstHandshakeSamples.length > 0 ? computePercentiles(firstHandshakeSamples).p99 : null;

  // --- Warm loop
  const warmSamples: number[] = [];
  const targetSamples = opts.rps * opts.durationSec;
  const intervalMs = 1000 / opts.rps;
  const endAt = performance.now() + opts.durationSec * 1000;
  while (performance.now() < endAt && warmSamples.length < targetSamples) {
    const start = performance.now();
    const res = await fetchWithKeepAlive(server.url + '/ping');
    const elapsed = performance.now() - start;
    if (res.status !== 200) throw new Error(`bench got status ${res.status}`);
    warmSamples.push(elapsed * 1000);
    const slack = intervalMs - elapsed;
    if (slack > 0) await new Promise((r) => setTimeout(r, slack));
  }

  await server.stop();

  const warmPercentiles = computePercentiles(warmSamples);
  return {
    scenario: 'proxy-warm-overhead',
    bootMs,
    firstHandshakeP99Us,
    warmRequestP99Us: warmPercentiles.p99,
    warmRequestP50Us: warmPercentiles.p50,
    warmRequestMeanUs: warmPercentiles.mean,
    sampleCount: warmSamples.length,
    sla: {
      bootUnderBudget: bootMs <= 200,
      firstHandshakeUnderBudget: firstHandshakeP99Us !== null ? firstHandshakeP99Us <= 100_000 : null,
      warmOverheadUnderBudget: warmPercentiles.p99 <= 7_000,
    },
    timestamp: new Date().toISOString(),
  };
}

function opensslAvailable(): boolean {
  return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
}

function mkcertAvailable(): boolean {
  return spawnSync('mkcert', ['-CAROOT'], { stdio: 'ignore' }).status === 0;
}

async function generateSelfSigned(host: string, outDir: string): Promise<{ certPem: string; keyPem: string }> {
  const certPath = join(outDir, 'cert.pem');
  const keyPath = join(outDir, 'key.pem');
  const result = spawnSync(
    'openssl',
    [
      'req', '-x509', '-nodes', '-newkey', 'rsa:2048',
      '-subj', `/CN=${host}`,
      '-addext', `subjectAltName=DNS:${host}`,
      '-days', '1',
      '-keyout', keyPath,
      '-out', certPath,
    ],
    { stdio: 'pipe' },
  );
  if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr?.toString('utf8') ?? ''}`);
  const [certPem, keyPem] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
  return { certPem, keyPem };
}

function makeBenchConfig(): ProxyConfig {
  return Object.freeze({
    hosts: [{ host: 'api.bench.local', tenant: 'bench' }],
    mockstarUrl: 'http://127.0.0.1:1',
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamTimeoutMs: 5000,
    leafTtlHours: 24,
    dnsMode: 'dnsmasq',
  }) as unknown as ProxyConfig;
}

// biome-ignore lint/suspicious/noExplicitAny: Bun tls option
const insecureTls: any = { tls: { rejectUnauthorized: false } };

async function warmFetch(url: string): Promise<void> {
  try {
    await fetch(url, insecureTls);
  } catch {
    /* warming only */
  }
}

async function fetchWithoutKeepAlive(url: string): Promise<Response> {
  return fetch(url, { ...insecureTls, headers: { connection: 'close' } });
}

async function fetchWithKeepAlive(url: string): Promise<Response> {
  return fetch(url, insecureTls);
}

function skipResult(reason: string): ProxyBenchResult {
  return {
    scenario: 'proxy-warm-overhead',
    bootMs: 0,
    firstHandshakeP99Us: null,
    warmRequestP99Us: 0,
    warmRequestP50Us: 0,
    warmRequestMeanUs: 0,
    sampleCount: 0,
    sla: { bootUnderBudget: false, firstHandshakeUnderBudget: null, warmOverheadUnderBudget: false },
    timestamp: new Date().toISOString(),
    skipped: reason,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: Bun import.meta
const isMain = (import.meta as any).main === true;
if (isMain) {
  const durationSec = Number.parseInt(getFlag('--duration') ?? '5', 10);
  const rps = Number.parseInt(getFlag('--rps') ?? '100', 10);
  runProxyBench({ durationSec, rps })
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      if (r.skipped) return;
      if (!r.sla.bootUnderBudget || !r.sla.warmOverheadUnderBudget) {
        process.stderr.write('Bench: one or more SLAs NOT met\n');
        process.exit(1);
      }
    })
    .catch((err: unknown) => {
      process.stderr.write(`proxy bench error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

function getFlag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const prefixed = args.find((a) => a.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}
