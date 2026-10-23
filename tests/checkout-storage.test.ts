import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";

import { createOrder } from "../src/orders/storage.js";
import { createCheckoutSession } from "../src/checkout/handler.js";

describe("Checkout order storage", () => {
    it("propagates an order storage failure", async () => {
        const compareAndSet = vi.fn().mockRejectedValue(
            new Error("Database unavailable"),
        );

        const ctx = {
            storage: {
                orders: {
                    compareAndSet,
                },
            },
        } as unknown as PluginContext;

        const order = {
            id: "cs_test_storage_failure",
            stripeSessionId: "cs_test_storage_failure",
            productId: "product_test",
            quantity: 1,
            amountTotal: 2500,
            currency: "usd",
            paymentStatus: "pending" as const,
            customerEmail: null,
            createdAt: "2026-10-23T12:00:00.000Z",
            updatedAt: "2026-10-23T12:00:00.000Z",
            paidAt: null,
        };

        await expect(createOrder(ctx, order)).rejects.toThrow(
            "Database unavailable",
        );

        expect(compareAndSet).toHaveBeenCalledWith(
            order.id,
            null,
            order,
        );
    });
});


describe("Checkout handler storage failures", () => {
    it("returns an error when Stripe creates a session but order storage fails", async () => {
        const compareAndSet = vi.fn().mockRejectedValue(
            new Error("Database unavailable"),
        );

        const fetch = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    id: "cs_test_storage_failure",
                    url: "https://checkout.stripe.com/c/pay/cs_test_storage_failure",
                    amount_total: 2500,
                    currency: "usd",
                }),
                {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                    },
                },
            ),
        );

        const logError = vi.fn();

        const ctx = {
            settings: {
                get: vi.fn().mockImplementation(async (key: string) => {
                    if (key === "stripeSecretKey") return "sk_test_example";
                    return undefined;
                }),
            },
            site: {
                url: "https://example.com",
            },
            kv: {
                get: vi.fn().mockResolvedValue({
                    stripePriceId: "price_test_123",
                    price: 25,
                    currency: "usd",
                }),
            },
            content: {
                get: vi.fn().mockResolvedValue({
                    status: "published",
                    data: {
                        name: "Test Product",
                        price: 25,
                        currency: "USD",
                        active: true,
                    },
                }),
            },
            http: { fetch },
            storage: {
                orders: { compareAndSet },
            },
            log: {
                error: logError,
            },
        } as unknown as PluginContext;

        const result = await createCheckoutSession(
            {
                input: {
                    productId: "product_test",
                    returnPath: "/product-test",
                },
            },
            ctx,
        );

        expect(result).toEqual({
            ok: false,
            error: "Checkout was created, but the order could not be saved. Please try again.",
        });

        expect(fetch).toHaveBeenCalledOnce();
        expect(compareAndSet).toHaveBeenCalledOnce();
        expect(logError).toHaveBeenCalledOnce();
    });
});
