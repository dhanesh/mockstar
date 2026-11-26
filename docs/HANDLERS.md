# Named JS handlers

Dynamic mocks delegate to named functions in the `handlers/` directory. Each file exports one or more named functions; Mockstar builds a registry at boot and cross-checks every `"handler": "name"` reference against it (RT-1, T6).

## Authoring

```ts
// handlers/echo.ts
import type { Context } from 'hono';
import type { HandlerHelpers } from '@dhaneshpurohit/mockstar'; // exported from 0.7.0

// `helpers` is { tenant, requestId, faker }. faker has the same methods as the
// `{{faker.*}}` tokens: uuid, email, name, integer, pick, boolean, dateIso.
export async function echo(ctx: Context, helpers: HandlerHelpers): Promise<Response> {
  const body = await ctx.req.json().catch(() => ({}));
  return Response.json({
    requestId: helpers.requestId,
    tenant: helpers.tenant,
    echoed: body,
    id: helpers.faker.uuid(),
  });
}
```

`Context` comes from `hono`, which installs with mockstar. With pnpm (strict
`node_modules`), add `hono` to your own dependencies to import its types.

Reference it in config:

```jsonc
{ "id": "echo-users", "match": { "method": "POST", "path": "/echo" },
  "response": { "kind": "dynamic", "handler": "echo" } }
```

## Rules

1. **Named exports only.** `default` is ignored — use `export function name(...)` or `export const name = ...`.
2. **Names must be globally unique** within the `handlers/` tree (boot fails otherwise).
3. **Await your promises.** Fire-and-forget rejections escape to the process-level hook and terminate the server (TN2 / RT-3). The handler-invocation timeout (default 5 s) catches stuck awaited promises.
4. **No stack traces leak to clients.** On a thrown error the client sees `{ error: "handler_fault", handler, requestId, kind }` — the stack is logged server-side only (RT-2.2).
5. **Handlers live under `handlers/`.** Absolute paths and `..` escapes are rejected at load time (S6 / T5).

## Testing a handler in isolation

Before 0.7.0 the package exported neither `HandlerHelpers` nor `createFaker`: declare the
helper type yourself and pass a stub faker.

```ts
import { it, expect } from 'bun:test';
import { createFaker } from '@dhaneshpurohit/mockstar'; // exported from 0.7.0
import { echo } from './echo.ts';

it('echoes the request body', async () => {
  // The same faker a handler gets. A fixed seed keeps the values stable.
  const helpers = { tenant: 't1', requestId: 'r1', faker: createFaker({ deterministic: true, seed: 1 }) };
  const ctx = {
    req: { json: async () => ({ hello: 'world' }) },
  } as unknown as Parameters<typeof echo>[0];
  const res = await echo(ctx, helpers);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.echoed).toEqual({ hello: 'world' });
  expect(body.id).toBe(createFaker({ deterministic: true, seed: 1 }).uuid());
});
```
