#!/usr/bin/env bun
// Satisfies: U2 (bunx / npm distribution channel)
// Satisfies: T4 (boot time target applies to this path)

import { resolve } from "node:path";
import { parseArgs, usage } from "./cli/args.ts";
import { minorTagFromVersion, runInit } from "./cli/commands/init.ts";
import { runMigrateSchema } from "./cli/commands/migrate.ts";
import { preflight } from "./core/preflight.ts";
import { runEnhance } from "./features/enhance/index.ts";
import { runImporter } from "./features/openapi/index.ts";
import { dispatchProxyCommand } from "./features/proxy/cli.ts";
import { launch } from "./index.ts";
import { MOCKSTAR_VERSION } from "./version.ts";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.error) {
    process.stderr.write(`mockstar: ${args.error}\n`);
    return 2;
  }

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
    process.stdout.write("\nNext: bunx @dhaneshpurohit/mockstar ./mocks\n");
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
      ...(args.tenancyModes && { tenancyModes: args.tenancyModes }),
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

// Entry point. Bun executes this file directly via bunx.
void main().then((code) => {
  if (code !== 0) process.exit(code);
});
