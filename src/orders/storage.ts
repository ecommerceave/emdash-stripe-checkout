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
 * Record a successful Stripe refund, retrying if another request
 * changes the order between reading and writing.
 *
 * This function does not contact Stripe or create refunds.
 */
export async function recordSuccessfulRefund(
  ctx: PluginContext,
  orderId: string,
  stripeRefundId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await ctx.storage.orders.getVersioned(orderId);

    if (!current) {
      return false;
    }

    const order = current.value as Order;

    // Never replace an existing Stripe refund with a different refund.
    if (
      order.stripeRefundId &&
      order.stripeRefundId !== stripeRefundId
    ) {
      return false;
    }

    if (order.paymentStatus === "refunded") {
      return order.stripeRefundId === stripeRefundId;
    }

    if (
      order.paymentStatus !== "paid" &&
      order.paymentStatus !== "refund_processing" &&
      !(
        order.paymentStatus === "refund_pending" &&
        order.stripeRefundId === stripeRefundId
      )
    ) {
      return false;
    }

    const now = new Date().toISOString();

    const updatedOrder: Order = {
      ...order,
      paymentStatus: "refunded",
      stripeRefundId,
      refundStatus: "succeeded",
      refundedAt: now,
      updatedAt: now,
    };

    const result = await ctx.storage.orders.compareAndSet(
      orderId,
      current.revision,
      updatedOrder,
    );

    if (result.applied) {
      return true;
    }
  }

  return false;
}

/**
 * Record a refund that Stripe has accepted but not yet completed.
 * Uses optimistic concurrency control to avoid overwriting changes.
 */
export async function recordPendingRefund(
  ctx: PluginContext,
  orderId: string,
  stripeRefundId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await ctx.storage.orders.getVersioned(orderId);

    if (!current) {
      return false;
    }

    const order = current.value as Order;

    // Never replace an existing Stripe refund with a different refund.
    if (
      order.stripeRefundId &&
      order.stripeRefundId !== stripeRefundId
    ) {
      return false;
    }

    // Never overwrite a completed refund.
    if (order.paymentStatus === "refunded") {
      return order.stripeRefundId === stripeRefundId;
    }

    // Recognize a previously recorded pending refund.
    if (order.paymentStatus === "refund_pending") {
      return order.stripeRefundId === stripeRefundId;
    }

    if (
      order.paymentStatus !== "paid" &&
      order.paymentStatus !== "refund_processing"
    ) {
      return false;
    }

    const now = new Date().toISOString();

    const updatedOrder: Order = {
      ...order,
      paymentStatus: "refund_pending",
      stripeRefundId,
      refundStatus: "pending",
      updatedAt: now,
    };

    const result = await ctx.storage.orders.compareAndSet(
      orderId,
      current.revision,
      updatedOrder,
    );

    if (result.applied) {
      return true;
    }
  }

  return false;
}

/**
 * Atomically claim a paid order for refund processing.
 *
 * Only one request can successfully claim an order.
 * Returns false if the order is no longer eligible.
 */
export async function claimOrderForRefund(
  ctx: PluginContext,
  orderId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await ctx.storage.orders.getVersioned(orderId);

    if (!current) {
      return false;
    }

    const order = current.value as Order;

    if (order.paymentStatus !== "paid") {
      return false;
    }

    const now = new Date().toISOString();

    const updatedOrder: Order = {
      ...order,
      paymentStatus: "refund_processing",
      updatedAt: now,
    };

    const result = await ctx.storage.orders.compareAndSet(
      orderId,
      current.revision,
      updatedOrder,
    );

    if (result.applied) {
      return true;
    }
  }

  return false;
}