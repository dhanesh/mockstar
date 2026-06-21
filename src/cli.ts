#!/usr/bin/env bun
// Satisfies: U2 (bunx / npm distribution channel)
// Satisfies: T4 (boot time target applies to this path)

import { resolve } from "node:path";
import { minorTagFromVersion, runInit } from "./cli/commands/init.ts";
import { runMigrateSchema } from "./cli/commands/migrate.ts";
import { preflight } from "./core/preflight.ts";
import { runEnhance } from "./features/enhance/index.ts";
import { runImporter } from "./features/openapi/index.ts";
import { dispatchProxyCommand } from "./features/proxy/cli.ts";
import { launch } from "./index.ts";

const MOCKSTAR_VERSION = "0.1.0-alpha.1";

interface ParsedArgs {
  command: "serve" | "import" | "enhance" | "migrate" | "init" | "proxy" | "help" | "version";
  proxyArgs?: readonly string[];
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
  enhanceDir?: string;
  dryRun?: boolean;
  migrateSchema?: boolean;
  migrateFrom?: string;
  migrateTo?: string;
  migrateDir?: string;
  initDir?: string;
  force?: boolean;
  // RT-10, B5: server flag that gates the X-Mockstar-Webhook-Url channel (TN5). Default false.
  allowWebhookUrlHeader?: boolean;
  // RT-10, T2: optional path for an append-only webhook delivery log (post-restart replay).
  webhookJournalFile?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [head, ...rest] = argv;
  if (!head || head === "--help" || head === "-h" || head === "help") return { command: "help" };
  if (head === "--version" || head === "-v" || head === "version") return { command: "version" };
  if (head === "proxy") {
    return { command: "proxy", proxyArgs: rest };
  }
  if (head === "import") {
    const specPath = rest[0];
    const outDir = rest.find((r, i) => i > 0 && !r.startsWith("-")) ?? "./mocks";
    return {
      command: "import",
      specPath,
      outDir,
      tenantName: rest.find((r) => r.startsWith("--tenant="))?.slice("--tenant=".length),
      allowPrivate: rest.includes("--allow-private"),
    };
  }
  if (head === "enhance") {
    const enhanceDir = rest.find((r) => !r.startsWith("-"));
    return {
      command: "enhance",
      enhanceDir,
      specPath: getFlag(rest, "--spec"),
      dryRun: rest.includes("--dry-run"),
    };
  }
  if (head === "init") {
    const initDir = rest.find((r) => !r.startsWith("-"));
    return {
      command: "init",
      initDir: initDir ?? ".",
      force: rest.includes("--force"),
    };
  }
  if (head === "migrate") {
    const migrateDir = rest.find((r) => !r.startsWith("-"));
    return {
      command: "migrate",
      migrateSchema: rest.includes("--schema"),
      migrateFrom: getFlag(rest, "--from"),
      migrateTo: getFlag(rest, "--to"),
      migrateDir,
      dryRun: rest.includes("--dry-run"),
    };
  }
  // Default: serve from positional config root.
  const configRoot = head.startsWith("-") ? "./mocks" : head;
  return {
    command: "serve",
    configRoot,
    handlersDir: getFlag(rest, "--handlers"),
    port: Number.parseInt(getFlag(rest, "--port") ?? process.env.MOCKSTAR_PORT ?? "3000", 10),
    host: getFlag(rest, "--host") ?? process.env.MOCKSTAR_HOST ?? "127.0.0.1",
    deterministic: rest.includes("--deterministic") || process.env.MOCKSTAR_DETERMINISTIC === "1",
    watch: !rest.includes("--no-watch"),
    // B5/TN5: defaults OFF; admin must explicitly enable to honour X-Mockstar-Webhook-Url.
    allowWebhookUrlHeader:
      rest.includes("--allow-webhook-url-header") || process.env.MOCKSTAR_ALLOW_WEBHOOK_URL_HEADER === "1",
    webhookJournalFile: getFlag(rest, "--webhook-journal-file"),
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

  if (args.command === "help" || args.command === "version") {
    if (args.command === "version") {
      process.stdout.write(`mockstar ${MOCKSTAR_VERSION}\n`);
      return 0;
    }
    process.stdout.write(usage());
    return 0;
  }

  if (args.command === "proxy") {
    return dispatchProxyCommand(args.proxyArgs ?? []);
  }

  if (args.command === "import") {
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

  if (args.command === "init") {
    const result = await runInit({
      dir: resolve(args.initDir ?? "."),
      minorTag: minorTagFromVersion(MOCKSTAR_VERSION),
      force: args.force ?? false,
    });
    for (const path of result.created) process.stdout.write(`created ${path}\n`);
    for (const path of result.skipped) {
      process.stdout.write(`skipped ${path} (already exists; pass --force to overwrite)\n`);
    }
    process.stdout.write("\nNext: bunx mockstar ./mocks\n");
    return 0;
  }

  if (args.command === "migrate") {
    if (!args.migrateSchema) {
      process.stderr.write("mockstar migrate currently only supports --schema.\n");
      process.stderr.write(usage());
      return 2;
    }
    if (!args.migrateFrom || !args.migrateTo || !args.migrateDir) {
      process.stderr.write(
        "mockstar migrate --schema requires --from <minor>, --to <minor>, and a target directory.\n",
      );
      return 2;
    }
    const result = await runMigrateSchema({
      dir: resolve(args.migrateDir),
      from: args.migrateFrom,
      to: args.migrateTo,
      dryRun: args.dryRun ?? false,
    });
    const suffix = args.dryRun ? " (dry-run)" : "";
    process.stdout.write(
      `migrate --schema: rewrote ${result.filesChanged}/${result.filesScanned} files${suffix}\n`,
    );
    if (result.mismatched.length > 0) {
      process.stderr.write(
        `warning: ${result.mismatched.length} files had an unexpected $schema URL (not --from):\n`,
      );
      for (const path of result.mismatched) process.stderr.write(`  ${path}\n`);
      return 3;
    }
    return 0;
  }

  if (args.command === "enhance") {
    if (!args.enhanceDir) {
      process.stderr.write(usage());
      return 2;
    }
    const result = await runEnhance({
      inputDir: resolve(args.enhanceDir),
      specPath: args.specPath,
      dryRun: args.dryRun,
    });
    process.stdout.write(
      `Enhanced ${result.filesChanged}/${result.filesScanned} files (${result.rewrites} rewrites)${result.warnings.length ? `\nWarnings:\n  ${result.warnings.join("\n  ")}` : ""}\n`,
    );
    return 0;
  }

  const configRoot = resolve(args.configRoot ?? "./mocks");
  const adminEnabled = Boolean(process.env.MOCKSTAR_ADMIN_TOKEN);

  const launched = await launch({
    configRoot,
    handlersDir: args.handlersDir,
    deterministic: args.deterministic ?? false,
    watch: args.watch ?? true,
    allowWebhookUrlHeader: args.allowWebhookUrlHeader,
    webhookJournalFile: args.webhookJournalFile,
    server: {
      host: args.host ?? "127.0.0.1",
      port: args.port ?? 3000,
      adminEnabled,
      rootToken: process.env.MOCKSTAR_ADMIN_TOKEN,
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: Bun global
  const serve = (globalThis as any).Bun?.serve;
  if (!serve) {
    process.stderr.write(
      "Mockstar CLI requires the Bun runtime (https://bun.sh). Use library embed otherwise.\n",
    );
    return 1;
  }
  const bunServer = serve({
    hostname: args.host ?? "127.0.0.1",
    port: args.port ?? 3000,
    fetch: launched.server.hono.fetch,
  }) as { hostname: string; port: number };
  process.stdout.write(
    `mockstar listening on http://${bunServer.hostname}:${bunServer.port} (config: ${configRoot}, deterministic=${args.deterministic ?? false}, admin=${adminEnabled})\n`,
  );

  // Keep process alive; Bun.serve already holds the event loop. Still handle SIGTERM for orchestrators.
  process.on("SIGTERM", () => {
    void launched.stop().then(() => process.exit(0));
  });
  return 0;
}

function usage(): string {
  return `${[
    "mockstar <command> [options]",
    "",
    "Commands:",
    "  init [dir]                  Scaffold a starter mocks/ + mockstar.config.json",
    "  serve [config-root]         Start the mock server (default command)",
    "  import <spec> <out-dir>     Convert an OpenAPI 3.x spec to Mockstar JSON",
    "  enhance <mocks-dir>         Rewrite imported mocks with Tier 2 placeholders",
    "  migrate --schema <mocks-dir> --from <minor> --to <minor>",
    "                              Rewrite $schema URLs when bumping a minor",
    "  proxy <install|start|...>   Run the HTTPS transparent upstream proxy (tier1)",
    "  help                        Show this help",
    "  version                     Print version",
    "",
    "Serve options:",
    "  --handlers <path>           Path to handlers directory (default ../handlers)",
    "  --port <port>               Listen port (default 3000; env: MOCKSTAR_PORT)",
    "  --host <host>               Bind host (default 127.0.0.1; env: MOCKSTAR_HOST)",
    "  --deterministic             Enable CI deterministic mode",
    "  --no-watch                  Disable file-watch hot reload",
    "  --allow-webhook-url-header  Honour X-Mockstar-Webhook-Url request header (TN5; default off)",
    "  --webhook-journal-file <p>  Append-only log of webhook deliveries for post-restart replay",
    "",
    "Env:",
    "  MOCKSTAR_ADMIN_TOKEN                Root admin token (enables /metrics)",
    "  MOCKSTAR_ALLOW_WEBHOOK_URL_HEADER   Set to 1 to honour the header URL channel (B5)",
    "",
  ].join("\n")}\n`;
}

// Entry point. Bun executes this file directly via bunx.
void main().then((code) => {
  if (code !== 0) process.exit(code);
});
