import {
    pluginRoute,
    pluginResponse,
    type SandboxedPlugin,
} from "emdash/plugin";

import {
    type BlockInteraction,
} from "@emdash-cms/blocks/server";

import {
    getOrder,
    updateOrder,
} from "./orders/storage.js";


import { checkProductSchema } from "./products/schema.js";
import { syncProductAfterPublish } from "./products/sync.js";

import { verifyStripeWebhookSignature } from "./stripe/webhooks.js";

import { testStripeConnection } from "./stripe/connection.js";

import { handleAdminInteraction } from "./admin/handler.js";
import { createCheckoutSession, verifyCheckoutSession } from "./checkout/handler.js";





type StripeWebhookEvent = {
    id: string;
    type: string;
    data: {
        object: {
            id?: string;
            payment_status?: string;
            client_reference_id?: string;
            customer_details?: {
                email?: string | null;
            } | null;
        };
    };
};





const plugin: SandboxedPlugin = {
    hooks: {
        "content:afterPublish": syncProductAfterPublish
    },

    routes: {
		admin: pluginRoute({
		methods: ["POST"],
		request: {
			body: "json",
		},
                handler: async (routeCtx, ctx) => {
                    return handleAdminInteraction(
                        routeCtx.input as BlockInteraction,
                        ctx,
                    );
                },
		}),

		checkProductSchema: pluginRoute({
			methods: ["GET"],
			request: {
				body: "none",
			},
			handler: async (_routeCtx, ctx) => {
				return await checkProductSchema(ctx);
			},
		}),

		testStripeConnection: pluginRoute({
			methods: ["POST"],
			request: {
				body: "none",
			},
			handler: async (_routeCtx, ctx) => {
				return await testStripeConnection(ctx);
			},
		}),

		createCheckoutSession: pluginRoute({
			public: true,
			methods: ["POST"],
			request: {
				body: "json",
			},
			handler: createCheckoutSession,
		}),
		stripeWebhook: pluginRoute({
			public: true,
			methods: ["POST"],
			response: "raw",
			request: {
				body: "bytes",
				headers: ["stripe-signature"],
				maxBytes: 65536,
			},
			handler: async (routeCtx, ctx) => {
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
					webhookSecret
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
						new TextDecoder().decode(routeCtx.input)
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

						const order = await getOrder(ctx, session.id);

						if (!order) {
							ctx.log.error("Stripe webhook: matching order not found", {
								eventId: event.id,
								sessionId: session.id,
							});

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
						} else {
							ctx.log.info("Stripe webhook: matching order found", {
								orderId: order.id,
								paymentStatus: order.paymentStatus,
							});
							if (order.paymentStatus === "pending") {
								if (
									session.client_reference_id !== order.productId ||
									session.id !== order.stripeSessionId
								) {
									ctx.log.error("Stripe webhook: order mismatch", {
										eventId: event.id,
										sessionId: session.id,
									});
									throw new Error("Stripe webhook order mismatch.");
								}

								const updated = await updateOrder(ctx, session.id, {
									paymentStatus: "paid",
									paidAt: new Date().toISOString(),
									customerEmail: session.customer_details?.email ?? null,
								});

								if (!updated) {
									throw new Error("Stripe webhook order update failed.");
								}

								ctx.log.info("Stripe webhook: order marked as paid", {
									orderId: order.id,
								});
							}
						}
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
			},
		}),
		verifyCheckoutSession: pluginRoute({
			public: true,
			methods: ["POST"],
			request: {
				body: "json",
			},
			handler: verifyCheckoutSession,
		}),
},

};

export default plugin;