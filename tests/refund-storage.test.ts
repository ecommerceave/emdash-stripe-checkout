import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";
import type { Order } from "../src/orders/types.js";

import {
  recordPendingRefund,
  recordSuccessfulRefund,
  recordStripeRefund,
} from "../src/orders/refund-storage.js";

import {
  savePaymentIntentOrderLookup,
  getOrderByPaymentIntent,
} from "../src/orders/storage.js";

const makeOrder = (): Order => ({
  id: "cs_test_order_123",
  stripeSessionId: "cs_test_order_123",
  productId: "product_123",
  quantity: 1,
  amountTotal: 2500,
  currency: "usd",
  paymentStatus: "paid",
  customerEmail: "test@example.com",
  createdAt: "2026-10-15T10:00:00.000Z",
  updatedAt: "2026-10-15T10:00:00.000Z",
  paidAt: "2026-10-15T10:01:00.000Z",
});

function makeContext(
  getVersioned: ReturnType<typeof vi.fn>,
  compareAndSet: ReturnType<typeof vi.fn>,
): PluginContext {
  return {
    storage: {
      orders: {
        getVersioned,
        compareAndSet,
      },
    },
  } as unknown as PluginContext;
}

describe("recordSuccessfulRefund", () => {
  it("records a successful refund", async () => {
    const getVersioned = vi.fn().mockResolvedValue({
      value: makeOrder(),
      revision: "rev-1",
    });

    const compareAndSet = vi.fn().mockResolvedValue({
      applied: true,
    });

    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordSuccessfulRefund(
      ctx,
      "cs_test_order_123",
      "re_test_123",
    );

    expect(result).toBe(true);
    expect(compareAndSet).toHaveBeenCalledOnce();

    const [orderId, revision, updatedOrder] =
      compareAndSet.mock.calls[0];

    expect(orderId).toBe("cs_test_order_123");
    expect(revision).toBe("rev-1");
    expect(updatedOrder.paymentStatus).toBe("refunded");
    expect(updatedOrder.stripeRefundId).toBe("re_test_123");
    expect(updatedOrder.refundStatus).toBe("succeeded");
    expect(updatedOrder.refundedAt).toBeTruthy();
  });

  it("completes a pending refund when the Stripe refund ID matches", async () => {
    const getVersioned = vi.fn().mockResolvedValue({
      value: {
        ...makeOrder(),
        paymentStatus: "refund_pending",
        stripeRefundId: "re_test_123",
        refundStatus: "pending",
      },
      revision: "rev-2",
    });

    const compareAndSet = vi.fn().mockResolvedValue({
      applied: true,
    });

    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordSuccessfulRefund(
      ctx,
      "cs_test_order_123",
      "re_test_123",
    );

    expect(result).toBe(true);
    expect(compareAndSet).toHaveBeenCalledOnce();

    const updatedOrder = compareAndSet.mock.calls[0][2];

    expect(updatedOrder.paymentStatus).toBe("refunded");
    expect(updatedOrder.stripeRefundId).toBe("re_test_123");
    expect(updatedOrder.refundStatus).toBe("succeeded");
    expect(updatedOrder.refundedAt).toBeTruthy();
  });

  it("retries when another request modifies the order", async () => {
    const getVersioned = vi
      .fn()
      .mockResolvedValueOnce({
        value: makeOrder(),
        revision: "rev-1",
      })
      .mockResolvedValueOnce({
        value: makeOrder(),
        revision: "rev-2",
      });

    const compareAndSet = vi
      .fn()
      .mockResolvedValueOnce({ applied: false })
      .mockResolvedValueOnce({ applied: true });

    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordSuccessfulRefund(
      ctx,
      "cs_test_order_123",
      "re_test_123",
    );

    expect(result).toBe(true);
    expect(compareAndSet).toHaveBeenCalledTimes(2);
    expect(getVersioned).toHaveBeenCalledTimes(2);
  });

  it("recognizes an already recorded refund", async () => {
    const order = {
      ...makeOrder(),
      paymentStatus: "refunded" as const,
      stripeRefundId: "re_test_123",
    };

    const getVersioned = vi.fn().mockResolvedValue({
      value: order,
      revision: "rev-2",
    });

    const compareAndSet = vi.fn();
    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordSuccessfulRefund(
      ctx,
      "cs_test_order_123",
      "re_test_123",
    );

    expect(result).toBe(true);
    expect(compareAndSet).not.toHaveBeenCalled();
  });

  it("rejects a different refund ID on an already refunded order", async () => {
    const getVersioned = vi.fn().mockResolvedValue({
      value: {
        ...makeOrder(),
        paymentStatus: "refunded",
        stripeRefundId: "re_original",
      },
      revision: "rev-2",
    });

    const compareAndSet = vi.fn();
    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordSuccessfulRefund(
      ctx,
      "cs_test_order_123",
      "re_different",
    );

    expect(result).toBe(false);
    expect(compareAndSet).not.toHaveBeenCalled();
  });

  it("returns false after three failed update attempts", async () => {
    const getVersioned = vi.fn().mockResolvedValue({
      value: makeOrder(),
      revision: "rev-1",
    });

    const compareAndSet = vi.fn().mockResolvedValue({
      applied: false,
    });

    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordSuccessfulRefund(
      ctx,
      "cs_test_order_123",
      "re_test_123",
    );

    expect(result).toBe(false);
    expect(compareAndSet).toHaveBeenCalledTimes(3);
  });

  it("does not refund an unpaid order", async () => {
    const getVersioned = vi.fn().mockResolvedValue({
      value: {
        ...makeOrder(),
        paymentStatus: "pending",
      },
      revision: "rev-1",
    });

    const compareAndSet = vi.fn();
    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordSuccessfulRefund(
      ctx,
      "cs_test_order_123",
      "re_test_123",
    );

    expect(result).toBe(false);
    expect(compareAndSet).not.toHaveBeenCalled();
  });

  it("does not overwrite a different refund ID during processing", async () => {
    const getVersioned = vi.fn().mockResolvedValue({
        value: {
        ...makeOrder(),
        paymentStatus: "refund_processing",
        stripeRefundId: "re_original",
        },
        revision: "rev-2",
    });

    const compareAndSet = vi.fn();
    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordSuccessfulRefund(
        ctx,
        "cs_test_order_123",
        "re_different",
    );

    expect(result).toBe(false);
    expect(compareAndSet).not.toHaveBeenCalled();
    });
});

