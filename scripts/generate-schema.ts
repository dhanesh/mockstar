#!/usr/bin/env bun
// Satisfies: RT-2 (dual-URL JSON Schema hosting — generate artifact)
//
// Generates JSON Schema for the MocksFile root type and writes it to
// `schema/mock.json`. The CI workflow (`.github/workflows/schema-publish.yml`)
// copies this under two paths on GitHub Pages:
//
//   https://schemas.mockstar.dev/v0/mock.json       (rolling minor, latest v0.x)
//   https://schemas.mockstar.dev/v0.<N>/mock.json   (pinned minor — immutable)
//
// See docs/SCHEMA-HOSTING.md for the full contract.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { MocksFile } from '../src/core/config/schema.ts';

const pkg = (await Bun.file(resolve(import.meta.dir, '..', 'package.json')).json()) as {
  version: string;
};

// Derive the minor version tag (v0.1, v0.2, ...) — schema URL is keyed on
// MAJOR.MINOR, not patch. A prerelease (e.g. 0.1.0-rc.1) still pins to v0.1.
const [major, minor] = pkg.version.split('.');
const minorTag = `v${major}.${minor}`;
const majorTag = `v${major}`;

const schema = zodToJsonSchema(MocksFile, {
  $refStrategy: 'none',
  target: 'jsonSchema7',
});

// The $id encodes the minor URL so tools can detect drift between file and
// declared schema version.
const envelope = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: `https://schemas.mockstar.dev/${minorTag}/mock.json`,
  title: `Mockstar mocks file (${minorTag})`,
  description:
    'Root schema for a Mockstar mocks file. This URL pins to the matching minor version of mockstar — see docs/SCHEMA-HOSTING.md for the versioning contract.',
  ...schema,
};

const outDir = resolve(import.meta.dir, '..', 'schema');
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'mock.json'), `${JSON.stringify(envelope, null, 2)}\n`);
await writeFile(
  resolve(outDir, 'VERSION'),
  `${majorTag}\n${minorTag}\n${pkg.version}\n`,
);

process.stdout.write(`wrote schema/mock.json (${minorTag}, from package ${pkg.version})\n`);
