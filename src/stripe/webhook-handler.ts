import { pluginResponse, type PluginContext } from "emdash/plugin";

import {
    getOrder,
    updateOrder,
    savePaymentIntentOrderLookup,
    getOrderByPaymentIntent,
} from "../orders/storage.js";

import { syncOrderRefunds } from "../orders/refund-sync.js";

import { verifyStripeWebhookSignature } from "./webhooks.js";
import { recoverCheckoutOrder } from "./recover-checkout-order.js";

import type { Order } from "../orders/types.js";

type StripeWebhookEvent = {
    id: string;
    type: string;
    data: {
        object: {
            id?: string;
            payment_status?: string;
            payment_intent?: string | null;
            client_reference_id?: string;
            customer_details?: {
                email?: string | null;
            } | null;
        };
    };
};

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
        const session = event.data?.object;

        if (
            session?.id?.startsWith("cs_") &&
            session.payment_status === "paid"
        ) {
            ctx.log.info("Stripe Checkout payment confirmed", {
                eventId: event.id,
                sessionId: session.id,
            });

            let order = await getOrder(ctx, session.id);

            if (!order) {
                order = await recoverCheckoutOrder(
                    ctx,
                    session.id,
                    session.client_reference_id,
                    session.payment_intent,
                );
            }

            if (!order) {
                ctx.log.error(
                    "Stripe webhook: matching order not found",
                    {
                        eventId: event.id,
                        sessionId: session.id,
                    },
                );

                return pluginResponse({
                    status: 500,
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: {
                        kind: "text",
                        value: JSON.stringify({
                            ok: false,
                            error: "Matching order not found.",
                        }),
                    },
                });
            }

            ctx.log.info("Stripe webhook: matching order found", {
                orderId: order.id,
                paymentStatus: order.paymentStatus,
            });

            // Always validate the Checkout Session against
            // the stored order before updating anything.
            if (
                session.client_reference_id !== order.productId ||
                session.id !== order.stripeSessionId
            ) {
                ctx.log.error("Stripe webhook: order mismatch", {
                    eventId: event.id,
                    sessionId: session.id,
                    orderId: order.id,
                });

                return pluginResponse({
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: {
                        kind: "text",
                        value: JSON.stringify({
                            ok: false,
                            error: "Checkout Session does not match order.",
                        }),
                    },
                });
            }

            const customerEmail =
                session.customer_details?.email?.trim() || null;

            // Capture missing customer information even when
            // another handler has already marked the order paid.
            const shouldUpdateEmail =
                !order.customerEmail && Boolean(customerEmail);
            const shouldMarkPaid = order.paymentStatus === "pending";

            const shouldSavePaymentIntent =
                !order.stripePaymentIntentId &&
                typeof session.payment_intent === "string" &&
                session.payment_intent.startsWith("pi_");

            if (shouldMarkPaid || shouldUpdateEmail || shouldSavePaymentIntent) {
                const updates: Partial<Order> = {};

                if (shouldSavePaymentIntent) {
                    updates.stripePaymentIntentId = session.payment_intent;
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
                    session.id,
                    updates,
                );

                if (!updated) {
                    ctx.log.error(
                        "Stripe webhook: order update failed",
                        {
                            eventId: event.id,
                            orderId: order.id,
                        },
                    );

                    return pluginResponse({
                        status: 500,
                        headers: {
                            "Content-Type": "application/json",
                        },
                        body: {
                            kind: "text",
                            value: JSON.stringify({
                                ok: false,
                                error: "Order update failed.",
                            }),
                        },
                    });
                }
                
                ctx.log.info("Stripe webhook: order updated", {
                    orderId: order.id,
                    paymentStatusUpdated: shouldMarkPaid,
                    customerEmailUpdated: shouldUpdateEmail,
                });
            } else {
                ctx.log.info(
                    "Stripe webhook: order already up to date",
                    {
                        orderId: order.id,
                        paymentStatus: order.paymentStatus,
                    },
                );
            }
            // Ensure the PaymentIntent lookup exists even when
            // the order was previously marked as paid.
            const paymentIntentId =
                typeof session.payment_intent === "string" &&
                session.payment_intent.startsWith("pi_")
                    ? session.payment_intent
                    : order.stripePaymentIntentId;

            if (paymentIntentId?.startsWith("pi_")) {
                await savePaymentIntentOrderLookup(
                    ctx,
                    paymentIntentId,
                    order.id,
                );
            }
        }
    }

    // Refunds are initiated exclusively through Stripe.
    // Synchronize the current refund history when Stripe reports a change.
    if (
        event.type === "refund.created" ||
        event.type === "refund.updated" ||
        event.type === "refund.failed"
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