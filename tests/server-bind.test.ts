// @constraint S4 — localhost-bind default
// @constraint G13 — bind test coverage

import { describe, it, expect } from 'bun:test';
import { ServerConfig, parseServerConfig } from '../src/core/config/index.ts';

describe('server bind defaults (S4)', () => {
  it('defaults host to 127.0.0.1', () => {
    const cfg = parseServerConfig({});
    expect(cfg.host).toBe('127.0.0.1');
  });

  it('accepts an explicit 0.0.0.0 override (opt-in)', () => {
    const cfg = parseServerConfig({ host: '0.0.0.0' });
    expect(cfg.host).toBe('0.0.0.0');
  });

  it('preserves explicit hostname values', () => {
    const cfg = parseServerConfig({ host: 'mockstar.internal' });
    expect(cfg.host).toBe('mockstar.internal');
  });

  it('admin endpoints are disabled by default (S3)', () => {
    const cfg = ServerConfig.parse({});
    expect(cfg.adminEnabled).toBe(false);
    expect(cfg.rootToken).toBeUndefined();
  });

  it('enables admin when rootToken is provided', () => {
    const cfg = parseServerConfig({ adminEnabled: true, rootToken: 'sixteen-char-tok' });
    expect(cfg.adminEnabled).toBe(true);
    expect(cfg.rootToken).toBe('sixteen-char-tok');
  });
});