describe("recordPendingRefund", () => {
  it("records a pending refund", async () => {
    const getVersioned = vi.fn().mockResolvedValue({
      value: makeOrder(),
      revision: "rev-1",
    });

    const compareAndSet = vi.fn().mockResolvedValue({
      applied: true,
    });

    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordPendingRefund(
      ctx,
      "cs_test_order_123",
      "re_test_123",
    );

    expect(result).toBe(true);

    const updatedOrder = compareAndSet.mock.calls[0][2];

    expect(updatedOrder.paymentStatus).toBe("refund_pending");
    expect(updatedOrder.stripeRefundId).toBe("re_test_123");
    expect(updatedOrder.refundStatus).toBe("pending");
  });

  it("does not overwrite an already completed refund", async () => {
    const getVersioned = vi.fn().mockResolvedValue({
      value: {
        ...makeOrder(),
        paymentStatus: "refunded",
        stripeRefundId: "re_existing",
      },
      revision: "rev-2",
    });

    const compareAndSet = vi.fn();
    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordPendingRefund(
      ctx,
      "cs_test_order_123",
      "re_different",
    );

    expect(result).toBe(false);
    expect(compareAndSet).not.toHaveBeenCalled();
  });

  it("recognizes an existing pending refund", async () => {
    const getVersioned = vi.fn().mockResolvedValue({
      value: {
        ...makeOrder(),
        paymentStatus: "refund_pending",
        stripeRefundId: "re_test_123",
      },
      revision: "rev-2",
    });

    const compareAndSet = vi.fn();
    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordPendingRefund(
      ctx,
      "cs_test_order_123",
      "re_test_123",
    );

    expect(result).toBe(true);
    expect(compareAndSet).not.toHaveBeenCalled();
  });

  it("does not overwrite a different refund ID during processing", async () => {
    const getVersioned = vi.fn().mockResolvedValue({
        value: {
        ...makeOrder(),
        paymentStatus: "refund_processing",
        stripeRefundId: "re_original",
        },
        revision: "rev-2",
    });

    const compareAndSet = vi.fn();
    const ctx = makeContext(getVersioned, compareAndSet);

    const result = await recordPendingRefund(
        ctx,
        "cs_test_order_123",
        "re_different",
    );

    expect(result).toBe(false);
    expect(compareAndSet).not.toHaveBeenCalled();
    });
});

