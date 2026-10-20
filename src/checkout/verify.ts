import type { PluginContext } from "emdash/plugin";

import {
    getOrder,
    updateOrder,
    savePaymentIntentOrderLookup,
} from "../orders/storage.js";

import type { Order } from "../orders/types.js";
import type { StripeCheckoutSession } from "./handler.js";

type VerifyCheckoutInput = {
    sessionId: string;
    productId: string;
};

function isVerifyCheckoutInput(value: unknown): value is VerifyCheckoutInput {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const data = value as Record<string, unknown>;

    return (
        typeof data.sessionId === "string" &&
        data.sessionId.startsWith("cs_") &&
        data.sessionId.trim().length > 3 &&
        typeof data.productId === "string" &&
        data.productId.trim().length > 0
    );
}

export async function verifyCheckoutSession(
    routeCtx: { input: unknown },
    ctx: PluginContext,
) {
    if (!isVerifyCheckoutInput(routeCtx.input)) {
        return {
            ok: false,
            error: "Invalid Checkout Session.",
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

    if (!ctx.http) {
        return {
            ok: false,
            error: "Network access is not available.",
        };
    }

    const { sessionId, productId } = routeCtx.input;

    const response = await ctx.http.fetch(
        `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
        {
            method: "GET",
            headers: {
                Authorization: `Bearer ${stripeSecretKey}`,
            },
        },
    );

    const stripeResponse =
        (await response.json()) as StripeCheckoutSession;

    if (!response.ok) {
        ctx.log.error("Stripe Checkout session verification failed", {
            status: response.status,
            sessionId,
            message: stripeResponse.error?.message,
        });

        return {
            ok: false,
            error: "Checkout Session could not be verified.",
        };
    }

    if (
        stripeResponse.id !== sessionId ||
        stripeResponse.client_reference_id !== productId
    ) {
        ctx.log.warn("Stripe Checkout session mismatch", {
            sessionId,
            expectedProductId: productId,
        });

        return {
            ok: false,
            error: "Checkout Session does not match this product.",
        };
    }

    if (stripeResponse.payment_status === "paid") {
        const order = await getOrder(ctx, sessionId);

        if (!order) {
            ctx.log.error(
                "Paid Stripe Checkout Session has no matching order",
                { sessionId },
            );

            return {
                ok: false,
                error: "Payment was confirmed, but the order was not found.",
            };
        }

        if (
            order.productId !== productId ||
            order.stripeSessionId !== sessionId
        ) {
            return {
                ok: false,
                error: "Order does not match this Checkout Session.",
            };
        }

        // Stripe provides customer details after checkout is completed.
        const customerEmail =
            stripeResponse.customer_details?.email?.trim() || null;

        // Only fill the email if the order does not already have one.
        const shouldUpdateEmail =
            !order.customerEmail && Boolean(customerEmail);

        // Only transition an order from pending to paid.
        // Never overwrite an existing refund or other payment status.
        const shouldMarkPaid = order.paymentStatus === "pending";

        // Save the PaymentIntent ID without overwriting an existing value.
        const shouldSavePaymentIntent =
            !order.stripePaymentIntentId &&
            typeof stripeResponse.payment_intent === "string" &&
            stripeResponse.payment_intent.startsWith("pi_");

        if (shouldMarkPaid || shouldUpdateEmail || shouldSavePaymentIntent) {
            const updates: Partial<Order> = {};

            if (shouldSavePaymentIntent) {
                updates.stripePaymentIntentId = stripeResponse.payment_intent;
            }

            if (shouldMarkPaid) {
                updates.paymentStatus = "paid";
                updates.paidAt = new Date().toISOString();
            }

            if (shouldUpdateEmail && customerEmail) {
                updates.customerEmail = customerEmail;
            }

            const updated = await updateOrder(
                ctx,
                sessionId,
                updates,
            );

            if (!updated) {
                ctx.log.error(
                    "Stripe Checkout order update failed",
                    { sessionId },
                );

                return {
                    ok: false,
                    error: "Payment was confirmed, but the order could not be updated.",
                };
            }

            if (shouldSavePaymentIntent && stripeResponse.payment_intent) {
                await savePaymentIntentOrderLookup(
                    ctx,
                    stripeResponse.payment_intent,
                    sessionId,
                );
            }
            
            ctx.log.info("Stripe Checkout order verified", {
                orderId: order.id,
                paymentStatus: shouldMarkPaid
                    ? "paid"
                    : order.paymentStatus,
                customerEmailUpdated: shouldUpdateEmail,
            });
        }
    }

    return {
        ok: true,
        sessionId: stripeResponse.id,
        paid: stripeResponse.payment_status === "paid",
        paymentStatus: stripeResponse.payment_status,
    };
}
