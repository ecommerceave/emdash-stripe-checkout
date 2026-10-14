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