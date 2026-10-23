import { describe, expect, it } from "vitest";
import {
    validateCheckoutForRecovery,
} from "../src/stripe/checkout-recovery.js";
import type {
    StripeCheckoutSessionDetails,
} from "../src/stripe/checkout-session.js";

function validSession(): StripeCheckoutSessionDetails {
    return {
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
    };
}

describe("Stripe Checkout recovery validation", () => {
    it("accepts a valid paid Checkout Session", () => {
        const result = validateCheckoutForRecovery(validSession());

        expect(result).toEqual({
            sessionId: "cs_test_123456",
            paymentIntentId: "pi_test_123456",
            productId: "product_test",
            productName: "Test Product",
            stripeProductId: "prod_test_123",
            stripePriceId: "price_test_123",
            quantity: 1,
            amountTotal: 2500,
            currency: "usd",
            customerEmail: "customer@example.com",
        });
    });

    it("rejects an unpaid Checkout Session", () => {
        const session = validSession();
        session.payment_status = "unpaid";

        expect(validateCheckoutForRecovery(session)).toBeNull();
    });

    it("rejects a mismatched product", () => {
        const session = validSession();
        const product = session.line_items!.data![0].price!.product;

        if (typeof product === "object" && product !== null) {
            product.metadata = {
                emdash_content_id: "different_product",
            };
        }

        expect(validateCheckoutForRecovery(session)).toBeNull();
    });

    it("rejects a mismatched payment amount", () => {
        const session = validSession();
        session.amount_total = 100;

        expect(validateCheckoutForRecovery(session)).toBeNull();
    });

    it("rejects multiple line items", () => {
        const session = validSession();
        session.line_items!.data!.push(
            structuredClone(session.line_items!.data![0]),
        );

        expect(validateCheckoutForRecovery(session)).toBeNull();
    });

    it("rejects incomplete line-item pagination", () => {
        const session = validSession();
        session.line_items!.has_more = true;

        expect(validateCheckoutForRecovery(session)).toBeNull();
    });

    it("rejects an invalid quantity", () => {
        const session = validSession();
        session.line_items!.data![0].quantity = 2;

        expect(validateCheckoutForRecovery(session)).toBeNull();
    });

    it("rejects mismatched currencies", () => {
        const session = validSession();
        session.currency = "eur";

        expect(validateCheckoutForRecovery(session)).toBeNull();
    });
});
