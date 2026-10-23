import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";
import type { Order } from "../src/orders/types.js";

import { buildOrderDetailsPage } from "../src/admin/order-details.js";

describe("Order details page", () => {
    it("displays an order not found message when the order does not exist", async () => {
        const get = vi.fn().mockResolvedValue(null);

        const ctx = {
            storage: {
                orders: {
                    get,
                },
            },
        } as unknown as PluginContext;

        const result = await buildOrderDetailsPage(
            ctx,
            "cs_test_missing_order",
        );

        expect(get).toHaveBeenCalledWith("cs_test_missing_order");

        expect(result.blocks).toEqual([
            {
                type: "header",
                text: "Order Not Found",
            },
            {
                type: "section",
                text: "The requested order could not be found.",
            },
            {
                type: "actions",
                elements: [
                    {
                        type: "button",
                        action_id: "stripe-orders-back",
                        label: "Back to Orders",
                    },
                ],
            },
        ]);
    });
    it("displays the correct details for a paid order", async () => {
        const order: Order = {
            id: "cs_test_paid_order",
            stripeSessionId: "cs_test_paid_order",
            stripePaymentIntentId: "pi_test_paid_order",
            productId: "product_test",
            productName: "Test T-Shirt",
            quantity: 1,
            amountTotal: 2500,
            currency: "usd",
            paymentStatus: "paid",
            customerEmail: "customer@example.com",
            createdAt: "2026-10-16T12:00:00.000Z",
            updatedAt: "2026-10-16T12:00:00.000Z",
            paidAt: "2026-10-16T12:00:00.000Z",
        };

        const get = vi.fn().mockResolvedValue(order);

        const ctx = {
            storage: {
                orders: {
                    get,
                },
            },
        } as unknown as PluginContext;

        const result = await buildOrderDetailsPage(ctx, order.id);

        expect(get).toHaveBeenCalledWith(order.id);

        const output = JSON.stringify(result.blocks);

        expect(output).toContain("Test T-Shirt");
        expect(output).toContain("customer@example.com");
        expect(output).toContain("Total Paid");
        expect(output).toContain("25.00 USD");
        expect(output).toContain("Paid");
        expect(output).toContain("Payment completed");
    });

    it("displays partial refund details and remaining balance", async () => {
        const order: Order = {
            id: "cs_test_partial_refund",
            stripeSessionId: "cs_test_partial_refund",
            stripePaymentIntentId: "pi_test_partial_refund",
            productId: "product_test",
            productName: "Test Product",
            quantity: 1,
            amountTotal: 10000,
            currency: "usd",
            paymentStatus: "paid",
            customerEmail: "customer@example.com",
            createdAt: "2026-10-16T12:00:00.000Z",
            updatedAt: "2026-10-16T13:00:00.000Z",
            paidAt: "2026-10-16T12:00:00.000Z",
            refundedAmount: 2500,
            refunds: [
                {
                    id: "re_test_partial_refund",
                    amount: 2500,
                    currency: "usd",
                    status: "succeeded",
                    createdAt: "2026-10-16T13:00:00.000Z",
                    updatedAt: "2026-10-16T13:00:00.000Z",
                },
            ],
        };

        const get = vi.fn().mockResolvedValue(order);

        const ctx = {
            storage: {
                orders: {
                    get,
                },
            },
        } as unknown as PluginContext;

        const result = await buildOrderDetailsPage(ctx, order.id);
        const output = JSON.stringify(result.blocks);

        expect(output).toContain("Refund Information");
        expect(output).toContain("Refund History");
        expect(output).toContain("25.00 USD");
        expect(output).toContain("75.00 USD");
        expect(output).toContain("re_test_partial_refund");
        expect(output).toContain("Succeeded");
    });

    it("displays full refund details with a zero remaining balance", async () => {
        const order: Order = {
            id: "cs_test_full_refund",
            stripeSessionId: "cs_test_full_refund",
            stripePaymentIntentId: "pi_test_full_refund",
            productId: "product_test",
            productName: "Test Product",
            quantity: 1,
            amountTotal: 10000,
            currency: "usd",
            paymentStatus: "refunded",
            customerEmail: "customer@example.com",
            createdAt: "2026-10-16T12:00:00.000Z",
            updatedAt: "2026-10-16T14:00:00.000Z",
            paidAt: "2026-10-16T12:00:00.000Z",
            stripeRefundId: "re_test_full_refund",
            refundStatus: "succeeded",
            refundedAmount: 10000,
            refundedAt: "2026-10-16T14:00:00.000Z",
            refunds: [
                {
                    id: "re_test_full_refund",
                    amount: 10000,
                    currency: "usd",
                    status: "succeeded",
                    createdAt: "2026-10-16T14:00:00.000Z",
                    updatedAt: "2026-10-16T14:00:00.000Z",
                },
            ],
        };

        const get = vi.fn().mockResolvedValue(order);

        const ctx = {
            storage: {
                orders: {
                    get,
                },
            },
        } as unknown as PluginContext;

        const result = await buildOrderDetailsPage(ctx, order.id);
        const output = JSON.stringify(result.blocks);

        expect(get).toHaveBeenCalledWith(order.id);
        expect(output).toContain("Refund Information");
        expect(output).toContain("Refund History");
        expect(output).toContain('"value":"Refunded"');
        expect(output).toContain('"value":"100.00 USD"');
        expect(output).toContain('"value":"0.00 USD"');
        expect(output).toContain("re_test_full_refund");
        expect(output).toContain("Oct 16, 2026, 2:00 PM UTC");
    });

});
