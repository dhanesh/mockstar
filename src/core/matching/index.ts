// Satisfies: RT-6.1 (match index precomputed at config load, O(log n) first-level)
// Satisfies: T2 (rich matching), U1 (diagnostic 404 requires nearestMatch)
// Priority: binding — central to RT-6 hot path

import type { Entry } from "../config/schema.ts";
import { evaluateDiscriminators, type PredicateFailure, type RequestView } from "./discriminators.ts";
import { createNode, findPath, insertPattern, type PathMatchHit, type PathPatternNode } from "./path-trie.ts";

export interface IndexedEntry {
  entry: Entry;
  /** Position in the source list — used as a tiebreaker after priority. */
  order: number;
}

export interface MatchResult {
  entry: Entry;
  params: Record<string, string>;
}

export interface NearestMatch {
  entry: Entry;
  params: Record<string, string>;
  failure: PredicateFailure;
}

export interface MatchIndex {
  readonly size: number;
  match(method: string, path: string, req: RequestView): MatchResult | null;
  /** Candidates whose method+path matched but whose discriminators did not. Up to `limit`. */
  nearestMatch(method: string, path: string, req: RequestView, limit?: number): NearestMatch[];
}

export function buildMatchIndex(entries: readonly Entry[]): MatchIndex {
  // One trie per method (plus an 'ANY' bucket for '*').
  const byMethod = new Map<string, PathPatternNode<IndexedEntry>>();
  const wildcardMethodRoot = createNode<IndexedEntry>();

  entries.forEach((e, i) => {
    const indexed: IndexedEntry = { entry: e, order: i };
    if (e.match.method === "*") {
      insertPattern(wildcardMethodRoot, e.match.path, indexed);
      return;
    }
    let root = byMethod.get(e.match.method);
    if (!root) {
      root = createNode();
      byMethod.set(e.match.method, root);
    }
    insertPattern(root, e.match.path, indexed);
  });

  function candidates(method: string, path: string): PathMatchHit<IndexedEntry>[] {
    const upper = method.toUpperCase();
    const perMethod = byMethod.get(upper);
    const fromMethod = perMethod ? findPath(perMethod, path) : [];
    const fromAny = findPath(wildcardMethodRoot, path);
    return fromMethod.concat(fromAny);
  }

  function orderCandidates(hits: PathMatchHit<IndexedEntry>[]): PathMatchHit<IndexedEntry>[] {
    return hits.sort((a, b) => {
      const p = b.value.entry.match.priority - a.value.entry.match.priority;
      if (p !== 0) return p;
      return a.value.order - b.value.order;
    });
  }

  return Object.freeze({
    get size(): number {
      return entries.length;
    },
    match(method: string, path: string, req: RequestView): MatchResult | null {
      const hits = orderCandidates(candidates(method, path));
      for (const hit of hits) {
        const failure = evaluateDiscriminators(hit.value.entry.match, req);
        if (!failure) {
          return { entry: hit.value.entry, params: hit.params };
        }
      }
      return null;
    },
    nearestMatch(method: string, path: string, req: RequestView, limit = 3): NearestMatch[] {
      const hits = orderCandidates(candidates(method, path));
      const out: NearestMatch[] = [];
      for (const hit of hits) {
        if (out.length >= limit) break;
        const failure = evaluateDiscriminators(hit.value.entry.match, req);
        if (failure) out.push({ entry: hit.value.entry, params: hit.params, failure });
      }
      return out;
    },
  });
}
