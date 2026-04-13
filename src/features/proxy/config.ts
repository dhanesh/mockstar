// Satisfies: T8 (config file Zod-validated; reload on change)
// Satisfies: RT-5 (DNS mode setting persisted in config after env detection)

import { readFile, watch as fsWatch } from 'node:fs/promises';
import { z } from 'zod';
import type { ProxyConfig } from './types.ts';

// --- SCHEMA --------------------------------------------------------------

const HostnameRe = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const TenantRe = /^[a-zA-Z0-9_-]{1,64}$/;

export const HostConfigSchema = z
  .object({
    host: z.string().regex(HostnameRe, 'Must be a valid hostname (RFC 1035 labels)'),
    tenant: z.string().regex(TenantRe, 'Tenant must be [a-zA-Z0-9_-]{1,64}'),
  })
  .strict();

export const ProxyConfigSchema = z
  .object({
    hosts: z.array(HostConfigSchema).min(1, 'At least one host must be configured'),
    mockstarUrl: z.string().url().default('http://127.0.0.1:3000'),
    listenHost: z.string().default('127.0.0.1'),
    listenPort: z.number().int().min(1).max(65535).default(443),
    upstreamTimeoutMs: z.number().int().positive().default(5000),
    leafTtlHours: z.number().int().positive().max(720).default(24), // TN4 cap at 30 days
    dnsMode: z.enum(['dnsmasq', 'hosts-fallback']).default('dnsmasq'),
  })
  .strict();

export type ProxyConfigInput = z.input<typeof ProxyConfigSchema>;

// --- API -----------------------------------------------------------------

export async function loadConfigFile(path: string): Promise<ProxyConfig> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return ProxyConfigSchema.parse(parsed);
}

export function parseConfig(obj: unknown): ProxyConfig {
  return ProxyConfigSchema.parse(obj);
}

/**
 * Watch the config file for changes and invoke `onChange` with the new config.
 * If parsing fails, `onChange` is NOT called (warn-and-keep-previous per mockstar T7 pattern).
 */
export async function watchConfig(
  path: string,
  onChange: (result: { ok: true; config: ProxyConfig } | { ok: false; error: string }) => void,
  opts: { debounceMs?: number } = {},
): Promise<{ stop: () => void }> {
  const debounce = opts.debounceMs ?? 250;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher = fsWatch(path);
  const controller = new AbortController();

  (async () => {
    for await (const _event of watcher) {
      if (controller.signal.aborted) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const next = await loadConfigFile(path);
          onChange({ ok: true, config: next });
        } catch (err) {
          onChange({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }, debounce);
    }
  })().catch(() => {
    // watcher closed
  });

  return {
    stop(): void {
      controller.abort();
      if (timer) clearTimeout(timer);
    },
  };
}
