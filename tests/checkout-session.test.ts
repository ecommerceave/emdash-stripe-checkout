import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";

import { retrieveCheckoutSession } from "../src/stripe/checkout-session.js";

describe("Stripe Checkout Session retrieval", () => {
    it("retrieves a valid Checkout Session from Stripe", async () => {
        const session = {
            id: "cs_test_123456",
            payment_status: "paid",
            status: "complete",
            mode: "payment",
            client_reference_id: "product_test",
            payment_intent: "pi_test_123",
            amount_total: 2500,
            currency: "usd",
        };

        const fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify(session), { status: 200 }),
        );

        const ctx = {
            settings: {
                get: vi.fn().mockResolvedValue("sk_test_example"),
            },
            http: { fetch },
        } as unknown as PluginContext;

        const result = await retrieveCheckoutSession(
            ctx,
            "cs_test_123456",
        );

        expect(result).toEqual(session);
        expect(fetch).toHaveBeenCalledWith(
            "https://api.stripe.com/v1/checkout/sessions/cs_test_123456?expand%5B%5D=line_items.data.price.product",
            expect.objectContaining({
                method: "GET",
                headers: {
                    Authorization: "Bearer sk_test_example",
                },
            }),
        );
    });

    it("rejects an invalid Checkout Session ID", async () => {
        const fetch = vi.fn();

        const ctx = {
            settings: {
                get: vi.fn(),
            },
            http: { fetch },
        } as unknown as PluginContext;

        const result = await retrieveCheckoutSession(
            ctx,
            "invalid_session",
        );

        expect(result).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("returns null when Stripe rejects the request", async () => {
        const fetch = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({ error: { message: "Not found" } }),
                { status: 404 },
            ),
        );

        const ctx = {
            settings: {
                get: vi.fn().mockResolvedValue("sk_test_example"),
            },
            http: { fetch },
        } as unknown as PluginContext;

        const result = await retrieveCheckoutSession(
            ctx,
            "cs_test_missing123",
        );

        expect(result).toBeNull();
    });

    it("rejects a mismatched Checkout Session ID", async () => {
        const fetch = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({ id: "cs_test_different123" }),
                { status: 200 },
            ),
        );

        const ctx = {
            settings: {
                get: vi.fn().mockResolvedValue("sk_test_example"),
            },
            http: { fetch },
        } as unknown as PluginContext;

        const result = await retrieveCheckoutSession(
            ctx,
            "cs_test_expected123",
        );

        expect(result).toBeNull();
    });
});
