import type { PluginContext } from "emdash/plugin";
import type { Order } from "./types.js";

/**
 * Create an order only if it does not already exist.
 *
 * Returns true if the order was created.
 * Returns false if an order with this ID already exists.
 */
export async function createOrder(
  ctx: PluginContext,
  order: Order,
): Promise<boolean> {
  const result = await ctx.storage.orders.compareAndSet(
    order.id,
    null,
    order,
  );

  return result.applied;
}

/**
 * Retrieve an order by its ID.
 */
export async function getOrder(
  ctx: PluginContext,
  orderId: string,
): Promise<Order | null> {
  const order = await ctx.storage.orders.get(orderId);

  return (order as Order | null);
}

/**
 * Update an existing order without overwriting
 * changes made by another request.
 */
export async function updateOrder(
  ctx: PluginContext,
  orderId: string,
  changes: Partial<Order>,
): Promise<boolean> {
  const current = await ctx.storage.orders.getVersioned(orderId);

  if (!current) {
    return false;
  }

  const updatedOrder: Order = {
    ...(current.value as Order),
    ...changes,
    id: orderId,
    updatedAt: new Date().toISOString(),
  };

  const result = await ctx.storage.orders.compareAndSet(
    orderId,
    current.revision,
    updatedOrder,
  );

  return result.applied;
}

/**
 * Retrieve orders, newest first, with cursor-based pagination.
 */
export async function listOrders(
  ctx: PluginContext,
  cursor?: string,
): Promise<{
  orders: Order[];
  cursor?: string;
  hasMore: boolean;
}> {
  const result = await ctx.storage.orders.query({
    orderBy: { createdAt: "desc" },
    limit: 25,
    ...(cursor ? { cursor } : {}),
  });

  return {
    orders: result.items.map((item) => item.data as Order),
    cursor: result.cursor,
    hasMore: result.hasMore,
  };
}

/**
 * Associate a Stripe PaymentIntent with an EmDash order.
 * Atomically prevents association with a different order.
 */
export async function savePaymentIntentOrderLookup(
  ctx: PluginContext,
  paymentIntentId: string,
  orderId: string,
): Promise<void> {
  if (!paymentIntentId.startsWith("pi_")) {
    throw new Error("Invalid Stripe PaymentIntent ID.");
  }

  const key = `stripe:payment-intent:${paymentIntentId}`;

  // Atomically create the lookup only if it does not exist.
  const result = await ctx.kv.compareAndSet(
    key,
    null,
    orderId,
  );

  if (result.applied) {
    return;
  }

  // If another request already created the same association,
  // that's fine. A different association is an error.
  const existingOrderId = await ctx.kv.get<string>(key);

  if (existingOrderId === orderId) {
    return;
  }

  throw new Error(
    "Stripe PaymentIntent is already associated with another order.",
  );
}

/**
 * Find an EmDash order using its Stripe PaymentIntent ID.
 */
export async function getOrderByPaymentIntent(
  ctx: PluginContext,
  paymentIntentId: string,
): Promise<Order | null> {
  const orderId = await ctx.kv.get<string>(
    `stripe:payment-intent:${paymentIntentId}`,
  );

  if (!orderId) {
    return null;
  }

  const order = await getOrder(ctx, orderId);

  // Verify the association before trusting the lookup.
  if (order?.stripePaymentIntentId !== paymentIntentId) {
    return null;
  }

  return order;
}

