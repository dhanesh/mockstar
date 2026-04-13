// @constraint O3 — per-tenant bounded journal
// @constraint RT-6.3 — O(1) writes, non-blocking reads

import { describe, it, expect } from 'bun:test';
import { JournalRegistry, RingBuffer, type JournalEntry } from '../src/core/journal/index.ts';

describe('RingBuffer', () => {
  it('keeps last-N in chronological order when overflowing', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    expect(rb.snapshot()).toEqual([2, 3, 4]);
    expect(rb.size).toBe(3);
  });

  it('snapshot is a fresh array (non-blocking reads)', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    const a = rb.snapshot();
    const b = rb.snapshot();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('rejects zero / negative capacity', () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
  });
});

describe('JournalRegistry (per-tenant isolation)', () => {
  const entry = (tenant: string, path: string): JournalEntry => ({
    timestamp: Date.now(),
    tenant,
    requestId: `req-${tenant}-${path}`,
    method: 'GET',
    path,
    status: 200,
    matchedMockId: 'm1',
    durationUs: 42,
  });

  it('partitions entries by tenant', () => {
    const reg = new JournalRegistry(() => 10);
    reg.record(entry('acme', '/a'));
    reg.record(entry('globex', '/b'));
    expect(reg.snapshot('acme').map((e) => e.path)).toEqual(['/a']);
    expect(reg.snapshot('globex').map((e) => e.path)).toEqual(['/b']);
  });

  it('respects per-tenant capacity', () => {
    const reg = new JournalRegistry(() => 2);
    reg.record(entry('acme', '/a'));
    reg.record(entry('acme', '/b'));
    reg.record(entry('acme', '/c'));
    expect(reg.snapshot('acme').map((e) => e.path)).toEqual(['/b', '/c']);
  });
});
