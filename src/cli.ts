#!/usr/bin/env bun
// Satisfies: U2 (bunx / npm distribution channel)
// Satisfies: T4 (boot time target applies to this path)

import { resolve } from 'node:path';
import { launch } from './index.ts';
import { runImporter } from './features/openapi/index.ts';
import { preflight } from './core/preflight.ts';

interface ParsedArgs {
  command: 'serve' | 'import' | 'help' | 'version';
  configRoot?: string;
  handlersDir?: string;
  port?: number;
  host?: string;
  specPath?: string;
  outDir?: string;
  tenantName?: string;
  deterministic?: boolean;
  watch?: boolean;
  allowPrivate?: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [head, ...rest] = argv;
  if (!head || head === '--help' || head === '-h' || head === 'help') return { command: 'help' };
  if (head === '--version' || head === '-v' || head === 'version') return { command: 'version' };
  if (head === 'import') {
    const specPath = rest[0];
    const outDir = rest.find((r, i) => i > 0 && !r.startsWith('-')) ?? './mocks';
    return {
      command: 'import',
      specPath,
      outDir,
      tenantName: rest.find((r) => r.startsWith('--tenant='))?.slice('--tenant='.length),
      allowPrivate: rest.includes('--allow-private'),
    };
  }
  // Default: serve from positional config root.
  const configRoot = head.startsWith('-') ? './mocks' : head;
  return {
    command: 'serve',
    configRoot,
    handlersDir: getFlag(rest, '--handlers'),
    port: Number.parseInt(getFlag(rest, '--port') ?? process.env.MOCKSTAR_PORT ?? '3000', 10),
    host: getFlag(rest, '--host') ?? process.env.MOCKSTAR_HOST ?? '127.0.0.1',
    deterministic: rest.includes('--deterministic') || process.env.MOCKSTAR_DETERMINISTIC === '1',
    watch: !rest.includes('--no-watch'),
  };
}

function getFlag(args: readonly string[], name: string): string | undefined {
  const prefixed = args.find((a) => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // O6 preflight — runs before any other work so version issues surface immediately.
  const pf = preflight();
  if (pf.warning) process.stderr.write(`mockstar: ${pf.warning}\n`);
  if (!pf.ok) return 1;

  if (args.command === 'help' || args.command === 'version') {
    if (args.command === 'version') {
      process.stdout.write(`mockstar 0.1.0-alpha.1\n`);
      return 0;
    }
    process.stdout.write(usage());
    return 0;
  }

  if (args.command === 'import') {
    if (!args.specPath || !args.outDir) {
      process.stderr.write(usage());
      return 2;
    }
    // Run importer in-process by default for CLI ergonomics; the subprocess form
    // is available via `bun run src/features/openapi/importer.ts ...` for isolation.
    const result = await runImporter({
      specPath: args.specPath,
      outDir: args.outDir,
      tenantName: args.tenantName,
      allowPrivateUpstreams: args.allowPrivate,
    });
    process.stdout.write(`Imported ${result.entryCount} mocks → ${result.outFile}\n`);
    return 0;
  }

  const configRoot = resolve(args.configRoot ?? './mocks');
  const adminEnabled = Boolean(process.env.MOCKSTAR_ADMIN_TOKEN);

  const launched = await launch({
    configRoot,
    handlersDir: args.handlersDir,
    deterministic: args.deterministic ?? false,
    watch: args.watch ?? true,
    server: {
      host: args.host ?? '127.0.0.1',
      port: args.port ?? 3000,
      adminEnabled,
      rootToken: process.env.MOCKSTAR_ADMIN_TOKEN,
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: Bun global
  const serve = (globalThis as any).Bun?.serve;
  if (!serve) {
    process.stderr.write('Mockstar CLI requires the Bun runtime (https://bun.sh). Use library embed otherwise.\n');
    return 1;
  }
  const bunServer = serve({
    hostname: args.host ?? '127.0.0.1',
    port: args.port ?? 3000,
    fetch: launched.server.hono.fetch,
  }) as { hostname: string; port: number };
  process.stdout.write(
    `mockstar listening on http://${bunServer.hostname}:${bunServer.port} (config: ${configRoot}, deterministic=${args.deterministic ?? false}, admin=${adminEnabled})\n`,
  );

  // Keep process alive; Bun.serve already holds the event loop. Still handle SIGTERM for orchestrators.
  process.on('SIGTERM', () => {
    void launched.stop().then(() => process.exit(0));
  });
  return 0;
}

function usage(): string {
  return [
    'mockstar <command> [options]',
    '',
    'Commands:',
    '  serve [config-root]         Start the mock server (default command)',
    '  import <spec> <out-dir>     Convert an OpenAPI 3.x spec to Mockstar JSON',
    '  help                        Show this help',
    '  version                     Print version',
    '',
    'Serve options:',
    '  --handlers <path>           Path to handlers directory (default ../handlers)',
    '  --port <port>               Listen port (default 3000; env: MOCKSTAR_PORT)',
    '  --host <host>               Bind host (default 127.0.0.1; env: MOCKSTAR_HOST)',
    '  --deterministic             Enable CI deterministic mode',
    '  --no-watch                  Disable file-watch hot reload',
    '',
    'Env:',
    '  MOCKSTAR_ADMIN_TOKEN        Root admin token (enables /metrics)',
    '',
  ].join('\n') + '\n';
}

// Entry point. Bun executes this file directly via bunx.
void main().then((code) => {
  if (code !== 0) process.exit(code);
});
