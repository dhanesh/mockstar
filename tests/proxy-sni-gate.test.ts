// @constraint RT-3 — SNI allowlist exclusive
// @constraint T3, T4

import { describe, it, expect } from 'bun:test';
import { sniGate, explainSni } from '../src/features/proxy/sni-gate.ts';
import { SnapshotHolder } from '../src/features/proxy/cert-cache.ts';
import type { ProxySnapshot } from '../src/features/proxy/types.ts';

function snapshot(hosts: string[]): ProxySnapshot {
  const hostMap = new Map(hosts.map((h) => [h, { host: h, tenant: 't' }]));
  const leaves = new Map(
    hosts.map((h) => [
      h,
      {
        host: h,
        certPem: 'PEM',
        keyPem: 'KEY',
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        snapshotVersion: 1,
      },
    ]),
  );
  return Object.freeze({
    version: 1,
    hosts: hostMap,
    leaves,
    config: {
      hosts: hosts.map((h) => ({ host: h, tenant: 't' })),
      mockstarUrl: 'http://127.0.0.1:3000',
      listenHost: '127.0.0.1',
      listenPort: 443,
      upstreamTimeoutMs: 5000,
      leafTtlHours: 24,
      dnsMode: 'dnsmasq',
    },
  }) as ProxySnapshot;
}

describe('sniGate', () => {
  it('resolves a configured hostname to its leaf cert', () => {
    const holder = new SnapshotHolder(snapshot(['api.razorpay.com']));
    const resolve = sniGate(holder);
    const result = resolve('api.razorpay.com');
    expect(result).not.toBeNull();
    expect(result?.certPem).toBe('PEM');
  });

  it('returns null for unknown hostnames (rejection path)', () => {
    const holder = new SnapshotHolder(snapshot(['api.razorpay.com']));
    const resolve = sniGate(holder);
    expect(resolve('api.stripe.com')).toBeNull();
    expect(resolve('evil.example.com')).toBeNull();
  });

  it('is case-insensitive', () => {
    const holder = new SnapshotHolder(snapshot(['api.razorpay.com']));
    const resolve = sniGate(holder);
    expect(resolve('API.Razorpay.COM')).not.toBeNull();
  });
});

describe('explainSni', () => {
  it('accepts configured hostname with expiry info', () => {
    const holder = new SnapshotHolder(snapshot(['api.razorpay.com']));
    const r = explainSni(holder, 'api.razorpay.com');
    expect(r.accepted).toBe(true);
    expect(r.reason).toContain('valid until');
  });

  it('rejects unknown hostname with helpful text', () => {
    const holder = new SnapshotHolder(snapshot(['api.razorpay.com']));
    const r = explainSni(holder, 'api.stripe.com');
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain('not in the configured hosts list');
  });
});
