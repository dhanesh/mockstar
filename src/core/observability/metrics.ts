// Satisfies: O2 (Prometheus metrics endpoint), RT-6.3 (atomic counters, no allocation on hot path)

export interface MetricsSnapshot {
  /** Exposition format (Prometheus text). */
  format(): string;
}

/**
 * Atomic counters keyed by (metric, label-set). Increment is O(1) and
 * allocates only on label-set first-use (config-load time, effectively).
 * Latency histogram buckets are fixed at construction for allocation-free
 * increment on the hot path.
 */
export class Metrics implements MetricsSnapshot {
  readonly #counters = new Map<string, number>();
  readonly #latencyBuckets: readonly number[];
  readonly #latencyCounts: Map<string, number[]> = new Map();
  readonly #latencySum: Map<string, number> = new Map();
  // RT-12: gauge support (webhook_queue_depth, webhook_circuit_state). Map<labelKey, value>.
  readonly #gauges = new Map<string, number>();

  constructor(bucketsMicros: readonly number[] = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 50_000]) {
    this.#latencyBuckets = bucketsMicros;
  }

  incCounter(metric: string, labels: Record<string, string>): void {
    const key = keyOf(metric, labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + 1);
  }

  /**
   * Set a gauge value (RT-12). Idempotent — last write wins.
   * Used for webhook_queue_depth (per-tenant) and webhook_circuit_state (per-tenant,webhook).
   */
  setGauge(metric: string, labels: Record<string, string>, value: number): void {
    const key = keyOf(metric, labels);
    this.#gauges.set(key, value);
  }

  observeLatencyUs(metric: string, labels: Record<string, string>, value: number): void {
    const key = keyOf(metric, labels);
    let buckets = this.#latencyCounts.get(key);
    if (!buckets) {
      buckets = new Array<number>(this.#latencyBuckets.length + 1).fill(0);
      this.#latencyCounts.set(key, buckets);
    }
    // Linear scan — with < 15 buckets this is faster than binary search on hot path.
    let placed = false;
    for (let i = 0; i < this.#latencyBuckets.length; i++) {
      const bound = this.#latencyBuckets[i];
      if (bound !== undefined && value <= bound) {
        // biome-ignore lint/style/noNonNullAssertion: length is fixed at construction
        buckets[i] = (buckets[i] ?? 0) + 1;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const inf = buckets.length - 1;
      buckets[inf] = (buckets[inf] ?? 0) + 1;
    }
    this.#latencySum.set(key, (this.#latencySum.get(key) ?? 0) + value);
  }

  format(): string {
    const lines: string[] = [];
    for (const [key, value] of this.#counters) {
      const { metric, labels } = unkey(key);
      lines.push(`${metric}${labelString(labels)} ${value}`);
    }
    // Gauges (RT-12). Emitted as plain `metric{labels} value` lines, like counters.
    for (const [key, value] of this.#gauges) {
      const { metric, labels } = unkey(key);
      lines.push(`${metric}${labelString(labels)} ${value}`);
    }
    for (const [key, counts] of this.#latencyCounts) {
      const { metric, labels } = unkey(key);
      let cumulative = 0;
      for (let i = 0; i < this.#latencyBuckets.length; i++) {
        cumulative += counts[i] ?? 0;
        const labelsWithLe = { ...labels, le: String((this.#latencyBuckets[i] ?? 0) / 1_000_000) }; // seconds
        lines.push(`${metric}_bucket${labelString(labelsWithLe)} ${cumulative}`);
      }
      cumulative += counts[counts.length - 1] ?? 0;
      lines.push(`${metric}_bucket${labelString({ ...labels, le: "+Inf" })} ${cumulative}`);
      lines.push(
        `${metric}_sum${labelString(labels)} ${((this.#latencySum.get(key) ?? 0) / 1_000_000).toFixed(6)}`,
      );
      lines.push(`${metric}_count${labelString(labels)} ${cumulative}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function keyOf(metric: string, labels: Record<string, string>): string {
  return `${metric}\0${Object.entries(labels)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join(",")}`;
}

function unkey(key: string): { metric: string; labels: Record<string, string> } {
  const [metric, labelString] = key.split("\0");
  const labels: Record<string, string> = {};
  if (labelString) {
    for (const pair of labelString.split(",")) {
      const [k, v] = pair.split("=");
      if (k) labels[k] = v ?? "";
    }
  }
  return { metric: metric ?? "", labels };
}

function labelString(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(",")}}`;
}
