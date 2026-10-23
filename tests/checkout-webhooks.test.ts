import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";

import { handleStripeWebhook } from "../src/stripe/webhook-handler.js";
import { verifyStripeWebhookSignature } from "../src/stripe/webhooks.js";
import { getOrder } from "../src/orders/storage.js";
import { recoverCheckoutOrder } from "../src/stripe/recover-checkout-order.js";

vi.mock("../src/stripe/webhooks.js", () => ({
    verifyStripeWebhookSignature: vi.fn(),
}));

vi.mock("../src/stripe/recover-checkout-order.js", () => ({
    recoverCheckoutOrder: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/orders/storage.js", () => ({
    createOrder: vi.fn(),
    getOrder: vi.fn(),
    updateOrder: vi.fn(),
    savePaymentIntentOrderLookup: vi.fn(),
}));

describe("Stripe Checkout webhook handling", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(recoverCheckoutOrder).mockResolvedValue(null);
    });


    it("recovers a missing order for a paid Checkout Session", async () => {
        vi.clearAllMocks();

        vi.mocked(verifyStripeWebhookSignature).mockResolvedValue(true);
        vi.mocked(getOrder).mockResolvedValue(null);

        const recoveredOrder = {
            id: "cs_test_recovered123",
            stripeSessionId: "cs_test_recovered123",
            stripePaymentIntentId: "pi_test_recovered123",
            productId: "product_test",
            quantity: 1,
            amountTotal: 2500,
            currency: "usd",
            paymentStatus: "paid" as const,
            customerEmail: "customer@example.com",
            createdAt: "2026-10-23T10:00:00.000Z",
            updatedAt: "2026-10-23T10:00:00.000Z",
            paidAt: "2026-10-23T10:00:00.000Z",
        };

        vi.mocked(recoverCheckoutOrder).mockResolvedValue(recoveredOrder);

        const event = {
            id: "evt_test_recovered123",
            type: "checkout.session.completed",
            data: {
                object: {
                    id: "cs_test_recovered123",
                    payment_status: "paid",
                    client_reference_id: "product_test",
                    payment_intent: "pi_test_recovered123",
                    customer_details: {
                        email: "customer@example.com",
                    },
                },
            },
        };

        const ctx = {
            settings: {
                get: vi.fn().mockResolvedValue("whsec_test_secret"),
            },
            log: {
                info: vi.fn(),
                error: vi.fn(),
            },
        } as unknown as PluginContext;

        const response = await handleStripeWebhook(
            {
                input: new TextEncoder().encode(JSON.stringify(event)),
                request: {
                    headers: {
                        "stripe-signature": "test_signature",
                    },
                },
            },
            ctx,
        );

        expect(response.status).toBe(200);
        expect(recoverCheckoutOrder).toHaveBeenCalledWith(
            ctx,
            "cs_test_recovered123",
            "product_test",
            "pi_test_recovered123",
        );
        expect(ctx.log.error).not.toHaveBeenCalled();
    });

    it("returns 500 when a paid Checkout Session has no matching order", async () => {
        vi.mocked(verifyStripeWebhookSignature).mockResolvedValue(true);
        vi.mocked(getOrder).mockResolvedValue(null);

        const event = {
            id: "evt_test_missing_order",
            type: "checkout.session.completed",
            data: {
                object: {
                    id: "cs_test_missing_order",
                    payment_status: "paid",
                    client_reference_id: "product_test",
                    payment_intent: "pi_test_missing_order",
                    customer_details: {
                        email: "customer@example.com",
                    },
                },
            },
        };

        const ctx = {
            settings: {
                get: vi.fn().mockResolvedValue("whsec_test_secret"),
            },
            log: {
                info: vi.fn(),
                error: vi.fn(),
            },
        } as unknown as PluginContext;

        const response = await handleStripeWebhook(
            {
                input: new TextEncoder().encode(JSON.stringify(event)),
                request: {
                    headers: {
                        "stripe-signature": "test_signature",
                    },
                },
            },
            ctx,
        );

        expect(response.status).toBe(500);
        expect(getOrder).toHaveBeenCalledWith(
            ctx,
            "cs_test_missing_order",
        );
        expect(ctx.log.error).toHaveBeenCalledWith(
            "Stripe webhook: matching order not found",
            expect.objectContaining({
                sessionId: "cs_test_missing_order",
            }),
        );
    });
});
