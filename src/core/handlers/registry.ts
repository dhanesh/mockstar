// Satisfies: RT-1 (handler registry exists and is cross-verified at boot)
// Satisfies: T5 (named JS handlers from handlers/ dir, no path escapes)
// Satisfies: T6 (handler-reference integrity)
// Priority: structural (blocks T6; must be loaded before config cross-check in RT-1.3)

import { readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HandlerLoadError, type HandlerRegistry, MissingHandlerError, type MockHandler } from "./types.ts";

const SUPPORTED_EXTENSIONS = [".ts", ".js", ".mjs", ".mts"];

/**
 * Discover handler modules in the configured directory and build a frozen
 * registry. Path traversal attempts (absolute paths, '..') are rejected at
 * the caller boundary — this function will throw if asked to load a file
 * outside `handlersDir`.
 *
 * Satisfies RT-1.1, RT-1.2.
 */
export async function buildHandlerRegistry(handlersDir: string): Promise<HandlerRegistry> {
  const absDir = resolve(handlersDir);
  const entries = await discoverFiles(absDir);
  const map = new Map<string, MockHandler>();

  for (const file of entries) {
    // Defence in depth: refuse any file that escaped the handlers directory.
    const rel = relative(absDir, file);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new HandlerLoadError(
        file,
        new Error(`Handler file '${file}' is outside the handlers directory '${absDir}'`),
      );
    }

    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (err) {
      throw new HandlerLoadError(file, err);
    }

    for (const [name, value] of Object.entries(mod)) {
      if (name === "default" || typeof value !== "function") continue;
      if (map.has(name)) {
        throw new HandlerLoadError(
          file,
          new Error(
            `Handler '${name}' already registered from a previous file; names must be unique across handlers/`,
          ),
        );
      }
      map.set(name, value as MockHandler);
    }
  }

  return freezeRegistry(map);
}

async function discoverFiles(dir: string): Promise<string[]> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return [];
  } catch {
    // Missing handlers/ directory is valid — the user may have no dynamic handlers.
    return [];
  }

  const out: string[] = [];
  const queue: string[] = [dir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const names = await readdir(current, { withFileTypes: true });
    for (const entry of names) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (entry.isFile() && hasSupportedExtension(entry.name)) {
        out.push(full);
      }
    }
  }
  out.sort(); // deterministic load order for RT-12 (deterministic mode)
  return out;
}

function hasSupportedExtension(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

function freezeRegistry(map: Map<string, MockHandler>): HandlerRegistry {
  const names = [...map.keys()].sort();
  return Object.freeze({
    get size() {
      return map.size;
    },
    has: (name: string): boolean => map.has(name),
    get: (name: string): MockHandler | undefined => map.get(name),
    names: (): readonly string[] => names,
  });
}

/**
 * Cross-check: every handler reference in `references` must resolve to a
 * loaded handler, otherwise throw MissingHandlerError with every missing
 * name and its source location. Fails boot early.
 *
 * Satisfies RT-1.3, RT-1.4.
 */
export function verifyHandlerReferences(
  registry: HandlerRegistry,
  references: readonly { name: string; configPath: string }[],
): void {
  const missing = references.filter((ref) => !registry.has(ref.name));
  if (missing.length > 0) {
    throw new MissingHandlerError(missing, registry.names());
  }
}
