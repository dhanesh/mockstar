import type { Context } from 'hono';
import type { HandlerHelpers } from 'mockstar';

interface LineItem { sku: string; qty: number; unitPrice: number }

/**
 * Example of a dynamic handler with computation.
 * Referenced by examples/mocks/default/orders.json ("compute-order-total").
 */
export async function computeOrderTotal(ctx: Context, helpers: HandlerHelpers): Promise<Response> {
  const body = (await ctx.req.json().catch(() => ({ items: [] }))) as { items?: LineItem[] };
  const items = body.items ?? [];
  const total = items.reduce((acc, it) => acc + it.qty * it.unitPrice, 0);
  return Response.json({
    requestId: helpers.requestId,
    tenant: helpers.tenant,
    orderId: helpers.faker.uuid(),
    total,
    currency: 'INR',
    lineCount: items.length,
  });
}
