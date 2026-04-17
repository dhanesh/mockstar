// Satisfies: RT-7 (fixtures round-trip through upstream-shape regex validation)
// Validates: B4 (fixture coverage), T2 (provider-shape IDs), TN2 (shape inferred from fixtures, not names)
//
// This test boots the server with examples/mocks/ as the config root and hits each provider's
// create-* endpoint, asserting that the rendered ID matches the upstream's documented regex.
// The test knows provider-shape regexes ONLY for comparison — the runtime never learns them.
// Per RT-9, this test file (`tests/`) is exempt from the grep gate.

import { describe, it, expect, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { launch, type Launched } from '../src/index.ts';

const CONFIG_ROOT = resolve(import.meta.dir, '../examples/mocks');

async function boot(): Promise<Launched> {
  return launch({
    configRoot: CONFIG_ROOT,
    deterministic: true,
    watch: false,
    installCrashHandlers: false,
    server: { tenancyModes: ['header'] },
  });
}

describe('tier2 provider fixtures — rendered IDs match upstream shape regex', () => {
  let launched: Launched | null = null;
  afterEach(async () => {
    if (launched) { await launched.stop(); launched = null; }
  });

  it('razorpay create-order id matches ^order_[A-Za-z0-9]{14}$', async () => {
    launched = await boot();
    const res = await launched.server.hono.request('http://localhost/v1/orders', {
      method: 'POST',
      headers: { 'x-mockstar-tenant': 'razorpay', 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 50000, currency: 'INR', receipt: 'r1', notes: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; created_at: unknown };
    expect(body.id).toMatch(/^order_[A-Za-z0-9]{14}$/);
    expect(typeof body.created_at).toBe('number');
  });

  it('razorpay create-customer id matches ^cust_[A-Za-z0-9]{14}$', async () => {
    launched = await boot();
    const res = await launched.server.hono.request('http://localhost/v1/customers', {
      method: 'POST',
      headers: { 'x-mockstar-tenant': 'razorpay', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', email: 'a@b.co', contact: '+911', notes: {} }),
    });
    const body = await res.json() as { id: string };
    expect(body.id).toMatch(/^cust_[A-Za-z0-9]{14}$/);
  });

  it('razorpay create-refund id matches ^rfnd_[A-Za-z0-9]{14}$', async () => {
    launched = await boot();
    const res = await launched.server.hono.request('http://localhost/v1/payments/pay_abc/refund', {
      method: 'POST',
      headers: { 'x-mockstar-tenant': 'razorpay', 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 100, notes: {} }),
    });
    const body = await res.json() as { id: string };
    expect(body.id).toMatch(/^rfnd_[A-Za-z0-9]{14}$/);
  });

  it('razorpay create-payment-link id matches ^plink_[A-Za-z0-9]{14}$', async () => {
    launched = await boot();
    const res = await launched.server.hono.request('http://localhost/v1/payment_links', {
      method: 'POST',
      headers: { 'x-mockstar-tenant': 'razorpay', 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 100, currency: 'INR', customer: {} }),
    });
    const body = await res.json() as { id: string; short_url: string };
    expect(body.id).toMatch(/^plink_[A-Za-z0-9]{14}$/);
    expect(body.short_url).toMatch(/^https:\/\/rzp\.io\/i\/[A-Za-z0-9]{8}$/);
  });

  it('stripe create-customer id matches ^cus_[A-Za-z0-9]{14}$', async () => {
    launched = await boot();
    const res = await launched.server.hono.request('http://localhost/v1/customers', {
      method: 'POST',
      headers: { 'x-mockstar-tenant': 'stripe', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', email: 'a@b.co', description: null, metadata: {}, phone: null }),
    });
    const body = await res.json() as { id: string; invoice_prefix: string };
    expect(body.id).toMatch(/^cus_[A-Za-z0-9]{14}$/);
    expect(body.invoice_prefix).toMatch(/^[A-Za-z0-9]{8}$/);
  });

  it('twilio create-message sid matches ^SM[0-9a-f]{32}$', async () => {
    launched = await boot();
    const res = await launched.server.hono.request(
      'http://localhost/2010-04-01/Accounts/ACabc/Messages.json',
      {
        method: 'POST',
        headers: { 'x-mockstar-tenant': 'twilio', 'content-type': 'application/json' },
        body: JSON.stringify({ Body: 'hi', From: '+1', To: '+2' }),
      },
    );
    const body = await res.json() as { sid: string; account_sid: string; date_created: string };
    expect(body.sid).toMatch(/^SM[0-9a-f]{32}$/);
    expect(body.account_sid).toBe('ACabc');
    expect(body.date_created).toBe('2026-01-01T00:00:00.000Z');
  });

  it('paypal create-order id matches ^[A-Z0-9]{17}$', async () => {
    launched = await boot();
    const res = await launched.server.hono.request('http://localhost/v2/checkout/orders', {
      method: 'POST',
      headers: { 'x-mockstar-tenant': 'paypal', 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [] }),
    });
    const body = await res.json() as { id: string; links: Array<{ href: string; rel: string }> };
    expect(body.id).toMatch(/^[A-Z0-9]{17}$/);
    const capture = body.links.find((l) => l.rel === 'capture');
    expect(capture?.href).toMatch(/^https:\/\/api-m\.sandbox\.paypal\.com\/v2\/checkout\/orders\/[A-Z0-9]{17}\/capture$/);
  });
});
