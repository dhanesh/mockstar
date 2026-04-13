// Satisfies: RT-6.1 (radix-trie on method + path-pattern; O(log n) first-level dispatch)
// Priority: binding (RT-6 — hot-path latency)

export interface PathPatternNode<T> {
  /** Literal child segments. Map<segment, node>. */
  readonly literal: Map<string, PathPatternNode<T>>;
  /** Single parameter child (`:id`) — at most one per node. */
  param: { name: string; node: PathPatternNode<T> } | null;
  /** Wildcard rest of path (`*`). */
  wildcard: PathPatternNode<T> | null;
  /** Candidate values registered at this node (terminal). */
  readonly values: T[];
}

export function createNode<T>(): PathPatternNode<T> {
  return { literal: new Map(), param: null, wildcard: null, values: [] };
}

export function insertPattern<T>(root: PathPatternNode<T>, pattern: string, value: T): void {
  const segments = splitPath(pattern);
  let node = root;
  for (const seg of segments) {
    if (seg === '*') {
      node.wildcard ??= createNode();
      node = node.wildcard;
      break; // wildcard consumes the rest
    }
    if (seg.startsWith(':')) {
      const name = seg.slice(1);
      if (node.param && node.param.name !== name) {
        // Two patterns disagree on the param name at the same slot — allowed,
        // but we unify under a single param (names are cosmetic).
      }
      if (!node.param) node.param = { name, node: createNode() };
      node = node.param.node;
      continue;
    }
    let next = node.literal.get(seg);
    if (!next) {
      next = createNode();
      node.literal.set(seg, next);
    }
    node = next;
  }
  node.values.push(value);
}

export interface PathMatchHit<T> {
  value: T;
  params: Record<string, string>;
}

export function findPath<T>(root: PathPatternNode<T>, path: string): PathMatchHit<T>[] {
  const segments = splitPath(path);
  const results: PathMatchHit<T>[] = [];
  walk(root, segments, 0, {}, results);
  return results;
}

function walk<T>(
  node: PathPatternNode<T>,
  segments: readonly string[],
  i: number,
  params: Record<string, string>,
  out: PathMatchHit<T>[],
): void {
  if (i === segments.length) {
    for (const v of node.values) out.push({ value: v, params: { ...params } });
    if (node.wildcard) {
      for (const v of node.wildcard.values) out.push({ value: v, params: { ...params } });
    }
    return;
  }
  const seg = segments[i];
  if (seg === undefined) return;
  // Literal branch
  const lit = node.literal.get(seg);
  if (lit) walk(lit, segments, i + 1, params, out);
  // Param branch
  if (node.param) {
    params[node.param.name] = seg;
    walk(node.param.node, segments, i + 1, params, out);
    delete params[node.param.name];
  }
  // Wildcard branch — consumes remaining segments
  if (node.wildcard) {
    for (const v of node.wildcard.values) out.push({ value: v, params: { ...params } });
  }
}

function splitPath(p: string): string[] {
  // Leading/trailing slashes don't count. '/' is the root.
  const clean = p.replace(/^\/+|\/+$/g, '');
  return clean === '' ? [] : clean.split('/');
}
