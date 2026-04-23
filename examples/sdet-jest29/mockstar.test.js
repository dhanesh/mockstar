// Satisfies: RT-15 (Jest 29 via babel-jest transform for the ESM import)

import { launch } from 'mockstar';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let stop;
let fetchFn;

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
  const json = await res.json();
  expect(json.message).toBe('Hello from mockstar');
});
