// @constraint RT-10 — Env hostility detection with remediation messages
// @constraint U5, S4

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { detectEnvHostility, remediationMessage } from '../src/features/proxy/env-detector.ts';

describe('detectEnvHostility (CI detection)', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    // Restore all relevant env vars
    for (const key of ['CI', 'GITHUB_ACTIONS', 'CIRCLECI', 'BUILDKITE', 'container']) {
      delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('detects CI=true', async () => {
    process.env.CI = 'true';
    const result = await detectEnvHostility();
    expect(result.kind).toBe('containerized-or-ci');
  });

  it('detects GITHUB_ACTIONS=true', async () => {
    delete process.env.CI;
    process.env.GITHUB_ACTIONS = 'true';
    const result = await detectEnvHostility();
    expect(result.kind).toBe('containerized-or-ci');
  });

  it('detects container env var', async () => {
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    process.env.container = 'docker';
    const result = await detectEnvHostility();
    expect(result.kind).toBe('containerized-or-ci');
  });
});

describe('remediationMessage', () => {
  it('covers every EnvHostility kind', () => {
    const kinds = [
      { kind: 'clean' as const },
      { kind: 'containerized-or-ci' as const, detail: 'CI=true' },
      { kind: 'port-443-bound' as const, detail: 'pid 1234' },
      { kind: 'mdm-managed' as const, detail: 'profiles enrollment' },
      { kind: 'vpn-resolver-override' as const, detail: 'scutil reports 5 resolvers' },
    ];
    for (const h of kinds) {
      const msg = remediationMessage(h);
      expect(msg.length).toBeGreaterThan(20);
    }
  });

  it('for CI, explains that dev CA in CI is disallowed', () => {
    const msg = remediationMessage({ kind: 'containerized-or-ci', detail: 'CI=true' });
    expect(msg).toContain('S4');
    expect(msg).toContain('library-embed');
  });

  it('for port-443-bound, suggests lsof', () => {
    const msg = remediationMessage({ kind: 'port-443-bound', detail: 'pid 1234' });
    expect(msg).toContain('lsof -i :443');
  });

  it('for mdm-managed, offers three options (IT coordination, fallback mode, force)', () => {
    const msg = remediationMessage({ kind: 'mdm-managed', detail: 'profile X' });
    expect(msg).toContain('IT');
    expect(msg).toContain('hosts');
    expect(msg).toContain('--force');
  });
});
