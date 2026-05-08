// Satisfies: T11 (mockstar proxy {install|start|uninstall|status|reload} subcommand)
// Satisfies: U1, U2, U3, U4, U5
//
// Dispatched from src/cli.ts when the user invokes `mockstar proxy ...`.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, platform, userInfo, hostname as osHostname } from "node:os";
import { join, resolve } from "node:path";
import {
  appendStep,
  atomicInstall,
  buildDnsMutations,
  buildSnapshot,
  caFacts,
  detectEnvHostility,
  enforceKeyPermissions,
  executeReverse,
  installCa,
  isPlatformSupported,
  journalFacts,
  loadConfigFile,
  nodeExtraCaCertsMessage,
  parseConfig,
  portBindMutation,
  probeMockstarHealth,
  remediationMessage,
  reverseSteps,
  clearJournal,
  startProxyServer,
  type Mutation,
  type ProxyConfig,
} from "./index.ts";
import { ProxyError } from "./types.ts";

// --- PUBLIC ENTRY --------------------------------------------------------

export async function dispatchProxyCommand(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "help") {
    process.stdout.write(proxyHelp());
    return 0;
  }
  switch (sub) {
    case "install":
      return install(rest);
    case "uninstall":
      return uninstall(rest);
    case "start":
      return start(rest);
    case "reload":
      return reload(rest);
    case "status":
      return status(rest);
    default:
      process.stderr.write(`Unknown proxy subcommand: ${sub}\n\n${proxyHelp()}`);
      return 2;
  }
}

// --- SUBCOMMANDS ---------------------------------------------------------

async function install(argv: readonly string[]): Promise<number> {
  const force = argv.includes("--force");
  const dnsModeOverride = pickFlag(argv, "--dns-mode");
  const configPathOverride = pickFlag(argv, "--config");
  const configPath = configPathOverride ? resolve(configPathOverride) : defaultConfigPath();
  const journalPath = defaultJournalPath();

  if (!isPlatformSupported()) {
    process.stderr.write(`mockstar proxy is supported on macOS + Linux in v1. Got: ${platform()}\n`);
    return 1;
  }

  // Env hostility detection (U5).
  const hostility = await detectEnvHostility();
  if (hostility.kind !== "clean") {
    process.stderr.write(`Environment check: ${hostility.kind}\n`);
    process.stderr.write(`${remediationMessage(hostility)}\n\n`);
    if (!force && hostility.kind === "containerized-or-ci") {
      return 3; // S4 refusal
    }
    if (!force) {
      process.stderr.write(`Re-run with --force to proceed anyway.\n`);
      return 3;
    }
  }

  // If user supplied no config, write an example one they can edit.
  let config: ProxyConfig;
  try {
    config = await loadConfigFile(configPath);
  } catch {
    await writeExampleConfig(configPath, dnsModeOverride);
    process.stdout.write(`Created example config at ${configPath}; please edit and re-run.\n`);
    return 0;
  }

  // Ensure journal dir exists.
  await mkdir(join(homedir(), ".mockstar"), { recursive: true });

  // Build the install mutation list.
  const mutations: Mutation[] = [];

  // Step 1 — mkcert -install.
  mutations.push({
    action: `mkcert -install (local CA: ${scopedName()})`,
    reverseCommand: { kind: "mkcert_uninstall" },
    async apply(): Promise<void> {
      await installCa();
      const paths = (await caFacts({ user: userInfo().username, hostname: osHostname() })).paths;
      await enforceKeyPermissions(paths);
    },
  });

  // Step 2 — DNS strategy.
  mutations.push(...(await buildDnsMutations(config)));

  // Step 3 — Port 443 binding capability.
  mutations.push(
    portBindMutation({
      binaryPath: process.argv[0] ?? "/usr/bin/env",
    }),
  );

  try {
    const { applied } = await atomicInstall(journalPath, mutations, {
      onStep: (step) => process.stdout.write(`  [${step.step}] ${step.action}\n`),
    });
    // Success banner.
    const facts = await caFacts({ user: userInfo().username, hostname: osHostname() });
    process.stdout.write(`\nmockstar proxy installed (${applied.length} mutations journaled).\n`);
    process.stdout.write(`Dev CA: ${facts.commonName}\n`);
    process.stdout.write(`Config: ${configPath}\n`);
    process.stdout.write(`Journal: ${journalPath}\n\n`);
    process.stdout.write(`${nodeExtraCaCertsMessage(facts.paths)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`\nInstall failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`Mutations rolled back (atomic install). See ${journalPath}\n`);
    return 1;
  }
}

