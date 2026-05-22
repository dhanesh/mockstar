#!/usr/bin/env bun
// Satisfies: U1/SDET — ship resolvable type declarations.
//
// Source uses `.ts` import specifiers (Bun-idiomatic) and the declaration build
// keeps `allowImportingTsExtensions: true`, so `tsc` emits `from "./x.ts"`. The
// published `dist/` ships `.js` + `.d.ts` only (no `.ts`), and node16/nodenext
// consumers resolve a `.js` specifier to the adjacent `.d.ts`. Without this
// rewrite a typed consumer of `mockstar` hits "Cannot find module './x.ts'".
//
// Rewrites relative `.ts` specifiers to `.js` across dist/**/*.d.ts. Bare/package
// specifiers never start with '.' so they are untouched. Only module-position
// specifiers (after `from` or `import(`) are rewritten — string-literal types
// are left alone.

import { Glob } from "bun";

const distDir = new URL("../dist/", import.meta.url).pathname;
const glob = new Glob("**/*.d.ts");

const TS_SPECIFIER = /(from\s*|import\(\s*)(['"])(\.\.?\/[^'"]*?)\.ts(['"])/g;

let filesChanged = 0;
let rewrites = 0;
for await (const rel of glob.scan(distDir)) {
  const path = distDir + rel;
  let count = 0;
  const after = (await Bun.file(path).text()).replace(
    TS_SPECIFIER,
    (_m, kw: string, q1: string, spec: string, q2: string) => {
      count++;
      return `${kw}${q1}${spec}.js${q2}`;
    },
  );
  if (count > 0) {
    await Bun.write(path, after);
    filesChanged++;
    rewrites += count;
  }
}

console.log(`fix-dts-extensions: rewrote ${rewrites} .ts→.js specifier(s) across ${filesChanged} file(s)`);
