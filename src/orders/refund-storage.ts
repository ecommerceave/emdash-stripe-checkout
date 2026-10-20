import type { PluginContext } from "emdash/plugin";
import type { Order, OrderRefund } from "./types.js";

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