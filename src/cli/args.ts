// CLI argument parsing and usage text. Kept apart from cli.ts, which runs main() on import,
// so tests can call parseArgs directly (#60).

import { TenancyMode, type TenancyModeT } from "../core/config/schema.ts";

export interface ParsedArgs {
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
  // #63: tenancy modes for serve (flag beats MOCKSTAR_TENANCY_MODES). Undefined = server default.
  tenancyModes?: TenancyModeT[];
  /** A usage error found while parsing; main() prints it and exits 2. */
  error?: string;
}

/**
 * Parse CLI argv. `env` is passed in (not read from `process.env`) so tests can pin it.
 */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParsedArgs {
  const [head, ...rest] = argv;
  if (!head || head === "--help" || head === "-h" || head === "help") return { command: "help" };
  if (head === "--version" || head === "-v" || head === "version") return { command: "version" };
  if (head === "proxy") {
    return { command: "proxy", proxyArgs: rest };
  }
  // #60: `--help` / `-h` anywhere after a subcommand prints help and does nothing else.
  // Before, `serve --help` started a server and `init --help` scaffolded into the cwd.
  // `proxy` (above) keeps its own help.
  if (rest.includes("--help") || rest.includes("-h")) return { command: "help" };
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
  // serve — the default command. Accept it BOTH explicitly (`serve [config-root]`)
  // and implicitly (`mockstar ./mocks`). When the `serve` keyword is present, strip it
  // so the first remaining token is the (optional) config root; otherwise the whole
  // argv is the serve invocation. The config root is the first token only when it isn't
  // a flag — flag values (e.g. the `4000` in `--port 4000`) are never treated as a path.
  const serveArgv = head === "serve" ? rest : argv;
  const firstPositional = serveArgv[0];
  const configRoot = !firstPositional || firstPositional.startsWith("-") ? "./mocks" : firstPositional;
  return {
    command: "serve",
    configRoot,
    handlersDir: getFlag(serveArgv, "--handlers"),
    port: Number.parseInt(getFlag(serveArgv, "--port") ?? env.MOCKSTAR_PORT ?? "3000", 10),
    host: getFlag(serveArgv, "--host") ?? env.MOCKSTAR_HOST ?? "127.0.0.1",
    deterministic: serveArgv.includes("--deterministic") || env.MOCKSTAR_DETERMINISTIC === "1",
    watch: !serveArgv.includes("--no-watch"),
    // B5/TN5: defaults OFF; admin must explicitly enable to honour X-Mockstar-Webhook-Url.
    allowWebhookUrlHeader:
      serveArgv.includes("--allow-webhook-url-header") || env.MOCKSTAR_ALLOW_WEBHOOK_URL_HEADER === "1",
    webhookJournalFile: getFlag(serveArgv, "--webhook-journal-file"),
    ...parseTenancyModes(getFlag(serveArgv, "--tenancy-modes") ?? env.MOCKSTAR_TENANCY_MODES),
  };
}

/** #63: comma-separated tenancy modes, validated against the config schema's enum. */
function parseTenancyModes(raw: string | undefined): Pick<ParsedArgs, "tenancyModes" | "error"> {
  if (raw === undefined) return {};
  const modes = raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (modes.length === 0)
    return { error: `--tenancy-modes needs at least one of: ${TenancyMode.options.join(", ")}` };
  const bad = modes.filter((m) => !TenancyMode.safeParse(m).success);
  if (bad.length > 0) {
    return { error: `unknown tenancy mode ${bad.join(", ")} (use: ${TenancyMode.options.join(", ")})` };
  }
  return { tenancyModes: modes as TenancyModeT[] };
}

export function getFlag(args: readonly string[], name: string): string | undefined {
  const prefixed = args.find((a) => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

export function usage(): string {
  return `${[
    "mockstar <command> [options]",
    "",
    "Commands:",
    "  init [dir]                  Scaffold a starter mocks/default/example.json",
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
    "  --tenancy-modes <list>      Comma list of path, header, subdomain, tried in order",
    "                              (default path,header; env: MOCKSTAR_TENANCY_MODES)",
    "  -h, --help                  Show this help (also after any command)",
    "",
    "Env:",
    "  MOCKSTAR_ADMIN_TOKEN                Root admin token (enables /metrics)",
    "  MOCKSTAR_ALLOW_WEBHOOK_URL_HEADER   Set to 1 to honour the header URL channel (B5)",
    "  MOCKSTAR_TENANCY_MODES              Same as --tenancy-modes",
    "",
  ].join("\n")}\n`;
}
