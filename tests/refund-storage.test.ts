import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";
import type { Order } from "../src/orders/types.js";

import {
  recordPendingRefund,
  recordSuccessfulRefund,
  claimOrderForRefund,
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

describe("claimOrderForRefund", () => {
  it("allows only one request to claim an order for refund processing", async () => {
    let currentOrder = makeOrder();
    let revision = 1;

    const getVersioned = vi.fn().mockImplementation(async () => ({
      value: { ...currentOrder },
      revision: `rev-${revision}`,
    }));

    const compareAndSet = vi.fn().mockImplementation(
      async (_orderId, expectedRevision, updatedOrder) => {
        if (expectedRevision !== `rev-${revision}`) {
          return { applied: false };
        }

        currentOrder = { ...updatedOrder };
        revision++;

        return { applied: true };
      },
    );

    const ctx = makeContext(getVersioned, compareAndSet);

    const firstClaim = await claimOrderForRefund(
      ctx,
      "cs_test_order_123",
    );

    const secondClaim = await claimOrderForRefund(
      ctx,
      "cs_test_order_123",
    );

    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);
    expect(currentOrder.paymentStatus).toBe("refund_processing");
    expect(compareAndSet).toHaveBeenCalledOnce();
  });

  it("allows only one of two simultaneous refund claims", async () => {
    let currentOrder = makeOrder();
    let revision = 1;

    const getVersioned = vi.fn().mockImplementation(async () => ({
      value: { ...currentOrder },
      revision: `rev-${revision}`,
    }));

    const compareAndSet = vi.fn().mockImplementation(
      async (_orderId, expectedRevision, updatedOrder) => {
        if (expectedRevision !== `rev-${revision}`) {
          return { applied: false };
        }

        currentOrder = { ...updatedOrder };
        revision++;

        return { applied: true };
      },
    );

    const ctx = makeContext(getVersioned, compareAndSet);

    const results = await Promise.all([
      claimOrderForRefund(ctx, "cs_test_order_123"),
      claimOrderForRefund(ctx, "cs_test_order_123"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(currentOrder.paymentStatus).toBe("refund_processing");
    expect(compareAndSet).toHaveBeenCalledTimes(2);
  });
});