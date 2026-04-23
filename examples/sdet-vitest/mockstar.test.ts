// Satisfies: RT-15 (Vitest — native ESM, no transform layer)

import { afterAll, beforeAll, expect, test } from 'vitest';
import { launch } from 'mockstar';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let stop: (() => Promise<void>) | undefined;
let fetchFn!: (req: Request) => Response | Promise<Response>;

beforeAll(async () => {
  const launched = await launch({
    configRoot: resolve(__dirname, 'mocks'),
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
