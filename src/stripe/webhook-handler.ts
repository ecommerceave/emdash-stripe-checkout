import { pluginResponse, type PluginContext } from "emdash/plugin";

import { verifyStripeWebhookSignature } from "./webhooks.js";
import {
    handleCheckoutWebhook,
    type CheckoutWebhookEvent,
} from "./checkout-webhook.js";
import {
    handleRefundWebhook,
    type RefundWebhookEvent,
} from "./refund-webhook.js";

type StripeWebhookEvent = CheckoutWebhookEvent | RefundWebhookEvent;

export async function handleStripeWebhook(
    routeCtx: {
        input: Uint8Array;
        request: {
            headers: {
                "stripe-signature"?: string;
            };
        };
    },
    ctx: PluginContext,
) {
    const webhookSecret =
        await ctx.settings.get<string>("stripeWebhookSecret");

    if (!webhookSecret) {
        ctx.log.error("Stripe webhook signing secret is not configured.");

        return pluginResponse({
            status: 503,
            headers: {
                "Content-Type": "application/json",
            },
            body: {
                kind: "text",
                value: JSON.stringify({
                    ok: false,
                    error: "Webhook is not configured.",
                }),
            },
        });
    }

    const signature =
        routeCtx.request.headers["stripe-signature"];

    if (!signature) {
        return pluginResponse({
            status: 400,
            headers: {
                "Content-Type": "application/json",
            },
            body: {
                kind: "text",
                value: JSON.stringify({
                    ok: false,
                    error: "Missing Stripe signature.",
                }),
            },
        });
    }

    const valid = await verifyStripeWebhookSignature(
        routeCtx.input,
        signature,
        webhookSecret,
    );

    if (!valid) {
        return pluginResponse({
            status: 400,
            headers: {
                "Content-Type": "application/json",
            },
            body: {
                kind: "text",
                value: JSON.stringify({
                    ok: false,
                    error: "Invalid Stripe signature.",
                }),
            },
        });
    }

    let event: StripeWebhookEvent;

    try {
        event = JSON.parse(
            new TextDecoder().decode(routeCtx.input),
        ) as StripeWebhookEvent;
    } catch {
        return pluginResponse({
            status: 400,
            headers: {
                "Content-Type": "application/json",
            },
            body: {
                kind: "text",
                value: JSON.stringify({
                    ok: false,
                    error: "Invalid webhook JSON.",
                }),
            },
        });
    }

    ctx.log.info("Verified Stripe webhook received", {
        eventId: event.id,
        eventType: event.type,
    });

    if (event.type === "checkout.session.completed") {
        const checkoutResponse = await handleCheckoutWebhook(event, ctx);

        if (checkoutResponse) {
            return checkoutResponse;
        }
    }

    // Refunds are initiated exclusively through Stripe.
    // Synchronize the current refund history when Stripe reports a change.
    if (
        event.type === "refund.created" ||
        event.type === "refund.updated" ||
        event.type === "refund.failed"
    ) {
        const refundResponse = await handleRefundWebhook(event, ctx);

        if (refundResponse) {
            return refundResponse;
        }
    }

    return pluginResponse({
        status: 200,
        headers: {
            "Content-Type": "application/json",
        },
        body: {
            kind: "text",
            value: JSON.stringify({
                ok: true,
                verified: true,
            }),
        },
    });
}