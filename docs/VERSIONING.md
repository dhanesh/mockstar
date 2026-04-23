# Versioning

> **Satisfies:** RT-17 (versioning contract is explicit and compatible with the dual-URL schema hosting contract in RT-2)

Mockstar follows **Semantic Versioning** (`MAJOR.MINOR.PATCH`) with a few
project-specific clarifications.

## What each bump means

| Bump | Meaning for users | Meaning for the schema URL |
|------|-------------------|----------------------------|
| **Patch** (`0.1.0` → `0.1.1`) | Bug fixes only. Must be drop-in. | `v0.1/mock.json` is unchanged |
| **Minor** (`0.1.x` → `0.2.0`) | New features; **may** break mocks-file consumers | A new `schemas.mockstar.dev/v0.2/mock.json` is published |
| **Major** (`0.x` → `1.0.0`) | Explicit breaking-change milestone | A new `v1/` tree starts alongside `v0/` |

## Pre-1.0 qualifier

While we're in `0.x`, minor bumps MAY break published mocks files. That's
Kent Beck's semver-for-early-projects reading, and it matches `$schema` URL
immutability: if a shape change is needed, we bump the minor and publish a
new immutable `v0.N/mock.json` rather than silently mutating `v0.M`. See
[docs/SCHEMA-HOSTING.md](./SCHEMA-HOSTING.md).

## Pre-releases

Tags with the shape `v<X>.<Y>.<Z>-<alpha|beta|rc>.<N>` are pre-releases. They:

- **Do** get published to npm as `npm install mockstar@alpha` (or `@beta`, `@rc`).
- **Do** get cosign signatures and Sigstore provenance.
- **Do NOT** get SLSA Level 3 provenance (TN1 resolution — we don't want to
  proliferate TUF root-of-trust material for unsupported builds).
- **Do NOT** move the `@latest` npm dist-tag.

## What counts as "breaking" for a mocks file

A breaking change requires a **minor bump** while pre-1.0 (and a **major
bump** at and after 1.0):

- Removing or renaming a field in a mock entry.
- Tightening validation (e.g. making an optional field required, adding a
  regex constraint).
- Changing the discriminator value of a response kind.
- Changing the semantics of a template helper (e.g. `{{faker.uuid}}` now
  returns a v7 UUID instead of v4).

NON-breaking changes, safely shipped as patches:

- Adding an optional field.
- Loosening validation (widening an enum, removing a regex).
- Adding a new `response.kind` variant (existing configs still validate).
- Adding a new `faker.*` template.

## What counts as breaking for the library embed

The library embed (`import { launch } from 'mockstar'`) follows normal
TypeScript-shop semver. Removing or narrowing a public export's type is a
breaking change. Widening an accepted union type is NOT.

## Deprecation policy

A deprecated field lives through **one** minor release before removal. For
example:

- `0.3.0` — field `foo` added.
- `0.4.0` — field `foo` marked deprecated in JSON Schema (`"deprecated": true`).
- `0.5.0` — field `foo` removed. A [minor release note](../CHANGELOG.md) and
  a `mockstar migrate --schema` entry are required.

## Release identification at runtime

- `mockstar --version` prints the package version.
- The container image's OCI labels include `org.opencontainers.image.version`
  and `org.opencontainers.image.revision` (commit SHA).
- The library embed exposes `package.json`'s `version` via its `exports`
  map (`import pkg from 'mockstar/package.json'` with an `assert` type).

## When to revisit

- When we ship `1.0.0`. At that point pre-1.0 minor-break latitude ends.
- When we add additional supported release channels (e.g. LTS).
- When we deprecate Bun 1.x (out of scope for 0.x).
