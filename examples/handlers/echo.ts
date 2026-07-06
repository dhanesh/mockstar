import type { Context } from 'hono';
import type { HandlerHelpers } from '@dhaneshpurohit/mockstar';

export async function echo(ctx: Context, helpers: HandlerHelpers): Promise<Response> {
  const body = await ctx.req.json().catch(() => ({}));
  return Response.json({
    requestId: helpers.requestId,
    tenant: helpers.tenant,
    echoed: body,
    generatedId: helpers.faker.uuid(),
  });
}
