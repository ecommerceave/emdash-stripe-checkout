import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";

import { recoverCheckoutOrder } from "../src/stripe/recover-checkout-order.js";
import { retrieveCheckoutSession } from "../src/stripe/checkout-session.js";
import {
    createOrder,
    getOrder,
    savePaymentIntentOrderLookup,
} from "../src/orders/storage.js";

vi.mock("../src/stripe/checkout-session.js", () => ({
    retrieveCheckoutSession: vi.fn(),
}));

vi.mock("../src/orders/storage.js", () => ({
    createOrder: vi.fn(),
    getOrder: vi.fn(),
    savePaymentIntentOrderLookup: vi.fn(),
}));

describe("Stripe Checkout order recovery", () => {

    it("rejects an existing refunded order", async () => {
        vi.mocked(retrieveCheckoutSession).mockResolvedValue({
            id: "cs_test_refunded123",
            payment_status: "paid",
            status: "complete",
            mode: "payment",
            client_reference_id: "product_test",
            payment_intent: "pi_test_refunded123",
            amount_total: 2500,
            currency: "usd",
            line_items: {
                has_more: false,
                data: [{
                    quantity: 1,
                    amount_total: 2500,
                    price: {
                        id: "price_test_123",
                        unit_amount: 2500,
                        currency: "usd",
                        product: {
                            id: "prod_test_123",
                            name: "Test Product",
                            metadata: {
                                emdash_content_id: "product_test",
                            },
                        },
                    },
                }],
            },
        });

        vi.mocked(createOrder).mockResolvedValue(false);

        vi.mocked(getOrder).mockResolvedValue({
            id: "cs_test_refunded123",
            stripeSessionId: "cs_test_refunded123",
            stripePaymentIntentId: "pi_test_refunded123",
            productId: "product_test",
            quantity: 1,
            amountTotal: 2500,
            currency: "usd",
            paymentStatus: "refunded",
            customerEmail: null,
            createdAt: "2026-10-23T10:00:00.000Z",
            updatedAt: "2026-10-23T10:00:00.000Z",
            paidAt: "2026-10-23T10:00:00.000Z",
        });

        const ctx = {
            log: { error: vi.fn() },
        } as unknown as PluginContext;

        const result = await recoverCheckoutOrder(
            ctx,
            "cs_test_refunded123",
            "product_test",
            "pi_test_refunded123",
        );

        expect(result).toBeNull();
        expect(createOrder).toHaveBeenCalledOnce();
        expect(getOrder).toHaveBeenCalledWith(
            ctx,
            "cs_test_refunded123",
        );
        expect(savePaymentIntentOrderLookup).not.toHaveBeenCalled();
    });


    it("returns null when the PaymentIntent lookup cannot be saved", async () => {
        vi.mocked(retrieveCheckoutSession).mockResolvedValue({
            id: "cs_test_lookupfail123",
            payment_status: "paid",
            status: "complete",
            mode: "payment",
            client_reference_id: "product_test",
            payment_intent: "pi_test_lookupfail123",
            amount_total: 2500,
            currency: "usd",
            line_items: {
                has_more: false,
                data: [{
                    quantity: 1,
                    amount_total: 2500,
                    price: {
                        id: "price_test_123",
                        unit_amount: 2500,
                        currency: "usd",
                        product: {
                            id: "prod_test_123",
                            name: "Test Product",
                            metadata: {
                                emdash_content_id: "product_test",
                            },
                        },
                    },
                }],
            },
        });

        vi.mocked(createOrder).mockResolvedValue(true);
        vi.mocked(savePaymentIntentOrderLookup).mockRejectedValue(
            new Error("Lookup storage unavailable"),
        );

        const ctx = {
            log: { error: vi.fn() },
        } as unknown as PluginContext;

        const result = await recoverCheckoutOrder(
            ctx,
            "cs_test_lookupfail123",
            "product_test",
            "pi_test_lookupfail123",
        );

        expect(result).toBeNull();
        expect(createOrder).toHaveBeenCalledOnce();
        expect(savePaymentIntentOrderLookup).toHaveBeenCalledWith(
            ctx,
            "pi_test_lookupfail123",
            "cs_test_lookupfail123",
        );
        expect(ctx.log.error).toHaveBeenCalledWith(
            "Stripe Checkout order recovery failed",
            expect.objectContaining({
                sessionId: "cs_test_lookupfail123",
            }),
        );
    });


    it("returns null when order storage fails", async () => {
        vi.mocked(retrieveCheckoutSession).mockResolvedValue({
            id: "cs_test_storagefail123",
            payment_status: "paid",
            status: "complete",
            mode: "payment",
            client_reference_id: "product_test",
            payment_intent: "pi_test_storagefail123",
            amount_total: 2500,
            currency: "usd",
            line_items: {
                has_more: false,
                data: [{
                    quantity: 1,
                    amount_total: 2500,
                    price: {
                        id: "price_test_123",
                        unit_amount: 2500,
                        currency: "usd",
                        product: {
                            id: "prod_test_123",
                            name: "Test Product",
                            metadata: {
                                emdash_content_id: "product_test",
                            },
                        },
                    },
                }],
            },
        });

        vi.mocked(createOrder).mockRejectedValue(
            new Error("Database unavailable"),
        );

        const ctx = {
            log: { error: vi.fn() },
        } as unknown as PluginContext;

        const result = await recoverCheckoutOrder(
            ctx,
            "cs_test_storagefail123",
            "product_test",
            "pi_test_storagefail123",
        );

        expect(result).toBeNull();
        expect(createOrder).toHaveBeenCalledOnce();
        expect(savePaymentIntentOrderLookup).not.toHaveBeenCalled();
        expect(ctx.log.error).toHaveBeenCalledWith(
            "Stripe Checkout order recovery failed",
            expect.objectContaining({
                sessionId: "cs_test_storagefail123",
            }),
        );
    });


    it("rejects an existing order with conflicting product information", async () => {
        vi.mocked(retrieveCheckoutSession).mockResolvedValue({
            id: "cs_test_conflict123",
            payment_status: "paid",
            status: "complete",
            mode: "payment",
            client_reference_id: "product_test",
            payment_intent: "pi_test_conflict123",
            amount_total: 2500,
            currency: "usd",
            line_items: {
                has_more: false,
                data: [{
                    quantity: 1,
                    amount_total: 2500,
                    price: {
                        id: "price_test_123",
                        unit_amount: 2500,
                        currency: "usd",
                        product: {
                            id: "prod_test_123",
                            name: "Test Product",
                            metadata: {
                                emdash_content_id: "product_test",
                            },
                        },
                    },
                }],
            },
        });

        vi.mocked(createOrder).mockResolvedValue(false);

        vi.mocked(getOrder).mockResolvedValue({
            id: "cs_test_conflict123",
            stripeSessionId: "cs_test_conflict123",
            stripePaymentIntentId: "pi_test_conflict123",
            productId: "different_product",
            quantity: 1,
            amountTotal: 2500,
            currency: "usd",
            paymentStatus: "paid",
            customerEmail: null,
            createdAt: "2026-10-23T10:00:00.000Z",
            updatedAt: "2026-10-23T10:00:00.000Z",
            paidAt: "2026-10-23T10:00:00.000Z",
        });

        const ctx = {
            log: { error: vi.fn() },
        } as unknown as PluginContext;

        const result = await recoverCheckoutOrder(
            ctx,
            "cs_test_conflict123",
            "product_test",
            "pi_test_conflict123",
        );

        expect(result).toBeNull();
        expect(createOrder).toHaveBeenCalledOnce();
        expect(getOrder).toHaveBeenCalledOnce();
        expect(savePaymentIntentOrderLookup).not.toHaveBeenCalled();
    });


    it("rejects a mismatched PaymentIntent without creating an order", async () => {
        vi.mocked(retrieveCheckoutSession).mockResolvedValue({
            id: "cs_test_mismatch123",
            payment_status: "paid",
            status: "complete",
            mode: "payment",
            client_reference_id: "product_test",
            payment_intent: "pi_test_actual123",
            amount_total: 2500,
            currency: "usd",
            line_items: {
                has_more: false,
                data: [{
                    quantity: 1,
                    amount_total: 2500,
                    price: {
                        id: "price_test_123",
                        unit_amount: 2500,
                        currency: "usd",
                        product: {
                            id: "prod_test_123",
                            name: "Test Product",
                            metadata: {
                                emdash_content_id: "product_test",
                            },
                        },
                    },
                }],
            },
        });

        const ctx = {
            log: { error: vi.fn() },
        } as unknown as PluginContext;

        const result = await recoverCheckoutOrder(
            ctx,
            "cs_test_mismatch123",
            "product_test",
            "pi_test_different123",
        );

        expect(result).toBeNull();
        expect(createOrder).not.toHaveBeenCalled();
        expect(savePaymentIntentOrderLookup).not.toHaveBeenCalled();
    });

    beforeEach(() => {
        vi.resetAllMocks();
    });


    it("reuses an existing matching order", async () => {
        vi.clearAllMocks();

        vi.mocked(retrieveCheckoutSession).mockResolvedValue({
            id: "cs_test_duplicate123",
            payment_status: "paid",
            status: "complete",
            mode: "payment",
            client_reference_id: "product_test",
            payment_intent: "pi_test_duplicate123",
            amount_total: 2500,
            currency: "usd",
            line_items: {
                has_more: false,
                data: [{
                    quantity: 1,
                    amount_total: 2500,
                    price: {
                        id: "price_test_123",
                        unit_amount: 2500,
                        currency: "usd",
                        product: {
                            id: "prod_test_123",
                            name: "Test Product",
                            metadata: {
                                emdash_content_id: "product_test",
                            },
                        },
                    },
                }],
            },
        });

        vi.mocked(createOrder).mockResolvedValue(false);

        const existingOrder = {
            id: "cs_test_duplicate123",
            stripeSessionId: "cs_test_duplicate123",
            stripePaymentIntentId: "pi_test_duplicate123",
            productId: "product_test",
            quantity: 1,
            amountTotal: 2500,
            currency: "usd",
            paymentStatus: "paid" as const,
            customerEmail: null,
            createdAt: "2026-10-23T10:00:00.000Z",
            updatedAt: "2026-10-23T10:00:00.000Z",
            paidAt: "2026-10-23T10:00:00.000Z",
        };

        vi.mocked(getOrder).mockResolvedValue(existingOrder);
        vi.mocked(savePaymentIntentOrderLookup).mockResolvedValue(undefined);

        const ctx = {
            log: { error: vi.fn() },
        } as unknown as PluginContext;

        const result = await recoverCheckoutOrder(
            ctx,
            "cs_test_duplicate123",
            "product_test",
            "pi_test_duplicate123",
        );

        expect(result).toEqual(existingOrder);
        expect(createOrder).toHaveBeenCalledOnce();
        expect(getOrder).toHaveBeenCalledWith(
            ctx,
            "cs_test_duplicate123",
        );
        expect(savePaymentIntentOrderLookup).toHaveBeenCalledWith(
            ctx,
            "pi_test_duplicate123",
            "cs_test_duplicate123",
        );
    });

    it("recovers a valid paid order", async () => {
        vi.mocked(retrieveCheckoutSession).mockResolvedValue({
            id: "cs_test_123456",
            payment_status: "paid",
            status: "complete",
            mode: "payment",
            client_reference_id: "product_test",
            payment_intent: "pi_test_123456",
            amount_total: 2500,
            currency: "usd",
            customer_details: {
                email: "customer@example.com",
            },
            line_items: {
                has_more: false,
                data: [{
                    quantity: 1,
                    amount_total: 2500,
                    description: "Test Product",
                    price: {
                        id: "price_test_123",
                        product: {
                            id: "prod_test_123",
                            name: "Test Product",
                            metadata: {
                                emdash_content_id: "product_test",
                            },
                        },
                        unit_amount: 2500,
                        currency: "usd",
                    },
                }],
            },
        });

        vi.mocked(createOrder).mockResolvedValue(true);
        vi.mocked(savePaymentIntentOrderLookup).mockResolvedValue(undefined);

        const ctx = {
            log: {
                error: vi.fn(),
            },
        } as unknown as PluginContext;

        const result = await recoverCheckoutOrder(
            ctx,
            "cs_test_123456",
            "product_test",
            "pi_test_123456",
        );

        expect(result).toEqual(
            expect.objectContaining({
                id: "cs_test_123456",
                productId: "product_test",
                paymentStatus: "paid",
                amountTotal: 2500,
                currency: "usd",
            }),
        );

        expect(createOrder).toHaveBeenCalledOnce();
        expect(savePaymentIntentOrderLookup).toHaveBeenCalledWith(
            ctx,
            "pi_test_123456",
            "cs_test_123456",
        );
        expect(getOrder).not.toHaveBeenCalled();
    });
});
