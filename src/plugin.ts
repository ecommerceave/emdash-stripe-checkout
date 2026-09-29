import { pluginRoute, type SandboxedPlugin } from "emdash/plugin";

type CheckoutInput = {
	priceId: string;
	successUrl: string;
	cancelUrl: string;
};

type StripeCheckoutSession = {
	id?: string;
	url?: string;
	error?: {
		message?: string;
	};
};

function isHttpUrl(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}

	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

function isCheckoutInput(input: unknown): input is CheckoutInput {
	if (typeof input !== "object" || input === null) {
		return false;
	}

	const data = input as Record<string, unknown>;

	return (
		typeof data.priceId === "string" &&
		data.priceId.startsWith("price_") &&
		isHttpUrl(data.successUrl) &&
		isHttpUrl(data.cancelUrl)
	);
}

const plugin: SandboxedPlugin = {
	routes: {
		createCheckoutSession: pluginRoute({
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

				const { priceId, successUrl, cancelUrl } = routeCtx.input;

				const body = new URLSearchParams();

				body.set("mode", "payment");
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
	},
};

export default plugin;