describe("PaymentIntent order lookup", () => {
  it("saves and retrieves an order by its Stripe PaymentIntent ID", async () => {
    const paymentIntentId = "pi_test_123";
    const orderId = "cs_test_order_123";

    const order: Order = {
      ...makeOrder(),
      stripePaymentIntentId: paymentIntentId,
    };

    const kvCompareAndSet = vi.fn().mockResolvedValue({
      applied: true,
    });
    const kvGet = vi.fn().mockResolvedValue(orderId);
    const getOrder = vi.fn().mockResolvedValue(order);

    const ctx = {
      kv: {
        compareAndSet: kvCompareAndSet,
        get: kvGet,
      },
      storage: {
        orders: {
          get: getOrder,
        },
      },
    } as unknown as PluginContext;

    await savePaymentIntentOrderLookup(
      ctx,
      paymentIntentId,
      orderId,
    );

    expect(kvCompareAndSet).toHaveBeenCalledWith(
      `stripe:payment-intent:${paymentIntentId}`,
      null,
      orderId,
    );

    const result = await getOrderByPaymentIntent(
      ctx,
      paymentIntentId,
    );

    expect(kvGet).toHaveBeenCalledWith(
      `stripe:payment-intent:${paymentIntentId}`,
    );

    expect(getOrder).toHaveBeenCalledWith(orderId);
    expect(result).toEqual(order);
  });

  it("rejects a lookup when the PaymentIntent ID does not match the order", async () => {
    const order: Order = {
      ...makeOrder(),
      stripePaymentIntentId: "pi_different",
    };

    const ctx = {
      kv: {
        get: vi.fn().mockResolvedValue("cs_test_order_123"),
      },
      storage: {
        orders: {
          get: vi.fn().mockResolvedValue(order),
        },
      },
    } as unknown as PluginContext;

    const result = await getOrderByPaymentIntent(
      ctx,
      "pi_test_123",
    );

    expect(result).toBeNull();
  });

  it("rejects a PaymentIntent already associated with another order", async () => {
    const paymentIntentId = "pi_test_123";

    const kvCompareAndSet = vi.fn().mockResolvedValue({
      applied: false,
    });

    const kvGet = vi.fn().mockResolvedValue("cs_existing_order");

    const ctx = {
      kv: {
        compareAndSet: kvCompareAndSet,
        get: kvGet,
      },
    } as unknown as PluginContext;

    await expect(
      savePaymentIntentOrderLookup(
        ctx,
        paymentIntentId,
        "cs_different_order",
      ),
    ).rejects.toThrow(
      "Stripe PaymentIntent is already associated with another order.",
    );

    expect(kvCompareAndSet).toHaveBeenCalledWith(
      `stripe:payment-intent:${paymentIntentId}`,
      null,
      "cs_different_order",
    );

    expect(kvGet).toHaveBeenCalledOnce();
  });

  it("accepts an existing PaymentIntent association for the same order", async () => {
    const paymentIntentId = "pi_test_123";
    const orderId = "cs_existing_order";

    const kvCompareAndSet = vi.fn().mockResolvedValue({
      applied: false,
    });

    const kvGet = vi.fn().mockResolvedValue(orderId);

    const ctx = {
      kv: {
        compareAndSet: kvCompareAndSet,
        get: kvGet,
      },
    } as unknown as PluginContext;

    await expect(
      savePaymentIntentOrderLookup(ctx, paymentIntentId, orderId),
    ).resolves.toBeUndefined();

    expect(kvCompareAndSet).toHaveBeenCalledWith(
      `stripe:payment-intent:${paymentIntentId}`,
      null,
      orderId,
    );

    expect(kvGet).toHaveBeenCalledOnce();
  });
});

