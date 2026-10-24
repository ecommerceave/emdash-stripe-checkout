
import type { PluginContext } from "emdash/plugin";

import {
    createOrder,
    getOrder,
} from "../orders/storage.js";

import type { Order } from "../orders/types.js";
import type { StripeProductState } from "../products/sync.js";
import { getProductContentTypeSlug } from "../products/content-type.js";

import { createStripeSession } from "./stripe-session.js";

// Preserve the existing public type export for compatibility.
export type { StripeCheckoutSession } from "./stripe-session.js";

type CheckoutInput = {
    productId: string;
    returnPath?: string;
    checkoutAttemptId?: string;
};

function isCheckoutInput(input: unknown): input is CheckoutInput {
    if (typeof input !== "object" || input === null) {
        return false;
    }

    const data = input as Record<string, unknown>;

    const returnPathIsValid =
        data.returnPath === undefined ||
        (typeof data.returnPath === "string" &&
            data.returnPath.startsWith("/") &&
            !data.returnPath.startsWith("//"));

    const checkoutAttemptIdIsValid =
        data.checkoutAttemptId === undefined ||
        (typeof data.checkoutAttemptId === "string" &&
            /^[a-zA-Z0-9_-]{8,128}$/.test(data.checkoutAttemptId));

    return (
        typeof data.productId === "string" &&
        data.productId.trim().length > 0 &&
        returnPathIsValid &&
        checkoutAttemptIdIsValid
    );
}

export async function createCheckoutSession(
    routeCtx: { input: unknown },
    ctx: PluginContext,
) {
    if (!isCheckoutInput(routeCtx.input)) {
        return {
            ok: false,
            error: "Invalid checkout request.",
        };
    }

    const stripeSecretKey =
        await ctx.settings.get<string>("stripeSecretKey");

    if (!stripeSecretKey) {
        return {
            ok: false,
            error: "Stripe Secret Key has not been configured.",
        };
    }

    const {
        productId,
        returnPath = "/",
        checkoutAttemptId,
    } = routeCtx.input;

    const siteUrl = new URL(ctx.site.url);
    const returnUrl = new URL(returnPath, siteUrl);

    if (returnUrl.origin !== siteUrl.origin) {
        return {
            ok: false,
            error: "Invalid return path.",
        };
    }

    returnUrl.searchParams.set("checkout", "success");

    const successUrl =
        `${returnUrl.toString()}&session_id={CHECKOUT_SESSION_ID}`;

    returnUrl.searchParams.set("checkout", "cancel");
    const cancelUrl = returnUrl.toString();

    const stripeState = await ctx.kv.get<StripeProductState>(
        `state:product:${productId}`,
    );

    if (!stripeState?.stripePriceId) {
        return {
            ok: false,
            error: "This product is not available for Stripe Checkout.",
        };
    }

    const product = await ctx.content?.get(
        await getProductContentTypeSlug(ctx),
        productId,
    );

    if (
        !product ||
        product.status !== "published" ||
        (product.data?.active !== true && product.data?.active !== 1)
    ) {
        return {
            ok: false,
            error: "This product is currently unavailable for purchase.",
        };
    }

    // Capture the product name at the time of checkout.
    const productName =
        typeof product.data?.name === "string"
            ? product.data.name.trim()
            : "";

    if (!productName) {
        return {
            ok: false,
            error: "This product does not have a valid name.",
        };
    }

    const productPrice = product.data?.price;
    const productCurrency = product.data?.currency;

    if (
        typeof productPrice !== "number" ||
        !Number.isFinite(productPrice) ||
        productPrice < 0 ||
        typeof productCurrency !== "string" ||
        stripeState.price !== productPrice ||
        stripeState.currency !== productCurrency.trim().toLowerCase()
    ) {
        return {
            ok: false,
            error: "This product's price is not synchronized with Stripe.",
        };
    }

    const priceId = stripeState.stripePriceId;

    // Create the Stripe Checkout Session using the dedicated module.
    // This preserves the existing request and idempotency behavior.
    const stripeResult = await createStripeSession(ctx, {
        stripeSecretKey,
        productId,
        priceId,
        successUrl,
        cancelUrl,
        checkoutAttemptId,
    });

    if (!stripeResult.ok) {
        return {
            ok: false,
            error: stripeResult.error,
        };
    }

    const stripeResponse = stripeResult.session;

    // Create the pending order after Stripe returns a valid session.
    const now = new Date().toISOString();

    const order: Order = {
        id: stripeResponse.id!,
        stripeSessionId: stripeResponse.id!,
        productId,
        productName,
        quantity: 1,
        amountTotal: stripeResponse.amount_total ?? null,
        currency: stripeResponse.currency ?? null,
        paymentStatus: "pending",
        customerEmail: null,
        createdAt: now,
        updatedAt: now,
        paidAt: null,
    };

    let orderCreated = false;

    try {
        orderCreated = await createOrder(ctx, order);
    } catch (error) {
        ctx.log.error("Failed to save Stripe Checkout order", {
            sessionId: stripeResponse.id,
            message:
                error instanceof Error
                    ? error.message
                    : String(error),
        });

        return {
            ok: false,
            error:
                "Checkout was created, but the order could not be saved. Please try again.",
        };
    }

    // An idempotent Stripe request may return an existing session.
    if (!orderCreated) {
        const existingOrder = await getOrder(
            ctx,
            stripeResponse.id!,
        );

        if (
            !existingOrder ||
            existingOrder.id !== stripeResponse.id ||
            existingOrder.stripeSessionId !== stripeResponse.id ||
            existingOrder.productId !== productId ||
            existingOrder.paymentStatus !== "pending"
        ) {
            return {
                ok: false,
                error: "An order already exists for this Checkout Session.",
            };
        }

        ctx.log.info("Existing Stripe Checkout session reused", {
            sessionId: stripeResponse.id,
            productId,
        });

        return {
            ok: true,
            sessionId: stripeResponse.id,
            checkoutUrl: stripeResponse.url,
        };
    }

    ctx.log.info("Stripe Checkout session created", {
        sessionId: stripeResponse.id,
        priceId,
        productName,
    });

    return {
        ok: true,
        sessionId: stripeResponse.id,
        checkoutUrl: stripeResponse.url,
    };
}
