import {
	pluginRoute,
	pluginResponse,
	type PluginContext,
	type SandboxedPlugin,
} from "emdash/plugin";

import {
	blocks,
	elements,
	type BlockInteraction,
	type BlockResponse,
} from "@emdash-cms/blocks/server";

import {
	createOrder,
	getOrder,
	updateOrder,
	listOrders,
	recordPendingRefund,
	recordSuccessfulRefund,
	claimOrderForRefund,
} from "./orders/storage.js";

import type { Order } from "./orders/types.js";
import { verifyStripeWebhookSignature } from "./stripe/webhooks.js";

import {
	getStripePaymentIntent,
	createStripeRefund,
	getStripeRefund,
	listStripeRefunds,
} from "./refunds/stripe.js";

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
		required: boolean;
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
				required: field.required,
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
			required: requiredField.required,
			actualType: actualField?.type,
			exists: Boolean(actualField),
			valid:
				Boolean(actualField) &&
				actualField?.type === requiredField.type &&
				(!requiredField.required || actualField.required) &&
				(requiredField.slug !== "currency" ||
					["USD", "CAD", "EUR", "GBP"].every((currency) =>
						actualField?.validation?.options?.includes(currency),
					)),
		};
	});

	return {
		ok: fields.every((field) => field.valid),
		collectionExists: true,
		fields,
	};
}

function getProductSchemaGuidance(
	schema: ProductSchemaCheck,
): string {
	if (!schema.collectionExists) {
		return [
			"Stripe Checkout requires a Products collection.",
			"",
			"SETUP INSTRUCTIONS",
			"",
			"1. Open Collections in your EmDash admin.",
			"2. Create a new collection with:",
			"   Name: Products",
			"   Slug: products",
			"",
			"3. Add the following fields:",
			"",
			"Name — name — String — Required",
			"Description — description — Text — Optional",
			"Image — image — Image — Optional",
			"Price — price — Number — Required",
			"Currency — currency — Select — Required",
			"SKU — sku — String — Optional",
			"Active — active — Boolean — Optional",
			"",
			"4. Configure the Currency field:",
			"   Options: USD, CAD, EUR, GBP",
			"   Default: USD",
			"",
			"5. Save your collection and return to Stripe Checkout.",
			"",
			"The plugin will automatically detect the collection.",
		].join("\n");
	}

	const invalidFields = schema.fields.filter(
		(field) => !field.valid,
	);

	if (invalidFields.length === 0) {
		return "The Products collection is configured correctly.";
	}

	return [
		"The Products collection exists, but some fields need attention:",
		"",
		...invalidFields.map((field) => {
			const requirement = field.required
				? ", required"
				: "";

			if (!field.exists) {
				return `${field.slug}: add ${field.expectedType}${requirement}`;
			}

			return `${field.slug}: expected ${field.expectedType}${requirement}, found ${field.actualType ?? "unknown"}`;
		}),
	].join("\n");
}

async function buildOrderDetailsPage(
  ctx: PluginContext,
  orderId: string,
): Promise<BlockResponse> {
  const order = await getOrder(ctx, orderId);

  if (!order) {
    return {
      blocks: [
        blocks.header("Order Not Found"),
        blocks.section("The requested order could not be found."),
        blocks.actions([
          elements.button("stripe-orders-back", "Back to Orders"),
        ]),
      ],
    };
  }

  return {
    blocks: [
		blocks.header(`Order #${order.id.slice(-8).toUpperCase()}`),
		blocks.fields([
			{ label: "Order ID", value: order.id },
			{ label: "Stripe Session ID", value: order.stripeSessionId },
			{ label: "Customer Email", value: order.customerEmail ?? "Not provided" },
			{ label: "Product ID", value: order.productId },
			{ label: "Quantity", value: String(order.quantity) },
			{
			label: "Amount",
			value:
				order.amountTotal != null && order.currency
				? `${(order.amountTotal / 100).toFixed(2)} ${order.currency.toUpperCase()}`
				: "Unavailable",
			},
			{ label: "Payment Status", value: order.paymentStatus },
			{ label: "Created", value: order.createdAt },
			{ label: "Updated", value: order.updatedAt },
			{ label: "Paid At", value: order.paidAt ?? "Not paid" },
			{
				label: "Stripe Refund ID",
				value: order.stripeRefundId ?? "Not refunded",
			},
			{
				label: "Refund Status",
				value: order.refundStatus ?? "Not refunded",
			},
			{
				label: "Refunded At",
				value: order.refundedAt ?? "Not refunded",
			},
		]),
		blocks.actions([
			elements.button("stripe-orders-back", "Back to Orders"),

			...(order.paymentStatus === "paid"
				? [
					elements.button(
					"stripe-order-refund",
					"Refund Order",
					{ value: order.id },
					),
				]
				: []),

			...(order.paymentStatus === "refund_pending" && order.stripeRefundId
				? [
					elements.button(
					"stripe-refund-check-status",
					"Check Refund Status",
					{ value: order.id },
					),
				]
				: []),

			...(order.paymentStatus === "refund_processing"
				? [
					elements.button(
					"stripe-refund-reconcile",
					"Check Stripe Refunds",
					{ value: order.id },
					),
				]
				: []),
			]),
    	],
  	};
}