describe("Stripe refund history", () => {
  it("records a partial refund without marking the entire order as refunded", async () => {
    const order = {
      id: "cs_test_partial",
      stripeSessionId: "cs_test_partial",
      stripePaymentIntentId: "pi_test_partial",
      productId: "product_test",
      quantity: 1,
      amountTotal: 10000,
      currency: "usd",
      paymentStatus: "paid",
      customerEmail: null,
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:00:00.000Z",
      paidAt: "2026-10-16T12:00:00.000Z",
    };

    const compareAndSet = vi.fn().mockResolvedValue({
      applied: true,
    });

    const ctx = {
      storage: {
        orders: {
          getVersioned: vi.fn().mockResolvedValue({
            value: order,
            revision: "revision_1",
          }),
          compareAndSet,
        },
      },
    } as unknown as PluginContext;

    const result = await recordStripeRefund(ctx, order.id, {
      id: "re_test_partial",
      amount: 2500,
      currency: "usd",
      status: "succeeded",
      createdAt: "2026-10-16T12:30:00.000Z",
      updatedAt: "2026-10-16T12:30:00.000Z",
    });

    expect(result).toBe(true);

    const updatedOrder = compareAndSet.mock.calls[0][2];

    expect(updatedOrder.paymentStatus).toBe("paid");
    expect(updatedOrder.refundedAmount).toBe(2500);
    expect(updatedOrder.refunds).toHaveLength(1);
    expect(updatedOrder.refunds[0].id).toBe("re_test_partial");
  });

  it("combines multiple successful partial refunds", async () => {
    const order = {
      id: "cs_test_multiple",
      stripeSessionId: "cs_test_multiple",
      stripePaymentIntentId: "pi_test_multiple",
      productId: "product_test",
      quantity: 1,
      amountTotal: 10000,
      currency: "usd",
      paymentStatus: "paid",
      customerEmail: null,
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:00:00.000Z",
      paidAt: "2026-10-16T12:00:00.000Z",
      refunds: [
        {
          id: "re_first",
          amount: 2500,
          currency: "usd",
          status: "succeeded",
          createdAt: "2026-10-16T12:30:00.000Z",
          updatedAt: "2026-10-16T12:30:00.000Z",
        },
      ],
      refundedAmount: 2500,
    };

    const compareAndSet = vi.fn().mockResolvedValue({
      applied: true,
    });

    const ctx = {
      storage: {
        orders: {
          getVersioned: vi.fn().mockResolvedValue({
            value: order,
            revision: "revision_1",
          }),
          compareAndSet,
        },
      },
    } as unknown as PluginContext;

    const result = await recordStripeRefund(ctx, order.id, {
      id: "re_second",
      amount: 1500,
      currency: "usd",
      status: "succeeded",
      createdAt: "2026-10-16T13:00:00.000Z",
      updatedAt: "2026-10-16T13:00:00.000Z",
    });

    expect(result).toBe(true);

    const updatedOrder = compareAndSet.mock.calls[0][2];

    expect(updatedOrder.paymentStatus).toBe("paid");
    expect(updatedOrder.refundedAmount).toBe(4000);
    expect(updatedOrder.refunds).toHaveLength(2);
    expect(updatedOrder.refunds.map((refund: { id: string }) => refund.id))
      .toEqual(["re_first", "re_second"]);
  });

  it("does not double-count a refund received more than once", async () => {
    const refund = {
      id: "re_duplicate",
      amount: 2500,
      currency: "usd",
      status: "succeeded",
      createdAt: "2026-10-16T12:30:00.000Z",
      updatedAt: "2026-10-16T12:30:00.000Z",
    };

    const order = {
      id: "cs_test_duplicate",
      stripeSessionId: "cs_test_duplicate",
      stripePaymentIntentId: "pi_test_duplicate",
      productId: "product_test",
      quantity: 1,
      amountTotal: 10000,
      currency: "usd",
      paymentStatus: "paid",
      customerEmail: null,
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:30:00.000Z",
      paidAt: "2026-10-16T12:00:00.000Z",
      refunds: [refund],
      refundedAmount: 2500,
    };

    const compareAndSet = vi.fn().mockResolvedValue({
      applied: true,
    });

    const ctx = {
      storage: {
        orders: {
          getVersioned: vi.fn().mockResolvedValue({
            value: order,
            revision: "revision_1",
          }),
          compareAndSet,
        },
      },
    } as unknown as PluginContext;

    const result = await recordStripeRefund(ctx, order.id, refund);

    expect(result).toBe(true);

    const updatedOrder = compareAndSet.mock.calls[0][2];

    expect(updatedOrder.refunds).toHaveLength(1);
    expect(updatedOrder.refundedAmount).toBe(2500);
    expect(updatedOrder.paymentStatus).toBe("paid");
  });

  it("ignores an older refund event", async () => {
    const order = {
      id: "cs_test_stale",
      stripeSessionId: "cs_test_stale",
      stripePaymentIntentId: "pi_test_stale",
      productId: "product_test",
      quantity: 1,
      amountTotal: 10000,
      currency: "usd",
      paymentStatus: "paid",
      customerEmail: null,
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T13:00:00.000Z",
      paidAt: "2026-10-16T12:00:00.000Z",
      refunds: [
        {
          id: "re_test_stale",
          amount: 2500,
          currency: "usd",
          status: "succeeded",
          createdAt: "2026-10-16T12:30:00.000Z",
          updatedAt: "2026-10-16T13:00:00.000Z",
        },
      ],
      refundedAmount: 2500,
    };

    const compareAndSet = vi.fn().mockResolvedValue({
      applied: true,
    });

    const ctx = {
      storage: {
        orders: {
          getVersioned: vi.fn().mockResolvedValue({
            value: order,
            revision: "revision_1",
          }),
          compareAndSet,
        },
      },
    } as unknown as PluginContext;

    const result = await recordStripeRefund(ctx, order.id, {
      id: "re_test_stale",
      amount: 2500,
      currency: "usd",
      status: "pending",
      createdAt: "2026-10-16T12:30:00.000Z",
      updatedAt: "2026-10-16T12:45:00.000Z",
    });

    expect(result).toBe(true);

    const updatedOrder = compareAndSet.mock.calls[0][2];

    expect(updatedOrder.refunds).toHaveLength(1);
    expect(updatedOrder.refunds[0].status).toBe("succeeded");
    expect(updatedOrder.refundedAmount).toBe(2500);
    expect(updatedOrder.paymentStatus).toBe("paid");
  });
});