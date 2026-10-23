import type { StripeCheckoutSessionDetails } from "./checkout-session.js";

export type ValidatedCheckoutPurchase = {
    sessionId: string;
    paymentIntentId: string;
    productId: string;
    productName: string;
    stripeProductId: string;
    stripePriceId: string;
    quantity: number;
    amountTotal: number;
    currency: string;
    customerEmail: string | null;
};

export function validateCheckoutForRecovery(
    session: StripeCheckoutSessionDetails,
): ValidatedCheckoutPurchase | null {
    if (
        !/^cs_(test_|live_)[a-zA-Z0-9]+$/.test(session.id) ||
        session.payment_status !== "paid" ||
        session.status !== "complete" ||
        session.mode !== "payment" ||
        !session.payment_intent?.startsWith("pi_")
    ) {
        return null;
    }

    const productId = session.client_reference_id;

    if (
        typeof productId !== "string" ||
        !productId.trim() ||
        session.line_items?.has_more !== false ||
        session.line_items.data?.length !== 1
    ) {
        return null;
    }

    const item = session.line_items.data[0];
    const price = item.price;
    const product = price?.product;

    if (
        !price?.id?.startsWith("price_") ||
        !product ||
        typeof product === "string" ||
        !product.id?.startsWith("prod_") ||
        product.metadata?.emdash_content_id !== productId ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity !== 1 ||
        !Number.isSafeInteger(item.amount_total) ||
        !Number.isSafeInteger(session.amount_total) ||
        item.amount_total !== session.amount_total ||
        !Number.isSafeInteger(price.unit_amount) ||
        price.unit_amount !== session.amount_total ||
        typeof price.currency !== "string" ||
        typeof session.currency !== "string" ||
        price.currency.toLowerCase() !== session.currency.toLowerCase() ||
        !/^[a-z]{3}$/.test(session.currency.toLowerCase())
    ) {
        return null;
    }

    return {
        sessionId: session.id,
        paymentIntentId: session.payment_intent,
        productId,
        productName: product.name?.trim() || item.description?.trim() || "",
        stripeProductId: product.id,
        stripePriceId: price.id,
        quantity: 1,
        amountTotal: session.amount_total as number,
        currency: session.currency.toLowerCase(),
        customerEmail: session.customer_details?.email?.trim() || null,
    };
}
