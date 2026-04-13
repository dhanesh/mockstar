// Satisfies: O3 (per-tenant bounded request journal, O(1) writes, non-blocking reads)
// Satisfies: RT-6.3 (journal writes deferred via microtask after response)

export interface JournalEntry {
  timestamp: number;
  tenant: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  matchedMockId: string | null;
  durationUs: number;
}

/**
 * Fixed-capacity ring buffer. Writes are a single indexed assignment.
 * Snapshot reads (for journal endpoint) allocate a fresh array so the
 * write path is never blocked by a reader. (RT-6.3, O3)
 */
export class RingBuffer<T> {
  #buffer: (T | undefined)[];
  #head = 0;
  #size = 0;

  constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new Error('RingBuffer capacity must be positive');
    this.#buffer = new Array<T | undefined>(capacity);
  }

  /** O(1). Overwrites oldest when full. */
  push(item: T): void {
    this.#buffer[this.#head] = item;
    this.#head = (this.#head + 1) % this.capacity;
    if (this.#size < this.capacity) this.#size += 1;
  }

  get size(): number {
    return this.#size;
  }

  /**
   * Return a chronologically-ordered snapshot (oldest first). Allocates a
   * new array — callers should not mutate the returned list.
   */
  snapshot(): T[] {
    const out: T[] = new Array(this.#size);
    if (this.#size < this.capacity) {
      for (let i = 0; i < this.#size; i++) {
        const val = this.#buffer[i];
        if (val !== undefined) out[i] = val;
      }
    } else {
      let idx = 0;
      for (let i = 0; i < this.capacity; i++) {
        const val = this.#buffer[(this.#head + i) % this.capacity];
        if (val !== undefined) out[idx++] = val;
      }
    }
    return out;
  }
}

/**
 * Per-tenant journal registry. The server holds one of these; per-tenant
 * buffers are created lazily on first write (and bounded by the tenant's
 * configured journal size — see S5 / O3).
 */
export class JournalRegistry {
  readonly #byTenant = new Map<string, RingBuffer<JournalEntry>>();

  constructor(private readonly capacityFor: (tenant: string) => number) {}

  record(entry: JournalEntry): void {
    let buf = this.#byTenant.get(entry.tenant);
    if (!buf) {
      buf = new RingBuffer<JournalEntry>(this.capacityFor(entry.tenant));
      this.#byTenant.set(entry.tenant, buf);
    }
    buf.push(entry);
  }

  snapshot(tenant: string): JournalEntry[] {
    return this.#byTenant.get(tenant)?.snapshot() ?? [];
  }

  tenants(): readonly string[] {
    return [...this.#byTenant.keys()];
  }
}
