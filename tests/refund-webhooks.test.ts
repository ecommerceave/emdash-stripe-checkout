import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";

import { handleStripeWebhook } from "../src/stripe/webhook-handler.js";
import { verifyStripeWebhookSignature } from "../src/stripe/webhooks.js";

import {
    getOrder,
    updateOrder,
    getOrderByPaymentIntent,
    savePaymentIntentOrderLookup,
} from "../src/orders/storage.js";

import { syncOrderRefunds } from "../src/orders/refund-sync.js";

vi.mock("../src/stripe/webhooks.js", () => ({
    verifyStripeWebhookSignature: vi.fn(),
}));

vi.mock("../src/orders/storage.js", () => ({
    getOrderByPaymentIntent: vi.fn(),
    getOrder: vi.fn(),
    updateOrder: vi.fn(),
    savePaymentIntentOrderLookup: vi.fn(),
}));

vi.mock("../src/orders/refund-sync.js", () => ({
    syncOrderRefunds: vi.fn(),
}));

describe("Stripe refund webhook handling", () => {
    it("synchronizes an order when Stripe reports a refund", async () => {
        vi.mocked(verifyStripeWebhookSignature).mockResolvedValue(true);

        vi.mocked(getOrderByPaymentIntent).mockResolvedValue({
            id: "cs_test_refund",
            stripeSessionId: "cs_test_refund",
            stripePaymentIntentId: "pi_test_refund",
        } as Awaited<ReturnType<typeof getOrderByPaymentIntent>> & { id: string });

        vi.mocked(syncOrderRefunds).mockResolvedValue(true);

        const event = {
            id: "evt_test_refund",
            type: "refund.created",
            data: {
                object: {
                    id: "re_test_refund",
                    payment_intent: "pi_test_refund",
                },
            },
        };

        const input = new TextEncoder().encode(JSON.stringify(event));

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
                input,
                request: {
                    headers: {
                        "stripe-signature": "test_signature",
                    },
                },
            },
            ctx,
        );

        expect(response.status).toBe(200);
        expect(getOrderByPaymentIntent).toHaveBeenCalledWith(
            ctx,
            "pi_test_refund",
        );
        expect(syncOrderRefunds).toHaveBeenCalledWith(
            ctx,
            "cs_test_refund",
        );
    });

    it("returns 500 when a refund has no matching order", async () => {
        vi.mocked(verifyStripeWebhookSignature).mockResolvedValue(true);
        vi.mocked(getOrderByPaymentIntent).mockResolvedValue(null);

        vi.mocked(syncOrderRefunds).mockClear();

        const event = {
            id: "evt_test_unknown_refund",
            type: "refund.created",
            data: {
                object: {
                    id: "re_test_unknown",
                    payment_intent: "pi_test_unknown",
                },
            },
        };

        const input = new TextEncoder().encode(JSON.stringify(event));

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
                input,
                request: {
                    headers: {
                        "stripe-signature": "test_signature",
                    },
                },
            },
            ctx,
        );

        expect(response.status).toBe(500);

        expect(getOrderByPaymentIntent).toHaveBeenCalledWith(
            ctx,
            "pi_test_unknown",
        );

        expect(syncOrderRefunds).not.toHaveBeenCalled();
    });

    it("returns 500 when refund synchronization fails", async () => {
        vi.mocked(verifyStripeWebhookSignature).mockResolvedValue(true);

        vi.mocked(getOrderByPaymentIntent).mockResolvedValue({
            id: "cs_test_sync_failure",
            stripeSessionId: "cs_test_sync_failure",
            stripePaymentIntentId: "pi_test_sync_failure",
        } as Awaited<ReturnType<typeof getOrderByPaymentIntent>> & { id: string });

        vi.mocked(syncOrderRefunds).mockRejectedValue(
            new Error("Stripe API temporarily unavailable"),
        );

        const event = {
            id: "evt_test_sync_failure",
            type: "refund.updated",
            data: {
                object: {
                    id: "re_test_sync_failure",
                    payment_intent: "pi_test_sync_failure",
                },
            },
        };

        const input = new TextEncoder().encode(JSON.stringify(event));

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
                input,
                request: {
                    headers: {
                        "stripe-signature": "test_signature",
                    },
                },
            },
            ctx,
        );

        expect(response.status).toBe(500);

        expect(syncOrderRefunds).toHaveBeenCalledWith(
            ctx,
            "cs_test_sync_failure",
        );
    });

    it("saves the PaymentIntent lookup for an already-paid order", async () => {
        vi.clearAllMocks();

        vi.mocked(verifyStripeWebhookSignature).mockResolvedValue(true);

        const order = {
            id: "cs_test_already_paid",
            stripeSessionId: "cs_test_already_paid",
            stripePaymentIntentId: "pi_test_already_paid",
            productId: "product_test",
            paymentStatus: "paid",
            customerEmail: "customer@example.com",
        };

        vi.mocked(getOrder).mockResolvedValue(
            order as Awaited<ReturnType<typeof getOrder>>,
        );

        vi.mocked(savePaymentIntentOrderLookup).mockResolvedValue(undefined);

        const event = {
            id: "evt_test_already_paid",
            type: "checkout.session.completed",
            data: {
                object: {
                    id: "cs_test_already_paid",
                    payment_status: "paid",
                    payment_intent: "pi_test_already_paid",
                    client_reference_id: "product_test",
                    customer_details: {
                        email: "customer@example.com",
                    },
                },
            },
        };

        const input = new TextEncoder().encode(JSON.stringify(event));

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
                input,
                request: {
                    headers: {
                        "stripe-signature": "test_signature",
                    },
                },
            },
            ctx,
        );

        expect(response.status).toBe(200);

        expect(updateOrder).not.toHaveBeenCalled();

        expect(savePaymentIntentOrderLookup).toHaveBeenCalledWith(
            ctx,
            "pi_test_already_paid",
            "cs_test_already_paid",
        );
    });
});