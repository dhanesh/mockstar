// @constraint T11 — CLI subcommand dispatch (closes G5)
// @constraint U3 — `mockstar proxy status` reports subsystem health (closes G6)
// @constraint U4 — Install output surfaces NODE_EXTRA_CA_CERTS
//
// We exercise the pure-dispatch paths of dispatchProxyCommand that don't require
// sudo/mkcert/filesystem writes. Side-effecting subcommands (install, start) are
// validated by the integration test (G3) and CI workflow (G1/G2).

import { describe, it, expect, afterEach } from 'bun:test';
import { dispatchProxyCommand } from '../src/features/proxy/cli.ts';

type Sink = { stdout: string[]; stderr: string[]; restore: () => void };

function captureOutput(): Sink {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // Monkey-patch write. Return true to satisfy the return contract.
  process.stdout.write = ((chunk: unknown): boolean => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    stdout,
    stderr,
    restore(): void {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

describe('dispatchProxyCommand — help and routing (G5)', () => {
  let sink: Sink | null = null;
  afterEach(() => {
    sink?.restore();
    sink = null;
  });

  it('returns 0 and prints help when no subcommand is given', async () => {
    sink = captureOutput();
    const code = await dispatchProxyCommand([]);
    sink.restore();
    expect(code).toBe(0);
    const out = sink.stdout.join('');
    expect(out).toContain('mockstar proxy <subcommand>');
    expect(out).toContain('install');
    expect(out).toContain('start');
    expect(out).toContain('uninstall');
    expect(out).toContain('status');
  });

  it('returns 0 on `help` and `--help`', async () => {
    sink = captureOutput();
    const code1 = await dispatchProxyCommand(['help']);
    const code2 = await dispatchProxyCommand(['--help']);
    sink.restore();
    expect(code1).toBe(0);
    expect(code2).toBe(0);
  });

  it('returns 2 and prints error on unknown subcommand', async () => {
    sink = captureOutput();
    const code = await dispatchProxyCommand(['not-a-command']);
    sink.restore();
    expect(code).toBe(2);
    expect(sink.stderr.join('')).toContain('Unknown proxy subcommand');
  });

  it('reload subcommand returns 0 with a diagnostic message (no-op)', async () => {
    sink = captureOutput();
    const code = await dispatchProxyCommand(['reload']);
    sink.restore();
    expect(code).toBe(0);
    expect(sink.stdout.join('')).toContain('file-watch');
  });
});

describe('dispatchProxyCommand — status (G6)', () => {
  let sink: Sink | null = null;
  afterEach(() => {
    sink?.restore();
    sink = null;
  });

  it('status works when no config exists and no journal exists', async () => {
    // Use a non-existent config path so loadConfigFile fails gracefully. Status
    // should still render CA + journal + config lines.
    sink = captureOutput();
    const code = await dispatchProxyCommand(['status', '--config', '/tmp/nonexistent-mockstar-cfg.json']);
    sink.restore();
    // Even when CA and config aren't present, status completes (0).
    expect(code).toBe(0);
    const out = sink.stdout.join('');
    expect(out).toContain('mockstar-proxy status');
    expect(out).toContain('CA installed:');
    expect(out).toContain('Config:');
    expect(out).toContain('Journal:');
  });

  it('status output includes all five diagnostic lines', async () => {
    sink = captureOutput();
    await dispatchProxyCommand(['status', '--config', '/tmp/nonexistent-mockstar-cfg.json']);
    sink.restore();
    const out = sink.stdout.join('');
    expect(out).toContain('CA installed:');
    expect(out).toContain('CA common name:');
    expect(out).toContain('CAROOT:');
    expect(out).toContain('Config:');
    expect(out).toContain('Journal:');
  });
});
