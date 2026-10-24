
import { pluginResponse, type PluginContext } from "emdash/plugin";

import { getOrderByPaymentIntent } from "../orders/storage.js";
import { syncOrderRefunds } from "../orders/refund-sync.js";

export type RefundWebhookEvent = {
    id: string;
    type: string;
    data: {
        object: {
            payment_intent?: string | null;
        };
    };
};

export async function handleRefundWebhook(
    event: RefundWebhookEvent,
    ctx: PluginContext,
) {
    const refund = event.data?.object;
    const paymentIntentId = refund?.payment_intent;

    if (
        typeof paymentIntentId !== "string" ||
        !paymentIntentId.startsWith("pi_")
    ) {
        ctx.log.error("Stripe refund webhook: missing PaymentIntent", {
            eventId: event.id,
        });

        return pluginResponse({
            status: 500,
            headers: { "Content-Type": "application/json" },
            body: {
                kind: "text",
                value: JSON.stringify({
                    ok: false,
                    error: "Refund PaymentIntent not available.",
                }),
            },
        });
    }

    let order;

    try {
        order = await getOrderByPaymentIntent(ctx, paymentIntentId);

        ctx.log.info("Stripe refund webhook: lookup result", {
            eventId: event.id,
            paymentIntentId,
            orderFound: Boolean(order),
            orderId: order?.id ?? null,
        });
    } catch (error) {
        ctx.log.error("Stripe refund webhook: order lookup failed", {
            eventId: event.id,
            paymentIntentId,
            error: String(error),
        });

        return pluginResponse({
            status: 500,
            headers: { "Content-Type": "application/json" },
            body: {
                kind: "text",
                value: JSON.stringify({
                    ok: false,
                    error: "Refund order lookup failed.",
                }),
            },
        });
    }

    if (!order) {
        ctx.log.error("Stripe refund webhook: order not found", {
            eventId: event.id,
            paymentIntentId,
        });

        return pluginResponse({
            status: 500,
            headers: { "Content-Type": "application/json" },
            body: {
                kind: "text",
                value: JSON.stringify({
                    ok: false,
                    error: "Matching refund order not found.",
                }),
            },
        });
    }

    try {
        const synchronized = await syncOrderRefunds(ctx, order.id);

        if (!synchronized) {
            throw new Error("Refund synchronization was not completed.");
        }

        ctx.log.info("Stripe refund webhook: order synchronized", {
            eventId: event.id,
            orderId: order.id,
        });
    } catch (error) {
        ctx.log.error("Stripe refund webhook: synchronization failed", {
            eventId: event.id,
            orderId: order.id,
            error: String(error),
        });

        return pluginResponse({
            status: 500,
            headers: { "Content-Type": "application/json" },
            body: {
                kind: "text",
                value: JSON.stringify({
                    ok: false,
                    error: "Refund synchronization failed.",
                }),
            },
        });
    }

    return null;
}
