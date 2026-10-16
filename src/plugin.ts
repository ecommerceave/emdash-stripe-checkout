import {
    pluginRoute,
    pluginResponse,
    type SandboxedPlugin,
} from "emdash/plugin";

import {
    type BlockInteraction,
} from "@emdash-cms/blocks/server";

import {
    createOrder,
    getOrder,
    updateOrder,
} from "./orders/storage.js";

import type { Order } from "./orders/types.js";

import { checkProductSchema } from "./products/schema.js";

import { verifyStripeWebhookSignature } from "./stripe/webhooks.js";

import { testStripeConnection } from "./stripe/connection.js";

import { handleAdminInteraction } from "./admin/handler.js";

type CheckoutInput = {
	productId: string;
	returnPath?: string;
};

type VerifyCheckoutInput = {
	sessionId: string;
	productId: string;
};

type StripeCheckoutSession = {
	id?: string;
	url?: string;
	payment_status?: string;
	client_reference_id?: string;
	amount_total?: number | null;
	currency?: string | null;
	error?: {
	message?: string;
	};
};

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

type StripeProductState = {
    stripeProductId?: string;
    stripePriceId?: string;
    price?: number;
    currency?: string;
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

	return (
		typeof data.productId === "string" &&
		data.productId.trim().length > 0 &&
		returnPathIsValid
	);
}

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

