// Satisfies: T7 (Zod-validated config), RT-5.1 (snapshot builder)
// Contributes to: RT-1.3 (handler-reference cross-check)
// Satisfies: RT-4 (snapshot builder compiles scenario rules into compiledScenarios map)

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { HandlerRegistry } from '../handlers/index.ts';
import { verifyHandlerReferences } from '../handlers/index.ts';
import { compileEntryResponses, type CompiledResponse } from '../templating/compiler.ts';
import { compileWebhookSpecs } from '../../features/webhooks/compile.ts';
import { buildMatchIndex } from '../matching/index.ts';
import { compileScenarioRules } from '../scenarios/evaluator.ts';
import type { CompiledScenario } from '../scenarios/evaluator.ts';
import { type ConfigSnapshot, type TenantSnapshot } from './snapshot.ts';
import { MockEntry, ServerConfig, TenantConfig, TenantLimits, type Entry, type Server } from './schema.ts';

export interface LoadOptions {
  configRoot: string;         // directory containing per-tenant subdirs
  server: Server;
  handlers: HandlerRegistry;
}

export async function loadSnapshot(opts: LoadOptions): Promise<ConfigSnapshot> {
  const tenantDirs = await listTenantDirs(opts.configRoot);
  const tenants = new Map<string, TenantSnapshot>();

  for (const dir of tenantDirs) {
    const tenantName = basename(dir);
    const tenantSnapshot = await loadTenant(dir, tenantName, opts.handlers);
    tenants.set(tenantName, tenantSnapshot);
  }

  if (tenants.size === 0) {
    throw new Error(`No tenant directories found under ${opts.configRoot}. Expected ./mocks/{tenant}/*.json structure.`);
  }

  return Object.freeze({
    version: 1,
    server: opts.server,
    tenants,
    handlers: opts.handlers,
  } satisfies ConfigSnapshot);
}

export async function loadTenant(
  tenantDir: string,
  name: string,
  handlers: HandlerRegistry,
): Promise<TenantSnapshot> {
  const entries: Entry[] = [];
  const referencedHandlers: { name: string; configPath: string }[] = [];

  const files = await listJsonFiles(tenantDir);
  for (const file of files) {
    const beforeCount = entries.length;
    const parsed = await readJson(file);
    // Each file may be a bare array of entries, a { mocks: [...] } object, or a TenantConfig.
    if (Array.isArray(parsed)) {
      for (const raw of parsed) {
        const entry = MockEntry.parse(raw);
        entries.push(entry);
      }
    } else if (parsed && typeof parsed === 'object' && 'mocks' in parsed) {
      const maybe = parsed as { mocks: unknown };
      if (!Array.isArray(maybe.mocks)) throw new Error(`${file}: 'mocks' must be an array`);
      for (const raw of maybe.mocks) {
        const entry = MockEntry.parse(raw);
        entries.push(entry);
      }
    } else {
      throw new Error(`${file}: expected array or { mocks: [...] } shape`);
    }

    for (const e of entries.slice(beforeCount)) {
      if (e.response.kind === 'dynamic') {
        referencedHandlers.push({ name: e.response.handler, configPath: `${file}#${e.id}` });
      }
    }
  }

  // Also look for tenant.json to override limits / adminToken / allowPrivateUpstreams.
  const tenantJson = await tryReadJson(resolve(tenantDir, 'tenant.json'));
  const tenantMeta = tenantJson
    ? TenantConfig.omit({ mocks: true }).partial({ name: true }).parse({ name, ...tenantJson })
    : { name, limits: TenantLimits.parse({}), allowPrivateUpstreams: false };

  // Cross-check handler references (RT-1.3). Boot fails here if any are missing.
  verifyHandlerReferences(handlers, referencedHandlers);

  const matchIndex = buildMatchIndex(entries);
  const compiledResponses = compileEntryResponses(entries);

  // Compile scenario rules for each entry that declares them (RT-4).
  const compiledScenarios = new Map<string, readonly CompiledScenario[]>();
  for (const entry of entries) {
    if (entry.scenarios && entry.scenarios.length > 0) {
      compiledScenarios.set(entry.id, compileScenarioRules(entry.scenarios));
    }
  }

  // Compile webhook specs for each entry that declares them (RT-8, T7).
  const compiledWebhooks = compileWebhookSpecs(entries);

  return Object.freeze({
    name,
    entries,
    matchIndex,
    compiledResponses,
    compiledScenarios,
    compiledWebhooks,
    limits: tenantMeta.limits ?? TenantLimits.parse({}),
    adminToken: tenantMeta.adminToken,
    allowPrivateUpstreams: tenantMeta.allowPrivateUpstreams ?? false,
  } satisfies TenantSnapshot);
}

async function listTenantDirs(root: string): Promise<string[]> {
  const dirEntries = await readdir(root, { withFileTypes: true });
  return dirEntries.filter((e) => e.isDirectory()).map((e) => resolve(root, e.name));
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((n) => n.endsWith('.json') && n !== 'tenant.json').map((n) => resolve(dir, n));
}

async function readJson(file: string): Promise<unknown> {
  const contents = await readFile(file, 'utf8');
  try {
    return JSON.parse(contents);
  } catch (err) {
    throw new Error(`${file}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function tryReadJson(file: string): Promise<unknown | null> {
  try {
    await stat(file);
  } catch {
    return null;
  }
  return readJson(file);
}

export const parseServerConfig = (raw: unknown): Server => ServerConfig.parse(raw ?? {});
export type { CompiledResponse };
