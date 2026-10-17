import type { PluginContext } from "emdash/plugin";
import type { Order, OrderRefund } from "./types.js";

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

/**
 * Record a refund reported by Stripe.
 *
 * This function never creates refunds in Stripe.
 * It only updates the local order history.
 */
export async function recordStripeRefund(
  ctx: PluginContext,
  orderId: string,
  refund: OrderRefund,
): Promise<boolean> {
  if (
    !refund.id.startsWith("re_") ||
    !Number.isSafeInteger(refund.amount) ||
    refund.amount <= 0 ||
    !refund.currency
  ) {
    return false;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await ctx.storage.orders.getVersioned(orderId);

    if (!current) {
      return false;
    }

    const order = current.value as Order;

    if (
      order.amountTotal === null ||
      order.amountTotal < 0 ||
      !order.currency ||
      order.currency.toLowerCase() !== refund.currency.toLowerCase() ||
      order.paymentStatus === "pending" ||
      order.paymentStatus === "failed"
    ) {
      return false;
    }

    const refunds = [...(order.refunds ?? [])];
    const existingIndex = refunds.findIndex(
      (item) => item.id === refund.id,
    );

    if (existingIndex >= 0) {
    const existing = refunds[existingIndex];

    // A Stripe refund's amount and currency should not change.
    if (
      existing.amount !== refund.amount ||
      existing.currency.toLowerCase() !== refund.currency.toLowerCase()
    ) {
      return false;
    }

    // Ignore events older than the refund information already stored.
    const incomingTime = Date.parse(refund.updatedAt);
    const existingTime = Date.parse(existing.updatedAt);

    if (
      !Number.isFinite(incomingTime) ||
      !Number.isFinite(existingTime)
    ) {
      return false;
    }

    if (incomingTime >= existingTime) {
      refunds[existingIndex] = {
        ...existing,
        ...refund,
      };
    }
  } else {
    refunds.push(refund);
  }

    const refundedAmount = refunds
      .filter((item) => item.status === "succeeded")
      .reduce((total, item) => total + item.amount, 0);

    // Never allow refund history to exceed the original payment.
    if (refundedAmount > order.amountTotal) {
      return false;
    }

    const hasPendingRefund = refunds.some(
      (item) =>
        item.status === "pending" ||
        item.status === "requires_action",
    );

    const fullyRefunded = refundedAmount === order.amountTotal;

    const paymentStatus: Order["paymentStatus"] = fullyRefunded
      ? "refunded"
      : hasPendingRefund
        ? "refund_pending"
        : "paid";

    const now = new Date().toISOString();

    const updatedOrder: Order = {
      ...order,
      refunds,
      refundedAmount,
      paymentStatus,
      updatedAt: now,
      ...(fullyRefunded
        ? { refundedAt: order.refundedAt ?? now }
        : {}),
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