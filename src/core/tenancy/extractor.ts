// Satisfies: RT-4 (tenant routing is first, atomic, immutable)
// Satisfies: S1 (hard tenant isolation — tenancy is the first routing step)
// Satisfies: S2 (three configurable tenant-identification modes)

import type { Context, MiddlewareHandler } from 'hono';
import type { TenancyModeT } from '../config/schema.ts';

// Hono Context variable augmentation is declared once in src/server.ts.

export class MissingTenantError extends Error {
  constructor(public readonly mode: TenancyModeT) {
    super(`Tenant could not be determined via ${mode} mode`);
    this.name = 'MissingTenantError';
  }
}

const TENANT_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export interface TenancyOptions {
  modes: readonly TenancyModeT[];
  /** When true, respond 400 if no tenant can be extracted. Otherwise rewrite to 'default'. */
  strict?: boolean;
}

/**
 * The first middleware in the chain. Extracts tenant identity exactly once
 * and attaches it to the request context. Downstream code reads only
 * `ctx.var.tenant` (RT-4.1, RT-4.2).
 */
export function tenantMiddleware(opts: TenancyOptions): MiddlewareHandler {
  return async (ctx, next) => {
    const tenant = extract(ctx, opts.modes);
    if (!tenant) {
      if (opts.strict) {
        return ctx.json({ error: 'missing_tenant', modes: opts.modes }, 400);
      }
      ctx.set('tenant', 'default');
    } else {
      if (!TENANT_REGEX.test(tenant)) {
        return ctx.json({ error: 'invalid_tenant', tenant }, 400);
      }
      ctx.set('tenant', tenant);
    }
    await next();
  };
}

function extract(ctx: Context, modes: readonly TenancyModeT[]): string | null {
  for (const mode of modes) {
    if (mode === 'path') {
      const match = ctx.req.path.match(/^\/t\/([^/]+)(\/|$)/);
      if (match?.[1]) {
        // Rewrite the request path to strip the /t/{tenant} prefix for downstream routing.
        // Hono allows us to mutate via ctx.req.raw's URL; we store both to preserve original.
        ctx.set('originalPath', ctx.req.path);
        ctx.set('tenantStrippedPath', ctx.req.path.replace(/^\/t\/[^/]+/, '') || '/');
        return match[1];
      }
    } else if (mode === 'subdomain') {
      // G5 fix: prefer URL's hostname (always present, set from the request URL).
      // The Host header is not reliable in every environment \u2014 e.g. Hono's in-memory
      // `.request(url)` constructs a Request from a URL string without populating Host.
      let bareHost = '';
      try {
        bareHost = new URL(ctx.req.url).hostname;
      } catch {
        bareHost = (ctx.req.header('host') ?? '').split(':')[0] ?? '';
      }
      const firstDot = bareHost.indexOf('.');
      if (firstDot > 0) {
        const sub = bareHost.slice(0, firstDot);
        if (sub && sub !== 'www') return sub;
      }
    } else if (mode === 'header') {
      const v = ctx.req.header('x-mockstar-tenant');
      if (v) return v;
    }
  }
  return null;
}

/** Read the effective path for route matching (after /t/{tenant} stripping, if any). */
export function effectivePath(ctx: Context): string {
  return ctx.var.tenantStrippedPath ?? ctx.req.path;
}