const plugin: SandboxedPlugin = {
    hooks: {
        "content:afterPublish": async (event, ctx) => {
            if (event.collection !== "products") {
                return;
            }

			const product = event.content.data as Record<string, unknown>;
			const contentId = String(event.content.id);

			const stateKey = `state:product:${contentId}`;
			const stripeState = await ctx.kv.get<StripeProductState>(stateKey);

			const name = typeof product.name === "string" ? product.name.trim() : "";
			const description =
				typeof product.description === "string"
					? product.description.trim()
					: "";
			const sku = typeof product.sku === "string" ? product.sku.trim() : "";
			const price = typeof product.price === "number" ? product.price : NaN;
			const currency =
				typeof product.currency === "string"
					? product.currency.trim().toLowerCase()
					: "usd";
			const active = product.active === true || product.active === 1;

			let imageUrl = "";

			if (
				typeof product.image === "object" &&
				product.image !== null &&
				"id" in product.image &&
				typeof product.image.id === "string"
			) {
				const media = await ctx.media?.get(product.image.id);

				if (media?.url) {
					const siteUrl = new URL(ctx.site.url);
					const isLocal =
						siteUrl.hostname === "localhost" ||
						siteUrl.hostname === "127.0.0.1";

					if (!isLocal) {
						imageUrl = new URL(media.url, siteUrl).toString();
					}
				}

			}

			if (!name || !Number.isFinite(price) || price < 0 || !currency) {
				console.error("[PLUGIN] Product cannot be synced to Stripe", {
					id: contentId,
					name,
					price,
					currency,
				});
				return;
			}

			const unitAmount = Math.round(price * 100);

			const stripeSecretKey =
				await ctx.settings.get<string>("stripeSecretKey");

			if (!stripeSecretKey) {
				console.error("[PLUGIN] Stripe Secret Key has not been configured.");
				return;
			}

			if (!ctx.http) {
				console.error("[PLUGIN] Network access is not available.");
				return;
			}

			if (!stripeState) {
				const stripeProductBody = new URLSearchParams();

				stripeProductBody.set("name", name);
				stripeProductBody.set("active", active ? "true" : "false");
				stripeProductBody.set(
					"metadata[emdash_content_id]",
					contentId,
				);

				if (description) {
					stripeProductBody.set("description", description);
				}

				if (imageUrl) {
					stripeProductBody.set("images[0]", imageUrl);
				}

				if (sku) {
					stripeProductBody.set("metadata[sku]", sku);
				}

				const stripeProductResponse = await ctx.http.fetch(
					"https://api.stripe.com/v1/products",
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${stripeSecretKey}`,
							"Content-Type": "application/x-www-form-urlencoded",
							"Idempotency-Key": `emdash-product-${contentId}`,
						},
						body: stripeProductBody.toString(),
					},
				);

				const stripeProduct = (await stripeProductResponse.json()) as {
					id?: string;
					error?: {
						message?: string;
					};
				};

				if (!stripeProductResponse.ok || !stripeProduct.id) {
					console.error("[PLUGIN] Stripe Product creation failed", {
						status: stripeProductResponse.status,
						message: stripeProduct.error?.message,
					});
					return;
				}

				await ctx.kv.set(stateKey, {
					stripeProductId: stripeProduct.id,
				});

				console.log("[PLUGIN] Stripe Product created", {
					emdashContentId: contentId,
					stripeProductId: stripeProduct.id,
				});
			}

			if (stripeState?.stripeProductId) {
				const stripeProductBody = new URLSearchParams();

				stripeProductBody.set("name", name);
				stripeProductBody.set("active", active ? "true" : "false");
				stripeProductBody.set("description", description);
				stripeProductBody.set("metadata[emdash_content_id]", contentId);
				stripeProductBody.set("metadata[sku]", sku);
				if (imageUrl) {
					stripeProductBody.set("images[0]", imageUrl);
				}

				const stripeProductResponse = await ctx.http.fetch(
					`https://api.stripe.com/v1/products/${stripeState.stripeProductId}`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${stripeSecretKey}`,
							"Content-Type": "application/x-www-form-urlencoded",
						},
						body: stripeProductBody.toString(),
					},
				);

				if (!stripeProductResponse.ok) {
					const stripeProduct = (await stripeProductResponse.json()) as {
						error?: {
							message?: string;
						};
					};

					console.error("[PLUGIN] Stripe Product update failed", {
						status: stripeProductResponse.status,
						message: stripeProduct.error?.message,
					});
					return;
				}

				console.log("[PLUGIN] Stripe Product updated", {
					stripeProductId: stripeState.stripeProductId,
				});
			}

			const currentState =
				(await ctx.kv.get<StripeProductState>(stateKey)) ?? {};

			const priceChanged =
				currentState.price !== price ||
				currentState.currency !== currency;

			if (
				currentState.stripeProductId &&
				(!currentState.stripePriceId || priceChanged)
			) {

				const stripePriceBody = new URLSearchParams();

				stripePriceBody.set("product", currentState.stripeProductId);
				stripePriceBody.set("currency", currency);
				stripePriceBody.set("unit_amount", String(unitAmount));

				const stripePriceResponse = await ctx.http.fetch(
					"https://api.stripe.com/v1/prices",
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${stripeSecretKey}`,
							"Content-Type": "application/x-www-form-urlencoded",
							"Idempotency-Key":
							`emdash-price-${contentId}-${currency}-${unitAmount}`,
						},
						body: stripePriceBody.toString(),
					},
				);

				const stripePrice = (await stripePriceResponse.json()) as {
					id?: string;
					error?: {
						message?: string;
					};
				};

				if (!stripePriceResponse.ok || !stripePrice.id) {
					console.error("[PLUGIN] Stripe Price creation failed", {
						status: stripePriceResponse.status,
						message: stripePrice.error?.message,
					});
					return;
				}

				await ctx.kv.set(stateKey, {
					...currentState,
					stripePriceId: stripePrice.id,
					price,
					currency,
				});

				if (currentState.stripePriceId && priceChanged) {
					const oldPriceBody = new URLSearchParams();
					oldPriceBody.set("active", "false");

					const oldPriceResponse = await ctx.http.fetch(
						`https://api.stripe.com/v1/prices/${currentState.stripePriceId}`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${stripeSecretKey}`,
								"Content-Type": "application/x-www-form-urlencoded",
							},
							body: oldPriceBody.toString(),
						},
					);

					if (!oldPriceResponse.ok) {
						console.error("[PLUGIN] Old Stripe Price could not be deactivated", {
							stripePriceId: currentState.stripePriceId,
							status: oldPriceResponse.status,
						});
					} else {
						console.log("[PLUGIN] Old Stripe Price deactivated", {
							stripePriceId: currentState.stripePriceId,
						});
					}
				}

				console.log("[PLUGIN] Stripe Price created", {
					stripeProductId: currentState.stripeProductId,
					stripePriceId: stripePrice.id,
					price,
					currency,
					unitAmount,
				});
			}

        },
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
			handler: async (routeCtx, ctx) => {
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

				const { productId, returnPath = "/" } = routeCtx.input;

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

				const product = await ctx.content?.get("products", productId);

				if (!product || (product.data?.active !== true && product.data?.active !== 1)) {
					return {
						ok: false,
						error: "This product is currently unavailable for purchase.",
					};
				}

				const priceId = stripeState.stripePriceId;

				const body = new URLSearchParams();

				body.set("mode", "payment");
				body.set("client_reference_id", productId);
				body.set("line_items[0][price]", priceId);
				body.set("line_items[0][quantity]", "1");
				body.set("success_url", successUrl);
				body.set("cancel_url", cancelUrl);

				if (!ctx.http) {
					return {
						ok: false,
						error: "Network access is not available.",
					};
				}

				const response = await ctx.http.fetch(
					"https://api.stripe.com/v1/checkout/sessions",
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${stripeSecretKey}`,
							"Content-Type": "application/x-www-form-urlencoded",
						},
						body: body.toString(),
					},
				);

				const stripeResponse =
					(await response.json()) as StripeCheckoutSession;

				if (!response.ok) {
					ctx.log.error("Stripe Checkout session creation failed", {
						status: response.status,
						message: stripeResponse.error?.message,
					});

					return {
						ok: false,
						error:
							stripeResponse.error?.message ??
							"Stripe Checkout session could not be created.",
					};
				}

				if (!stripeResponse.url) {
					return {
						ok: false,
						error: "Stripe did not return a Checkout URL.",
					};
				}

				if (!stripeResponse.id) {
					return {
						ok: false,
						error: "Stripe did not return a Checkout Session ID.",
					};
				}

				const now = new Date().toISOString();

				const order: Order = {
				id: stripeResponse.id,
				stripeSessionId: stripeResponse.id,
				productId,
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
						message: error instanceof Error ? error.message : String(error),
					});

					return {
						ok: false,
						error: "Checkout was created, but the order could not be saved. Please try again.",
					};
				}

				if (!orderCreated) {
					return {
						ok: false,
						error: "An order already exists for this Checkout Session.",
					};
				}

				ctx.log.info("Stripe Checkout session created", {
					sessionId: stripeResponse.id,
					priceId,
				});

				return {
					ok: true,
					sessionId: stripeResponse.id,
					checkoutUrl: stripeResponse.url,
				};
			},
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
			handler: async (routeCtx, ctx) => {
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

				if (stripeResponse.client_reference_id !== productId) {
					ctx.log.warn("Stripe Checkout session product mismatch", {
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
						ctx.log.error("Paid Stripe Checkout Session has no matching order", {
							sessionId,
						});

						return {
							ok: false,
							error: "Payment was confirmed, but the order was not found.",
						};
					}

					if (order.productId !== productId) {
						return {
							ok: false,
							error: "Order does not match this product.",
						};
					}

					if (order.paymentStatus === "pending") {
						const updated = await updateOrder(ctx, sessionId, {
							paymentStatus: "paid",
							paidAt: new Date().toISOString(),
						});

						if (!updated) {
							return {
								ok: false,
								error: "Payment was confirmed, but the order could not be updated.",
							};
						}
					}
				}

				return {
					ok: true,
					sessionId: stripeResponse.id,
					paid: stripeResponse.payment_status === "paid",
					paymentStatus: stripeResponse.payment_status,
				};
			},
		}),
},

};

export default plugin;