async function uninstall(_argv: readonly string[]): Promise<number> {
  const journalPath = defaultJournalPath();
  const facts = await journalFacts(journalPath);
  if (!facts.exists) {
    process.stdout.write(`No install journal found at ${journalPath} — nothing to do.\n`);
    return 0;
  }
  if (facts.corrupt) {
    process.stderr.write(`Journal corrupt at ${journalPath}. See docs/PROXY-RECOVERY.md.\n`);
    return 4;
  }

  let reversed = 0;
  for await (const step of reverseSteps(journalPath)) {
    try {
      await executeReverse(step.reverseCommand);
      process.stdout.write(`  [reverse ${step.step}] ${step.action}\n`);
      reversed += 1;
    } catch (err) {
      process.stderr.write(
        `  [reverse ${step.step}] FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.stderr.write(`Aborting uninstall; run again after resolving the failed step.\n`);
      return 5;
    }
  }
  await clearJournal(journalPath);
  process.stdout.write(`\nmockstar proxy uninstalled (${reversed} mutations reversed).\n`);
  return 0;
}

async function start(argv: readonly string[]): Promise<number> {
  const configPath = pickFlag(argv, "--config") ?? defaultConfigPath();
  const config = await loadConfigFile(resolve(configPath));

  // Quick sanity: CA must be installed (RT-1 binding — fail fast if not).
  const facts = await caFacts({ user: userInfo().username, hostname: osHostname() });
  if (!facts.installed) {
    process.stderr.write(
      `Local CA not installed. Run 'mockstar proxy install' first.\n` +
        `Looked for ${facts.paths.rootCertPem} + ${facts.paths.rootKeyPem}.\n`,
    );
    return 6;
  }

  const runtime = await startProxyServer({ configPath, config, watch: true });
  process.stdout.write(`mockstar-proxy listening on ${runtime.server.url}\n`);
  process.stdout.write(`  upstream: ${config.mockstarUrl}\n`);
  process.stdout.write(`  hosts:    ${config.hosts.map((h) => h.host).join(", ")}\n`);
  process.on("SIGTERM", () => {
    void runtime.stop().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void runtime.stop().then(() => process.exit(0));
  });
  return 0;
}

async function reload(_argv: readonly string[]): Promise<number> {
  process.stdout.write(
    `Proxy reloads automatically on config file changes (file-watch). ` +
      `To force a reload, touch the config file.\n`,
  );
  return 0;
}

async function status(argv: readonly string[]): Promise<number> {
  const configPath = pickFlag(argv, "--config") ?? defaultConfigPath();
  const journalPath = defaultJournalPath();

  const [caF, journalF, configExists] = await Promise.all([
    caFacts({ user: userInfo().username, hostname: osHostname() }).catch(() => null),
    journalFacts(journalPath),
    stat(configPath)
      .then(() => true)
      .catch(() => false),
  ]);

  process.stdout.write(`mockstar-proxy status\n`);
  process.stdout.write(`  CA installed:     ${caF?.installed ? "yes" : "no"}\n`);
  process.stdout.write(`  CA common name:   ${caF?.commonName ?? "(unknown)"}\n`);
  process.stdout.write(`  CAROOT:           ${caF?.paths.caRoot ?? "(unknown)"}\n`);
  process.stdout.write(`  Config:           ${configExists ? configPath : "(missing)"}\n`);
  process.stdout.write(
    `  Journal:          ${journalF.exists ? `${journalPath} (${journalF.stepCount} steps${journalF.corrupt ? ", CORRUPT" : ""})` : "(none)"}\n`,
  );

  if (configExists) {
    try {
      const config = await loadConfigFile(configPath);
      const mockstarOk = await probeMockstarHealth(config);
      process.stdout.write(
        `  Upstream:         ${config.mockstarUrl} (${mockstarOk ? "reachable" : "UNREACHABLE"})\n`,
      );
      process.stdout.write(`  DNS mode:         ${config.dnsMode}\n`);
      process.stdout.write(`  Hosts (${config.hosts.length}):\n`);
      for (const h of config.hosts) {
        process.stdout.write(`    - ${h.host} -> ${h.tenant}\n`);
      }
    } catch (err) {
      process.stdout.write(
        `  Config load:      FAILED (${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  }
  return 0;
}

// --- HELPERS -------------------------------------------------------------

function defaultConfigPath(): string {
  return join(homedir(), ".mockstar", "proxy.json");
}

function defaultJournalPath(): string {
  return join(homedir(), ".mockstar", "install-state.json");
}

function pickFlag(args: readonly string[], name: string): string | undefined {
  const prefixed = args.find((a) => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function scopedName(): string {
  return `mockstar-dev-ca-${userInfo().username}@${osHostname()}`;
}

async function writeExampleConfig(path: string, dnsModeOverride: string | undefined): Promise<void> {
  await mkdir(join(homedir(), ".mockstar"), { recursive: true });
  const example: unknown = parseConfig({
    hosts: [{ host: "api.razorpay.com", tenant: "razorpay" }],
    mockstarUrl: "http://127.0.0.1:3000",
    dnsMode: dnsModeOverride === "hosts" ? "hosts-fallback" : "dnsmasq",
  });
  await writeFile(path, JSON.stringify(example, null, 2) + "\n", "utf8");
}

function proxyHelp(): string {
  return [
    "mockstar proxy <subcommand> [options]",
    "",
    "Subcommands:",
    "  install               Install local CA + DNS + port-443 capability; journaled for clean uninstall.",
    "                        Flags: --force, --dns-mode=<dnsmasq|hosts>, --config=<path>",
    "  uninstall             Reverse every journaled install mutation (LIFO).",
    "  start                 Run the HTTPS proxy (requires prior install).",
    "                        Flags: --config=<path>",
    "  reload                Describe how hot-reload works (it is automatic on config file change).",
    "  status                Show CA, config, journal, upstream, and hosts.",
    "                        Flags: --config=<path>",
    "",
    "Config (default ~/.mockstar/proxy.json):",
    '  { "hosts": [{ "host": "api.razorpay.com", "tenant": "razorpay" }], "mockstarUrl": "http://127.0.0.1:3000" }',
    "",
    "Docs: docs/PROXY.md  |  Recovery: docs/PROXY-RECOVERY.md",
    "",
  ].join("\n");
}
