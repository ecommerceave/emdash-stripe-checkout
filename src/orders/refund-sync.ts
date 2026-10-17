import type { PluginContext } from "emdash/plugin";

import { getOrder } from "./storage.js";
import { listStripeRefunds } from "../stripe/refunds.js";

import type { Order, OrderRefund } from "./types.js";

/**
 * Synchronize an order's refund history from Stripe.
 *
 * Stripe is the source of truth.
 * This function never creates or modifies Stripe refunds.
 */
export async function syncOrderRefunds(
  ctx: PluginContext,
  orderId: string,
): Promise<boolean> {
  const order: Order | null = await getOrder(ctx, orderId);

  if (!order?.stripePaymentIntentId) {
    return false;
  }

    // Capture the order revision before requesting Stripe data.
  // This lets reconciliation detect whether another request
  // updated the order while the Stripe API call was running.
  const initialOrder = await ctx.storage.orders.getVersioned(orderId);

  if (
    !initialOrder ||
    (initialOrder.value as Order).stripePaymentIntentId !==
      order.stripePaymentIntentId
  ) {
    return false;
  }

  const refunds = await listStripeRefunds(
    ctx,
    order.stripePaymentIntentId,
  );

    // Validate every refund before modifying the order.
  const refundIds = new Set<string>();

  for (const refund of refunds) {
    if (
      !refund.id.startsWith("re_") ||
      refundIds.has(refund.id) ||
      refund.payment_intent !== order.stripePaymentIntentId ||
      !Number.isSafeInteger(refund.amount) ||
      refund.amount <= 0 ||
      refund.currency.toLowerCase() !== order.currency?.toLowerCase() ||
      !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(
        refund.status,
      ) ||
      !Number.isSafeInteger(refund.created) ||
      refund.created <= 0
    ) {
      throw new Error("Invalid Stripe refund data.");
    }

    refundIds.add(refund.id);
  }

    const normalizedRefunds: OrderRefund[] = refunds.map((refund) => {
    const createdAt = new Date(refund.created * 1000).toISOString();

    return {
      id: refund.id,
      amount: refund.amount,
      currency: refund.currency.toLowerCase(),
      status: refund.status,
      createdAt,
      updatedAt: createdAt,
      failureReason: refund.failure_reason ?? null,
    };
  });

  return reconcileOrderRefunds(
    ctx,
    orderId,
    order.stripePaymentIntentId,
    normalizedRefunds,
    initialOrder.revision,
);
}

/**
 * Atomically replace an order's refund snapshot with
 * the validated, current refund information from Stripe.
 *
 * This function does not contact Stripe or initiate refunds.
 */
export async function reconcileOrderRefunds(
  ctx: PluginContext,
  orderId: string,
  paymentIntentId: string,
  refunds: OrderRefund[],
  expectedRevision?: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await ctx.storage.orders.getVersioned(orderId);

    if (!current) {
      return false;
    }

    // Reject a Stripe snapshot if the order changed
    // after the Stripe API request began.
    if (
        expectedRevision !== undefined &&
        current.revision !== expectedRevision
    ) {
        return false;
    }

    const order = current.value as Order;

    // Never apply refunds to a different payment.
    if (
      order.stripePaymentIntentId !== paymentIntentId ||
      order.amountTotal === null ||
      !Number.isSafeInteger(order.amountTotal) ||
      order.amountTotal <= 0 ||
      !order.currency ||
      order.paymentStatus === "pending" ||
      order.paymentStatus === "failed"
    ) {
      return false;
    }

        // Never silently discard previously recorded refunds.
    // A complete Stripe snapshot must contain every known refund.
    const incomingRefundIds = new Set(
      refunds.map((refund) => refund.id),
    );

    const missingKnownRefund = (order.refunds ?? []).some(
      (existing) => !incomingRefundIds.has(existing.id),
    );

    if (missingKnownRefund) {
      return false;
    }

    // Legacy orders may have a refund ID but no refunds array.
    // Require Stripe to confirm that refund before replacing history.
    if (
      order.stripeRefundId?.startsWith("re_") &&
      !incomingRefundIds.has(order.stripeRefundId)
    ) {
      return false;
    }
    
    const refundedAmount = refunds
      .filter((refund) => refund.status === "succeeded")
      .reduce((total, refund) => total + refund.amount, 0);

    if (refundedAmount > order.amountTotal) {
      return false;
    }

    const hasPendingRefund = refunds.some(
      (refund) =>
        refund.status === "pending" ||
        refund.status === "requires_action",
    );

    const fullyRefunded = refundedAmount === order.amountTotal;

    const paymentStatus: Order["paymentStatus"] = fullyRefunded
      ? "refunded"
      : hasPendingRefund
        ? "refund_pending"
        : "paid";

    const now = new Date().toISOString();
    
    // Keep legacy refund fields synchronized for compatibility
    // with existing order displays.
    const latestRefund = [...refunds].sort(
    (a, b) =>
        new Date(b.createdAt).getTime() -
        new Date(a.createdAt).getTime(),
    )[0];

    const updatedOrder: Order = {
        ...order,
        refunds,
        refundedAmount,
        paymentStatus,
        updatedAt: now,
        stripeRefundId: latestRefund?.id ?? order.stripeRefundId ?? null,
        refundStatus: latestRefund?.status ?? order.refundStatus ?? null,
        ...(fullyRefunded
        ? {
            refundedAt:
                [...refunds]
                    .filter((refund) => refund.status === "succeeded")
                    .sort(
                        (a, b) =>
                            new Date(b.createdAt).getTime() -
                            new Date(a.createdAt).getTime(),
                    )[0]?.createdAt ?? now,
        }
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