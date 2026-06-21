// Satisfies: RT-15 (bun test — the fast path, no transform layer)

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch } from '@dhanesh/mockstar';
import { resolve } from 'node:path';

let stop: (() => Promise<void>) | undefined;
let fetchFn!: (req: Request) => Response | Promise<Response>;

beforeAll(async () => {
  const launched = await launch({
    configRoot: resolve(import.meta.dir, 'mocks'),
    deterministic: true,
    watch: false,
  });
  stop = launched.stop;
  fetchFn = launched.server.hono.fetch;
});

afterAll(async () => {
  if (stop) await stop();
});

test('GET /hello returns the scaffolded body', async () => {
  const res = await fetchFn(new Request('http://test.local/hello'));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { message: string };
  expect(json.message).toBe('Hello from mockstar');
});
