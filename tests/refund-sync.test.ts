import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";

import { reconcileOrderRefunds } from "../src/orders/refund-sync.js";
import type { Order, OrderRefund } from "../src/orders/types.js";

describe("Stripe refund reconciliation", () => {
    it("marks an order refunded when the full amount is refunded", async () => {
    const order: Order = {
      id: "cs_test_full_refund",
      stripeSessionId: "cs_test_full_refund",
      stripePaymentIntentId: "pi_test_full_refund",
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

    const refunds: OrderRefund[] = [
      {
        id: "re_test_full_refund",
        amount: 10000,
        currency: "usd",
        status: "succeeded",
        createdAt: "2026-10-16T13:00:00.000Z",
        updatedAt: "2026-10-16T13:00:00.000Z",
      },
    ];

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

    const result = await reconcileOrderRefunds(
      ctx,
      order.id,
      "pi_test_full_refund",
      refunds,
    );

    expect(result).toBe(true);

    const updatedOrder = compareAndSet.mock.calls[0][2] as Order;

    expect(updatedOrder.paymentStatus).toBe("refunded");
    expect(updatedOrder.refundedAmount).toBe(10000);
    expect(updatedOrder.refunds).toHaveLength(1);
    expect(updatedOrder.refundedAt).toBe(
        "2026-10-16T13:00:00.000Z",
    );
    });

    it("keeps an order paid when only part of the payment is refunded", async () => {
    const order: Order = {
        id: "cs_test_partial_sync",
        stripeSessionId: "cs_test_partial_sync",
        stripePaymentIntentId: "pi_test_partial_sync",
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

    const refunds: OrderRefund[] = [
        {
        id: "re_test_partial_sync",
        amount: 2500,
        currency: "usd",
        status: "succeeded",
        createdAt: "2026-10-16T13:00:00.000Z",
        updatedAt: "2026-10-16T13:00:00.000Z",
        },
    ];

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

    const result = await reconcileOrderRefunds(
        ctx,
        order.id,
        "pi_test_partial_sync",
        refunds,
    );

    expect(result).toBe(true);

    const updatedOrder = compareAndSet.mock.calls[0][2] as Order;

    expect(updatedOrder.paymentStatus).toBe("paid");
    expect(updatedOrder.refundedAmount).toBe(2500);
    expect(updatedOrder.refunds).toHaveLength(1);
    expect(updatedOrder.refundedAt).toBeUndefined();
    });

    it("tracks a pending refund without counting it as refunded", async () => {
    const order: Order = {
        id: "cs_test_pending_sync",
        stripeSessionId: "cs_test_pending_sync",
        stripePaymentIntentId: "pi_test_pending_sync",
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

    const refunds: OrderRefund[] = [
        {
        id: "re_test_pending_sync",
        amount: 2500,
        currency: "usd",
        status: "pending",
        createdAt: "2026-10-16T13:00:00.000Z",
        updatedAt: "2026-10-16T13:00:00.000Z",
        },
    ];

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

    const result = await reconcileOrderRefunds(
        ctx,
        order.id,
        "pi_test_pending_sync",
        refunds,
    );

    expect(result).toBe(true);

    const updatedOrder = compareAndSet.mock.calls[0][2] as Order;

    expect(updatedOrder.paymentStatus).toBe("refund_pending");
    expect(updatedOrder.refundedAmount).toBe(0);
    expect(updatedOrder.refunds).toHaveLength(1);
    expect(updatedOrder.refunds?.[0]?.status).toBe("pending");
    expect(updatedOrder.refundedAt).toBeUndefined();
    });

    it("preserves historical refunds when a Stripe snapshot is incomplete", async () => {
    const order: Order = {
        id: "cs_test_historical",
        stripeSessionId: "cs_test_historical",
        stripePaymentIntentId: "pi_test_historical",
        productId: "product_test",
        quantity: 1,
        amountTotal: 10000,
        currency: "usd",
        paymentStatus: "refunded",
        customerEmail: null,
        createdAt: "2026-10-16T12:00:00.000Z",
        updatedAt: "2026-10-16T13:00:00.000Z",
        paidAt: "2026-10-16T12:00:00.000Z",
        stripeRefundId: "re_historical",
        refundStatus: "succeeded",
        refundedAt: "2026-10-16T13:00:00.000Z",
        refunds: [
        {
            id: "re_historical",
            amount: 10000,
            currency: "usd",
            status: "succeeded",
            createdAt: "2026-10-16T13:00:00.000Z",
            updatedAt: "2026-10-16T13:00:00.000Z",
        },
        ],
        refundedAmount: 10000,
    };

    const compareAndSet = vi.fn();

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

    // Simulate a Stripe response missing the historical refund.
    const result = await reconcileOrderRefunds(
        ctx,
        order.id,
        "pi_test_historical",
        [],
    );

    expect(result).toBe(false);

    // The existing order must remain untouched.
    expect(compareAndSet).not.toHaveBeenCalled();
    });

    it("rejects a stale Stripe snapshot when the order revision has changed", async () => {
        const order: Order = {
            id: "cs_test_stale_snapshot",
            stripeSessionId: "cs_test_stale_snapshot",
            stripePaymentIntentId: "pi_test_stale_snapshot",
            productId: "product_test",
            quantity: 1,
            amountTotal: 10000,
            currency: "usd",
            paymentStatus: "refunded",
            customerEmail: null,
            createdAt: "2026-10-16T12:00:00.000Z",
            updatedAt: "2026-10-16T13:00:00.000Z",
            paidAt: "2026-10-16T12:00:00.000Z",
            refunds: [
            {
                id: "re_test_stale_snapshot",
                amount: 10000,
                currency: "usd",
                status: "succeeded",
                createdAt: "2026-10-16T13:00:00.000Z",
                updatedAt: "2026-10-16T13:00:00.000Z",
            },
            ],
            refundedAmount: 10000,
        };

        const compareAndSet = vi.fn();

        const ctx = {
            storage: {
            orders: {
                getVersioned: vi.fn().mockResolvedValue({
                value: order,
                revision: "revision_2",
                }),
                compareAndSet,
            },
            },
        } as unknown as PluginContext;

        // This snapshot was fetched when the order was at revision_1.
        const staleRefunds: OrderRefund[] = [
            {
            id: "re_test_stale_snapshot",
            amount: 10000,
            currency: "usd",
            status: "pending",
            createdAt: "2026-10-16T13:00:00.000Z",
            updatedAt: "2026-10-16T13:00:00.000Z",
            },
        ];

        const result = await reconcileOrderRefunds(
            ctx,
            order.id,
            "pi_test_stale_snapshot",
            staleRefunds,
            "revision_1",
        );

        expect(result).toBe(false);
        expect(compareAndSet).not.toHaveBeenCalled();
    });

    it("handles a concurrent refund update without overwriting the order", async () => {
        const refund: OrderRefund = {
            id: "re_test_concurrent",
            amount: 10000,
            currency: "usd",
            status: "succeeded",
            createdAt: "2026-10-16T13:00:00.000Z",
            updatedAt: "2026-10-16T13:00:00.000Z",
        };

        const order: Order = {
            id: "cs_test_concurrent",
            stripeSessionId: "cs_test_concurrent",
            stripePaymentIntentId: "pi_test_concurrent",
            productId: "product_test",
            quantity: 1,
            amountTotal: 10000,
            currency: "usd",
            paymentStatus: "refunded",
            customerEmail: null,
            createdAt: "2026-10-16T12:00:00.000Z",
            updatedAt: "2026-10-16T13:00:00.000Z",
            paidAt: "2026-10-16T12:00:00.000Z",
            refunds: [refund],
            refundedAmount: 10000,
        };

        const compareAndSet = vi.fn();

        const ctx = {
            storage: {
                orders: {
                    getVersioned: vi.fn().mockResolvedValue({
                        value: order,
                        revision: "revision_2",
                    }),
                    compareAndSet,
                },
            },
        } as unknown as PluginContext;

        // Another webhook already synchronized this refund.
        // Our request began when the order was at revision_1.
        const result = await reconcileOrderRefunds(
            ctx,
            order.id,
            "pi_test_concurrent",
            [refund],
            "revision_1",
        );

        expect(result).toBe(true);
        expect(compareAndSet).not.toHaveBeenCalled();
    });
});