import {
	pluginRoute,
	type PluginContext,
	type SandboxedPlugin,
} from "emdash/plugin";

import {
	blocks,
	elements,
	type BlockInteraction,
	type BlockResponse,
} from "@emdash-cms/blocks/server";

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
	error?: {
		message?: string;
	};
};

type StripeConnectionResult = {
	ok: boolean;
	mode?: "test" | "live";
	accountId?: string;
	error?: string;
};

type StripeConnectionState = {
	mode: "test" | "live";
	accountId: string;
	verifiedAt: string;
};

const STRIPE_CONNECTION_STATE_KEY = "state:stripe-connection";

type StripeProductState = {
    stripeProductId?: string;
    stripePriceId?: string;
    price?: number;
    currency?: string;
};

const REQUIRED_PRODUCT_FIELDS = [
	{ slug: "name", type: "string", required: true },
	{ slug: "description", type: "text", required: false },
	{ slug: "image", type: "image", required: false },
	{ slug: "price", type: "number", required: true },
	{ slug: "currency", type: "select", required: true },
	{ slug: "sku", type: "string", required: false },
	{ slug: "active", type: "boolean", required: false },
] as const;

type ProductSchemaCheck = {
	ok: boolean;
	collectionExists: boolean;
	fields: Array<{
		slug: string;
		expectedType: string;
		actualType?: string;
		exists: boolean;
		valid: boolean;
	}>;
};

async function checkProductSchema(
	ctx: PluginContext,
): Promise<ProductSchemaCheck> {
	const collection = await ctx.schema?.getCollection("products");

	if (!collection) {
		return {
			ok: false,
			collectionExists: false,
			fields: REQUIRED_PRODUCT_FIELDS.map((field) => ({
				slug: field.slug,
				expectedType: field.type,
				exists: false,
				valid: false,
			})),
		};
	}

	const fields = REQUIRED_PRODUCT_FIELDS.map((requiredField) => {
		const actualField = collection.fields.find(
			(field) => field.slug === requiredField.slug,
		);

		return {
			slug: requiredField.slug,
			expectedType: requiredField.type,
			actualType: actualField?.type,
			exists: Boolean(actualField),
			valid:
				Boolean(actualField) &&
				actualField?.type === requiredField.type &&
				(!requiredField.required || actualField.required),
		};
	});

	return {
		ok: fields.every((field) => field.valid),
		collectionExists: true,
		fields,
	};
}

async function buildAdminPage(
  ctx: PluginContext,
  stripeConnection?: StripeConnectionResult,
): Promise<BlockResponse> {
  const schema = await checkProductSchema(ctx);
  const stripeSecretKey =
    await ctx.settings.get<string>("stripeSecretKey");
	const savedConnection =
		await ctx.kv.get<StripeConnectionState>(
			STRIPE_CONNECTION_STATE_KEY,
		);
	const connection =
		stripeConnection ??
		(savedConnection
			? {
				ok: true,
				mode: savedConnection.mode,
				accountId: savedConnection.accountId,
				verifiedAt: savedConnection.verifiedAt,
			}
			: undefined);

	return {
		blocks: [
			blocks.header("Stripe Checkout"),
			blocks.section(
				"Lightweight Stripe Checkout integration for EmDash.",
			),
			blocks.fields([
				{
				label: "Stripe Connection",
				value: !stripeSecretKey
					? "Needs setup"
					: !connection
					? "Not tested"
					: connection.ok
						? "Connected"
						: "Connection failed",
				},
				{
				label: "Connection Details",
				value: !stripeSecretKey
					? "Add your Stripe Secret Key in plugin settings."
					: !connection
					? "Click Test Stripe Connection to verify your credentials."
					: connection.ok
						? "Stripe credentials verified successfully."
						: connection.error ?? "Unable to connect to Stripe.",
				},
				{
				label: "Stripe Mode",
				value: !stripeSecretKey
					? "Not configured"
					: !connection
					? "Pending connection test"
					: connection.ok
						? connection.mode === "test"
						? "Test"
						: "Live"
						: "Unavailable",
				},
				{
				label: "Stripe Account",
				value: !stripeSecretKey
					? "Not configured"
					: !connection
					? "Pending connection test"
					: connection.ok && connection.accountId
						? connection.accountId
						: "Unavailable",
				},
				{
				label: "Last Verified",
				value:
					connection?.ok && savedConnection?.verifiedAt
					? `${new Date(savedConnection.verifiedAt).toLocaleString(
						ctx.site.locale,
						{
							timeZone: "UTC",
						},
						)} UTC`
					: "Never",
				},
				{
				label: "Products Collection",
				value: schema.collectionExists ? "Found" : "Missing",
				},
				{
				label: "Product Schema",
				value: schema.ok ? "Valid" : "Needs attention",
				},
			]),
			blocks.actions([
				elements.button(
					"test-stripe-connection",
					"Test Stripe Connection",
					{
					style: "primary",
					},
				),
			]),
		],
	};
}

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

async function testStripeConnection(
	ctx: PluginContext,
): Promise<StripeConnectionResult> {
	const stripeSecretKey =
		await ctx.settings.get<string>("stripeSecretKey");

	if (!stripeSecretKey) {
		await ctx.kv.delete(STRIPE_CONNECTION_STATE_KEY);

		return {
			ok: false,
			error: "Stripe Secret Key is not configured.",
		};
	}

	if (!ctx.http) {
		return {
			ok: false,
			error: "Network access is not available.",
		};
	}

	const response = await ctx.http.fetch(
		"https://api.stripe.com/v1/account",
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${stripeSecretKey}`,
			},
		},
	);

	const data = (await response.json()) as {
		id?: string;
		error?: {
		message?: string;
		};
	};

	if (!response.ok) {
		await ctx.kv.delete(STRIPE_CONNECTION_STATE_KEY);

		return {
			ok: false,
			error:
			data.error?.message ??
			"Unable to connect to Stripe.",
		};
	}

	const mode = stripeSecretKey.startsWith("sk_test_")
		? "test"
		: "live";

		if (data.id) {
			await ctx.kv.set(STRIPE_CONNECTION_STATE_KEY, {
				mode,
				accountId: data.id,
				verifiedAt: new Date().toISOString(),
			});
		}

		return {
			ok: true,
			mode,
			accountId: data.id,
	};
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
				const interaction =
					routeCtx.input as BlockInteraction;

				if (
					interaction.type === "block_action" &&
					interaction.action_id === "test-stripe-connection"
				) {
					const stripeConnection =
						await testStripeConnection(ctx);

						const response = await buildAdminPage(
						ctx,
						stripeConnection,
						);

						response.toast = {
						message: stripeConnection.ok
							? "Stripe connection verified successfully."
							: stripeConnection.error ??
							"Unable to connect to Stripe.",
						type: stripeConnection.ok ? "success" : "error",
						};

						return response;
				}

				return await buildAdminPage(ctx);
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