// Satisfies: RT-2 (generated schema carries a correct $id and uses the minor tag)

import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { $ } from 'bun';

const SCRIPT = resolve(import.meta.dir, '..', '..', 'scripts', 'generate-schema.ts');

describe('RT-2: generate-schema produces a minor-tagged artifact', () => {
  it('generate-schema.ts exists and is runnable', async () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const result = await $`bun run ${SCRIPT}`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
  });

  it('writes schema/mock.json with a schemas.mockstar.dev $id pinned to a minor', async () => {
    await $`bun run ${SCRIPT}`.quiet();
    const schema = (await Bun.file(resolve(import.meta.dir, '..', '..', 'schema', 'mock.json')).json()) as {
      $id: string;
      title: string;
    };
    expect(schema.$id).toMatch(/^https:\/\/schemas\.mockstar\.dev\/v0\.\d+\/mock\.json$/);
    expect(schema.title).toContain('Mockstar mocks file');
  });
});