async function buildRefundConfirmationPage(
  ctx: PluginContext,
  orderId: string,
): Promise<BlockResponse> {
  const order = await getOrder(ctx, orderId);

  if (!order || order.paymentStatus !== "paid") {
    return {
      blocks: [
        blocks.header("Refund Unavailable"),
        blocks.section(
          "This order cannot be refunded because it was not found or is not currently paid.",
        ),
        blocks.actions([
          elements.button("stripe-orders-back", "Back to Orders"),
        ]),
      ],
    };
  }

  return {
    blocks: [
      blocks.header("Confirm Refund"),
      blocks.section(
        "You are about to issue a full refund for this order. Please review the details before continuing.",
      ),
      blocks.fields([
        { label: "Order ID", value: order.id },
        {
          label: "Customer Email",
          value: order.customerEmail ?? "Not provided",
        },
        {
          label: "Refund Amount",
          value:
            order.amountTotal != null && order.currency
              ? `${(order.amountTotal / 100).toFixed(2)} ${order.currency.toUpperCase()}`
              : "Unavailable",
        },
        { label: "Payment Status", value: order.paymentStatus },
      ]),
      blocks.actions([
		elements.button("stripe-order-details", "Cancel", {
			value: order.id,
		}),
		elements.button("stripe-refund-confirm", "Confirm Full Refund", {
			value: order.id,
		}),
	]),
    ],
  };
}

