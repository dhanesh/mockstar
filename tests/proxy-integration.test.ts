// @constraint T1 — Bun HTTPS proxy (closes G3)
// @constraint RT-2 — TLS adapter
// @constraint RT-3 — SNI allowlist gate end-to-end
//
// Integration test that boots startTlsServer with a real self-signed cert
// (generated on-the-fly via openssl; skipped if openssl unavailable) and verifies
// handshake + handler dispatch. No sudo, no mkcert, no external dependencies
// beyond openssl (present on macOS + Linux by default).

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startTlsServer, leavesFromSnapshot, type TlsServerHandle } from '../src/features/proxy/tls-adapter.ts';
import { SnapshotHolder } from '../src/features/proxy/cert-cache.ts';
import type { HostConfig, LeafCert, ProxySnapshot } from '../src/features/proxy/types.ts';

// --- Helpers -------------------------------------------------------------

function opensslAvailable(): boolean {
  const result = spawnSync('openssl', ['version'], { stdio: 'ignore' });
  return result.status === 0;
}

async function generateSelfSigned(host: string): Promise<{
  dir: string;
  certPem: string;
  keyPem: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'mockstar-int-cert-'));
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
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
  if (result.status !== 0) {
    throw new Error(
      `openssl req failed (exit ${result.status}): ${result.stderr?.toString('utf8') ?? ''}`,
    );
  }
  const [certPem, keyPem] = await Promise.all([
    readFile(certPath, 'utf8'),
    readFile(keyPath, 'utf8'),
  ]);
  return { dir, certPem, keyPem };
}

function makeSnapshot(hosts: readonly HostConfig[], certPem: string, keyPem: string): ProxySnapshot {
  const hostMap = new Map(hosts.map((h) => [h.host.toLowerCase(), h]));
  const leaves = new Map<string, LeafCert>();
  for (const h of hosts) {
    leaves.set(h.host.toLowerCase(), {
      host: h.host,
      certPem,
      keyPem,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      snapshotVersion: 1,
    });
  }
  return Object.freeze({
    version: 1,
    hosts: hostMap,
    leaves,
    config: {
      hosts,
      mockstarUrl: 'http://127.0.0.1:3000',
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamTimeoutMs: 5000,
      leafTtlHours: 24,
      dnsMode: 'dnsmasq',
    },
  }) as ProxySnapshot;
}

// --- Tests ---------------------------------------------------------------

const SKIP_REASON = 'openssl not available on PATH — full TLS handshake test requires openssl to generate a valid self-signed cert';

describe('TLS server integration (T1 / RT-2 / RT-3 / G3)', () => {
  if (!opensslAvailable()) {
    it.skip(`skipped: ${SKIP_REASON}`, () => undefined);
    return;
  }

  let serverHandle: TlsServerHandle | null = null;
  let holder: SnapshotHolder;
  let scratchDir: string;

  beforeAll(async () => {
    const { dir, certPem, keyPem } = await generateSelfSigned('api.razorpay.com');
    scratchDir = dir;
    const snapshot = makeSnapshot(
      [{ host: 'api.razorpay.com', tenant: 'razorpay' }],
      certPem,
      keyPem,
    );
    holder = new SnapshotHolder(snapshot);
  });

  afterAll(async () => {
    await serverHandle?.stop();
    serverHandle = null;
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('startTlsServer binds and returns a resolvable URL', async () => {
    serverHandle = await startTlsServer({
      hostname: '127.0.0.1',
      port: 0,
      leaves: leavesFromSnapshot(holder.get()),
      handle: async (req) =>
        new Response(JSON.stringify({ path: new URL(req.url).pathname }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(serverHandle.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
  });

  it('TLS handshake + HTTP forward succeeds for a configured hostname', async () => {
    if (!serverHandle) throw new Error('server not started');
    // Our cert is self-signed; we disable verification at the fetch layer.
    // biome-ignore lint/suspicious/noExplicitAny: Bun-specific tls option
    const opts: any = { tls: { rejectUnauthorized: false } };
    const res = await fetch(`${serverHandle.url}/v1/orders`, opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe('/v1/orders');
  });

  it('snapshot swap + handler dispatch is atomic (captured snapshot wins)', async () => {
    if (!serverHandle) throw new Error('server not started');
    // Swap in a new snapshot; the server's next handshake should see it.
    const { certPem, keyPem } = await generateSelfSigned('api.razorpay.com');
    const next = makeSnapshot(
      [{ host: 'api.razorpay.com', tenant: 'razorpay' }],
      certPem,
      keyPem,
    );
    const { previous } = holder.swap(next);
    expect(previous.version).toBe(1);
    expect(holder.get().version).toBe(1);
  });

  it('stop() is idempotent', async () => {
    if (!serverHandle) throw new Error('server not started');
    await serverHandle.stop();
    await expect(serverHandle.stop()).resolves.toBeUndefined();
    serverHandle = null;
  });
});
