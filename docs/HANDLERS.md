# Named JS handlers

Dynamic mocks delegate to named functions in the `handlers/` directory. Each file exports one or more named functions; Mockstar builds a registry at boot and cross-checks every `"handler": "name"` reference against it (RT-1, T6).

## Authoring

```ts
// handlers/echo.ts
import type { Context } from 'hono';

// The package does not export a helper type yet, so declare the part you use.
// At runtime `helpers` is { tenant, requestId, faker }, and faker has the same
// methods as the `{{faker.*}}` tokens: uuid, email, name, integer, pick, boolean, dateIso.
type HandlerHelpers = {
  tenant: string;
  requestId: string;
  faker: { uuid(): string; email(): string; name(): string; integer(min: number, max: number): number };
};

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

```ts
import { describe, it, expect } from 'bun:test';
import { echo } from './echo.ts';

it('echoes the request body', async () => {
  // A fixed stub keeps the assertion stable. (The package does not export its faker factory.)
  const faker = { uuid: () => 'uuid-1', email: () => 'a@b.c', name: () => 'Ann', integer: (min: number) => min };
  const helpers = { tenant: 't1', requestId: 'r1', faker };
  const ctx = {
    req: { json: async () => ({ hello: 'world' }) },
  } as unknown as Parameters<typeof echo>[0];
  const res = await echo(ctx, helpers);
  expect(res.status).toBe(200);
});
```