async function buildAdminPage(
  ctx: PluginContext,
  stripeConnection?: StripeConnectionResult,
  ordersCursor?: string,
): Promise<BlockResponse> {
  const schema = await checkProductSchema(ctx);
  const { orders, cursor: nextCursor, hasMore } =
    await listOrders(ctx, ordersCursor);
  
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
			blocks.section(
				schema.ok
					? "Products are ready to use."
					: getProductSchemaGuidance(schema),
			),
			blocks.actions([
				elements.button(
					"test-stripe-connection",
					"Test Stripe Connection",
					{
						style: "primary",
					},
				),
			]),
			blocks.header("Orders"),
			blocks.section(
				orders.length === 0
					? "No orders have been placed yet."
					: `Showing ${orders.length} recent orders.`,
				),
				blocks.table({
				blockId: "stripe-orders-table",
				columns: [
					{ key: "order", label: "Order", format: "code" },
					{ key: "customer", label: "Customer", format: "text" },
					{ key: "quantity", label: "Qty", format: "number" },
					{ key: "amount", label: "Amount", format: "text" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "date", label: "Date", format: "text" },
					{ key: "actions", label: "Actions", format: "element" },
				],
				rows: orders.map((order) => ({
					order: `#${order.id.slice(-8).toUpperCase()}`,
					customer: order.customerEmail ?? "Not provided",
					quantity: order.quantity,
					amount:
					order.amountTotal != null && order.currency
						? `${(order.amountTotal / 100).toFixed(2)} ${order.currency.toUpperCase()}`
						: "Unavailable",
					status: order.paymentStatus,
					date:
					new Date(order.createdAt).toLocaleString("en-US", {
						dateStyle: "medium",
						timeStyle: "short",
						timeZone: "UTC",
					}) + " UTC",
					actions: elements.button(
						"stripe-order-details",
						"View Details",
						{
							style: "secondary",
							value: order.id,
						},
					),
				})),
				nextCursor: hasMore ? nextCursor : undefined,
				pageActionId: "stripe-orders-next-page",
				emptyText: "No orders have been placed yet.",
			}),
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
			const interaction = routeCtx.input as BlockInteraction;

			// Test Stripe connection
			if (
			interaction.type === "block_action" &&
			interaction.action_id === "test-stripe-connection"
			) {
			const stripeConnection = await testStripeConnection(ctx);

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

			// Reconcile an existing Stripe refund without creating another refund.
			// Only matching full refunds with succeeded or pending status update the order.
			// Ambiguous or mismatched refunds require manual reconciliation.
			if (
				interaction.type === "block_action" &&
				interaction.action_id === "stripe-refund-reconcile"
			) {
			const orderId = interaction.value;

			if (typeof orderId !== "string" || !orderId.trim()) {
				return {
					blocks: [
						blocks.header("Invalid Order"),
						blocks.section("No valid order ID was provided."),
					],
				};
			}

			const order = await getOrder(ctx, orderId);

			if (!order || order.paymentStatus !== "refund_processing") {
				return {
					blocks: [
						blocks.header("Reconciliation Unavailable"),
						blocks.section(
						"This order is not currently awaiting refund reconciliation.",
						),
						blocks.actions([
						elements.button("stripe-orders-back", "Back to Orders"),
						]),
					],
				};
			}

			try {
				const paymentIntentId = await getStripePaymentIntent(
				ctx,
				order.stripeSessionId,
				);

				const refunds = await listStripeRefunds(ctx, paymentIntentId);

				if (refunds.has_more) {
					return {
						blocks: [
							blocks.header("Manual Reconciliation Required"),
							blocks.section(
								"Stripe returned additional pages of refunds. Review the complete refund history in Stripe before updating this order.",
							),
							blocks.actions([
								elements.button("stripe-order-details", "Back to Order", {
								value: order.id,
								}),
							]),
						],
					};
				}

				if (!refunds.data || refunds.data.length === 0) {
					return {
						blocks: [
						blocks.header("No Stripe Refund Found"),
						blocks.section(
							"Stripe currently reports no refunds for this payment. The order remains locked because an earlier refund request may have had an uncertain outcome. Verify the payment in Stripe before taking further action.",
						),
						blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
							value: order.id,
							}),
						]),
						],
					};
				}

				if (refunds.data.length > 1) {
					return {
						blocks: [
						blocks.header("Manual Reconciliation Required"),
						blocks.section(
							"Stripe returned multiple refunds for this payment. Review all refunds in Stripe before updating this order. The order remains locked.",
						),
						blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
							value: order.id,
							}),
						]),
						],
					};
				}
				
				const refund = refunds.data[0];

				if (
					order.amountTotal === null ||
					!Number.isSafeInteger(order.amountTotal) ||
					order.amountTotal <= 0 ||
					typeof order.currency !== "string" ||
					refund.amount !== order.amountTotal ||
					refund.currency !== order.currency.toLowerCase()
					) {
					return {
						blocks: [
						blocks.header("Manual Reconciliation Required"),
						blocks.section(
							"The Stripe refund amount or currency does not match the original order. This may indicate a partial refund or inconsistent payment information. Review the transaction in Stripe before making any changes. The order remains locked.",
						),
						blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
							value: order.id,
							}),
						]),
						],
					};
				}
				
				if (refund.status === "succeeded") {
					const recorded = await recordSuccessfulRefund(
						ctx,
						order.id,
						refund.id!,
					);

					if (!recorded) {
						return {
						blocks: [
							blocks.header("Manual Reconciliation Required"),
							blocks.section(
							"Stripe confirmed a successful refund, but the order could not be updated safely. The order remains locked. Review the transaction in Stripe.",
							),
							blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
								value: order.id,
							}),
							]),
						],
						};
					}
				}
				
				if (refund.status === "pending") {
					const recorded = await recordPendingRefund(
						ctx,
						order.id,
						refund.id!,
					);

					if (!recorded) {
						return {
						blocks: [
							blocks.header("Manual Reconciliation Required"),
							blocks.section(
							"Stripe confirmed a pending refund, but the order could not be updated safely. The order remains locked. Review the transaction in Stripe.",
							),
							blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
								value: order.id,
							}),
							]),
						],
						};
					}
				}

				if (
					refund.status !== "succeeded" &&
					refund.status !== "pending"
					) {
					return {
						blocks: [
						blocks.header("Manual Reconciliation Required"),
						blocks.section(
							`Stripe reports refund ${refund.id} with status "${refund.status}". This refund cannot be automatically reconciled. Review it in Stripe before taking further action. The order remains locked.`,
						),
						blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
							value: order.id,
							}),
						]),
						],
					};
				}
				
				return {
					blocks: [
						blocks.header("Stripe Refunds Found"),
						blocks.section(
						"Existing refunds were found for this payment. Review their status in Stripe before making any changes.",
						),
						blocks.fields(
						refunds.data.map((refund) => ({
							label: refund.id ?? "Unknown Refund",
							value: refund.status ?? "Unknown status",
						})),
						),
						blocks.actions([
						elements.button("stripe-order-details", "Back to Order", {
							value: order.id,
						}),
						]),
					],
				};
			} catch (error) {
				return {
				blocks: [
					blocks.header("Reconciliation Check Failed"),
					blocks.section(
					error instanceof Error
						? error.message
						: "Unable to retrieve refund information from Stripe.",
					),
					blocks.section(
					"The order remains locked. Check Stripe manually before taking further action.",
					),
					blocks.actions([
					elements.button("stripe-order-details", "Back to Order", {
						value: order.id,
					}),
					]),
				],
				};
			}
			}
			
			// Check the status of an existing Stripe refund (read-only)
			if (
			interaction.type === "block_action" &&
			interaction.action_id === "stripe-refund-check-status"
			) {
			const orderId = interaction.value;

			if (typeof orderId !== "string" || !orderId.trim()) {
				return {
				blocks: [
					blocks.header("Invalid Order"),
					blocks.section("No valid order ID was provided."),
				],
				};
			}

			const order = await getOrder(ctx, orderId);

			if (
				!order ||
				order.paymentStatus !== "refund_pending" ||
				!order.stripeRefundId
			) {
				return {
				blocks: [
					blocks.header("Refund Status Unavailable"),
					blocks.section(
					"This order does not have a pending refund to check.",
					),
					blocks.actions([
					elements.button("stripe-orders-back", "Back to Orders"),
					]),
				],
				};
			}

			try {
				const refund = await getStripeRefund(ctx, order.stripeRefundId);

				if (refund.status === "succeeded") {
				const updated = await recordSuccessfulRefund(
					ctx,
					order.id,
					order.stripeRefundId,
				);

				if (!updated) {
					throw new Error(
					"Stripe confirms the refund succeeded, but the local order could not be updated. Manual reconciliation is required.",
					);
				}

				const response = await buildOrderDetailsPage(ctx, order.id);

				response.toast = {
					message: "Refund confirmed and order updated.",
					type: "success",
				};

				return response;
				}

				if (refund.status === "pending") {
				const response = await buildOrderDetailsPage(ctx, order.id);

				response.toast = {
					message: "Stripe reports that this refund is still pending.",
					type: "success",
				};

				return response;
				}

				return {
				blocks: [
					blocks.header("Refund Requires Review"),
					blocks.section(
					`Stripe reports refund ${order.stripeRefundId} with status "${refund.status}". Review it in Stripe before taking further action.`,
					),
					blocks.actions([
					elements.button("stripe-order-details", "Back to Order", {
						value: order.id,
					}),
					]),
				],
				};
			} catch (error) {
				return {
				blocks: [
					blocks.header("Refund Status Check Failed"),
					blocks.section(
					error instanceof Error
						? error.message
						: "Unable to retrieve the refund status from Stripe.",
					),
					blocks.actions([
					elements.button("stripe-order-details", "Back to Order", {
						value: order.id,
					}),
					]),
				],
				};
			}
			}
			
			// Process a confirmed full refund
			if (
				interaction.type === "block_action" &&
				interaction.action_id === "stripe-refund-confirm"
			) {
			const orderId = interaction.value;

			if (typeof orderId !== "string" || !orderId.trim()) {
				return {
				blocks: [
					blocks.header("Invalid Order"),
					blocks.section("No valid order ID was provided."),
				],
				};
			}

			const order = await getOrder(ctx, orderId);

			if (!order || order.paymentStatus !== "paid") {
				return {
				blocks: [
					blocks.header("Refund Unavailable"),
					blocks.section(
					"This order was not found or is no longer eligible for a refund.",
					),
					blocks.actions([
					elements.button("stripe-orders-back", "Back to Orders"),
					]),
				],
				};
			}

			const claimed = await claimOrderForRefund(ctx, order.id);

			if (!claimed) {
				return {
					blocks: [
					blocks.header("Refund Already Being Processed"),
					blocks.section(
						"This order could not be claimed for a refund. It may already be processing or may no longer be eligible.",
					),
					blocks.actions([
						elements.button("stripe-orders-back", "Back to Orders"),
					]),
					],
				};
			}

			try {
				const paymentIntentId = await getStripePaymentIntent(
					ctx,
					order.stripeSessionId,
			);

				const refund = await createStripeRefund(
				ctx,
				paymentIntentId,
				order.id,
				);

				if (refund.status === "pending") {
					const recorded = await recordPendingRefund(
						ctx,
						order.id,
						refund.id!,
					);

					return {
						blocks: [
							blocks.header(
								recorded ? "Refund Pending" : "Refund Requires Reconciliation",
							),
							blocks.section(
								recorded
									? `Stripe accepted refund ${refund.id}, but processing is still pending. Check Stripe for its final status.`
									: `Stripe accepted refund ${refund.id}, but the local order could not be updated. Reconcile this order with Stripe before retrying.`,
								),
								blocks.actions([
									elements.button("stripe-orders-back", "Back to Orders"),
								]),
							],
						};
					}

					if (refund.status !== "succeeded") {
						return {
							blocks: [
							blocks.header("Refund Requires Review"),
							blocks.section(
								`Stripe returned refund ${refund.id} with status "${refund.status}". Check Stripe before attempting another refund.`,
							),
							blocks.actions([
								elements.button("stripe-orders-back", "Back to Orders"),
							]),
							],
						};
					}

				const updated = await recordSuccessfulRefund(
					ctx,
					order.id,
					refund.id!,
				);

				if (!updated) {
				throw new Error(
					"Stripe refunded the payment, but the local order could not be updated. Reconcile this order before retrying.",
				);
				}

				const response = await buildOrderDetailsPage(ctx, order.id);

				response.toast = {
				message: "Full refund completed successfully.",
				type: "success",
				};

				return response;
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: "An unexpected error occurred.";

				ctx.log.error("Stripe refund requires reconciliation", {
					orderId: order.id,
					message: errorMessage,
				});

				return {
					blocks: [
						blocks.header("Refund Requires Reconciliation"),
						blocks.section(
							`The refund could not be confirmed. Error: ${errorMessage}`,
						),
						blocks.section(
							"This order has been locked in refund_processing to prevent duplicate refunds. Check the payment and refund history in Stripe before taking further action. Do not initiate another refund until the outcome has been verified.",
						),
						blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
								value: order.id,
							}),
						]),
					],
				};
			}
			}
			
			// Show refund confirmation screen
			if (
				interaction.type === "block_action" &&
				interaction.action_id === "stripe-order-refund"
				) {
					const orderId = interaction.value;

					if (typeof orderId !== "string" || !orderId.trim()) {
						return {
						blocks: [
							blocks.header("Invalid Order"),
							blocks.section("No valid order ID was provided."),
							blocks.actions([
							elements.button("stripe-orders-back", "Back to Orders"),
							]),
						],
						};
					}

					return await buildRefundConfirmationPage(ctx, orderId);
				}
				
				// View individual order details
				if (
					interaction.type === "block_action" &&
					interaction.action_id === "stripe-order-details"
				) {
				const orderId = interaction.value;

				if (typeof orderId !== "string" || !orderId.trim()) {
					return {
					blocks: [
						blocks.header("Invalid Order"),
						blocks.section("No valid order ID was provided."),
						blocks.actions([
						elements.button(
							"stripe-orders-back",
							"Back to Orders",
						),
						]),
					],
					};
				}

				return await buildOrderDetailsPage(ctx, orderId);
				}

				// Return to Orders dashboard
				if (
					interaction.type === "block_action" &&
					interaction.action_id === "stripe-orders-back"
				) {
				return await buildAdminPage(ctx);
				}

				// Orders pagination
				if (
					interaction.type === "block_action" &&
					interaction.action_id === "stripe-orders-next-page"
				) {
				const value = interaction.value;

				const cursor =
					typeof value === "object" &&
					value !== null &&
					"cursor" in value &&
					typeof value.cursor === "string"
					? value.cursor
					: undefined;

				return await buildAdminPage(ctx, undefined, cursor);
				}

				// Default dashboard
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