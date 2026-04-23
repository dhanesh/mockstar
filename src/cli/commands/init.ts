// Satisfies: RT-14 (mockstar init scaffolds a zero-config starter tree)
//
// `mockstar init [dir]` drops:
//   <dir>/mocks/example.json        — a starter mock, with $schema pinned to the minor
//   <dir>/mockstar.config.json      — empty-but-valid config (documents the shape)
//
// Goal: the full "Dev" persona quickstart path is `bunx mockstar init &&
// bunx mockstar ./mocks` in under 5 minutes (RT-13). Keeping init synchronous
// and I/O-light is load-bearing for that budget.

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SCHEMA_HOST = 'https://schemas.mockstar.dev';

export interface InitOptions {
  readonly dir: string;
  readonly minorTag: string; // e.g. "v0.1" — comes from package.json version at runtime
  readonly force: boolean;
}

export interface InitResult {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}

const STARTER_MOCKS = (minor: string) =>
  JSON.stringify(
    {
      $schema: `${SCHEMA_HOST}/${minor}/mock.json`,
      mocks: [
        {
          id: 'hello',
          match: { method: 'GET', path: '/hello' },
          response: {
            kind: 'static',
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { message: 'Hello from mockstar' },
          },
        },
        {
          id: 'get-user-by-id',
          match: { method: 'GET', path: '/users/:id' },
          response: {
            kind: 'static',
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: {
              id: '{{request.params.id}}',
              name: '{{faker.name}}',
              email: '{{faker.email}}',
            },
          },
        },
      ],
    },
    null,
    2,
  ) + '\n';

const STARTER_CONFIG = JSON.stringify(
  {
    server: { host: '127.0.0.1', port: 3000 },
    tenancy: { mode: 'path' },
  },
  null,
  2,
) + '\n';

export async function runInit(options: InitOptions): Promise<InitResult> {
  const root = resolve(options.dir);
  // Loader expects ./mocks/<tenant>/*.json — scaffold into the `default`
  // tenant so `bunx mockstar ./mocks` works out of the box.
  const tenantDir = join(root, 'mocks', 'default');
  const mocksFile = join(tenantDir, 'example.json');
  const configFile = join(root, 'mockstar.config.json');

  const created: string[] = [];
  const skipped: string[] = [];

  await mkdir(tenantDir, { recursive: true });

  for (const [path, content] of [
    [mocksFile, STARTER_MOCKS(options.minorTag)],
    [configFile, STARTER_CONFIG],
  ] as const) {
    if (existsSync(path) && !options.force) {
      skipped.push(path);
      continue;
    }
    await writeFile(path, content);
    created.push(path);
  }

  return { created, skipped };
}

/** Derive the minor tag from a semver string (e.g. "0.1.0-rc.1" -> "v0.1"). */
export function minorTagFromVersion(version: string): string {
  const parts = version.split('.');
  const major = parts[0] ?? '0';
  const minor = parts[1] ?? '0';
  return `v${major}.${minor}`;
}
