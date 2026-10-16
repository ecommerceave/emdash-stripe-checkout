import type { PluginContext } from "emdash/plugin";

export type StripeCheckoutSession = {
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
import { createOrder, getOrder, updateOrder } from "../orders/storage.js";
import type { Order } from "../orders/types.js";
import type { StripeProductState } from "../products/sync.js";

type CheckoutInput = {
	productId: string;
	returnPath?: string;
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

}
