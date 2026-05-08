// Satisfies: RT-7 (two-tier admin auth)
// Satisfies: S3 (admin token w/ constant-time compare), S1 (tenant scope enforced)

import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { ConfigSnapshot } from "../../core/config/snapshot.ts";

export type AdminScope = "tenant" | "root";

export interface AdminAuthContext {
  scope: AdminScope;
  tenant: string | null; // null for root-scope access
}

export interface AdminAuthOptions {
  snapshot: () => ConfigSnapshot;
  /** Which scope this endpoint accepts — tenant means tenant-scoped tokens only. */
  scope: AdminScope;
}

/**
 * Middleware producing 401 on missing/bad token, 403 on correct-but-wrong-scope.
 * Populates `ctx.var.adminAuth` for downstream handlers.
 */
export function adminAuthMiddleware(opts: AdminAuthOptions): MiddlewareHandler {
  return async (ctx, next) => {
    const snapshot = opts.snapshot();
    if (!snapshot.server.adminEnabled) {
      return ctx.json({ error: "admin_disabled" }, 404);
    }

    const provided = bearerOf(ctx.req.header("authorization") ?? "");
    if (!provided) return ctx.json({ error: "missing_token" }, 401);

    // Tenant context — admin routes conventionally live at /__admin/tenants/{t}/...
    const urlTenant = extractTenantFromAdminPath(ctx.req.path);

    // Try tenant-scoped token first (most common path).
    if (urlTenant) {
      const tenantSnap = snapshot.tenants.get(urlTenant);
      if (tenantSnap?.adminToken && constantTimeEquals(provided, tenantSnap.adminToken)) {
        if (opts.scope === "tenant" || opts.scope === "root") {
          ctx.set("adminAuth", { scope: "tenant", tenant: urlTenant });
          return next();
        }
      }
    }

    // Fall back to root token — never valid for tenant-scoped endpoints' tenant view.
    if (snapshot.server.rootToken && constantTimeEquals(provided, snapshot.server.rootToken)) {
      if (opts.scope === "root") {
        ctx.set("adminAuth", { scope: "root", tenant: null });
        return next();
      }
      // Root token presented at tenant-scoped endpoint — 403 per TN5 spec.
      return ctx.json({ error: "root_token_cannot_access_tenant_scope" }, 403);
    }

    return ctx.json({ error: "invalid_token" }, 401);
  };
}

function bearerOf(header: string): string | null {
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const raw = header.slice(7).trim();
  return raw.length === 0 ? null : raw;
}

function extractTenantFromAdminPath(path: string): string | null {
  const m = path.match(/^\/__admin\/tenants\/([^/]+)(\/|$)/);
  return m?.[1] ?? null;
}

export function constantTimeEquals(a: string, b: string): boolean {
  // Equalize lengths to avoid timing leak on size mismatch.
  const len = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(len, 0);
  const bufB = Buffer.alloc(len, 0);
  bufA.write(a);
  bufB.write(b);
  let equal = false;
  try {
    equal = timingSafeEqual(bufA, bufB);
  } catch {
    equal = false;
  }
  return equal && a.length === b.length;
}
