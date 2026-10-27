import { afterEach, describe, expect, it } from "vitest";

import {
	createPluginRuntimeTestHost,
	type PluginRuntimeTestHost,
} from "@emdash-cms/plugin-test";

const STRIPE_URL = "https://api.stripe.com/v1/checkout/sessions";
const STRIPE_ACCOUNT_URL = "https://api.stripe.com/v1/account";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("createCheckoutSession route", () => {
	it("creates a Stripe Checkout session", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_test_123",
			status: "published",
			data: {
				name: "Test Product",
				price: 25,
				currency: "USD",
				active: true,
			},
		});
		
		await host.fixtures.plugin.setting("stripeSecretKey", "sk_test_example");

		await host.fixtures.plugin.kv("state:product:product_test_123", {
			stripeProductId: "prod_test_123",
			stripePriceId: "price_test_123",
			price: 25,
			currency: "usd",
		});

		for (let i = 0; i < 2; i++) {
			await host.http.respond(
				STRIPE_URL,
				new Response(
					JSON.stringify({
						id: "cs_test_123",
						url: "https://checkout.stripe.com/c/pay/cs_test_123",
					}),
					{
						status: 200,
						headers: {
							"Content-Type": "application/json",
						},
					},
				),
			);
		}

		const result = await host.transport.invokeRoute("createCheckoutSession", {
			productId: "product_test_123",
			returnPath: "/product-test",
			checkoutAttemptId: "attempt_test_123456",
		});

		expect(result).toEqual({
			ok: true,
			sessionId: "cs_test_123",
			checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
		});

		const requests = host.http.requests();

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(STRIPE_URL);
		expect(requests[0]?.method).toBe("POST");

		const headers = new Headers(requests[0]?.headers);

		const idempotencyKey = headers.get("Idempotency-Key");

		expect(idempotencyKey).toMatch(/^checkout_[a-f0-9]{64}$/);
		expect(idempotencyKey).toHaveLength(73);

		// Retry the same checkout attempt.
		const retryResult = await host.transport.invokeRoute(
			"createCheckoutSession",
			{
				productId: "product_test_123",
				returnPath: "/product-test",
				checkoutAttemptId: "attempt_test_123456",
			},
		);

		expect(retryResult).toEqual({
			ok: true,
			sessionId: "cs_test_123",
			checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
		});

		// Verify the retry uses the identical idempotency key.
		const retryRequests = host.http.requests();

		expect(retryRequests).toHaveLength(2);

		const retryHeaders = new Headers(retryRequests[1]?.headers);

		expect(retryHeaders.get("Idempotency-Key")).toBe(idempotencyKey);

// Mark the existing order as paid.
const now = new Date().toISOString();

await host.fixtures.plugin.storage("orders", "cs_test_123", {
    id: "cs_test_123",
    stripeSessionId: "cs_test_123",
    productId: "product_test_123",
    productName: "Test Product",
    quantity: 1,
    amountTotal: 2500,
    currency: "usd",
    paymentStatus: "paid",
    customerEmail: null,
    createdAt: now,
    updatedAt: now,
    paidAt: now,
});

// Stripe returns the same session for another retry.
await host.http.respond(
    STRIPE_URL,
    new Response(
        JSON.stringify({
            id: "cs_test_123",
            url: "https://checkout.stripe.com/c/pay/cs_test_123",
        }),
        {
            status: 200,
            headers: {
                "Content-Type": "application/json",
            },
        },
    ),
);

const paidRetryResult = await host.transport.invokeRoute(
    "createCheckoutSession",
    {
        productId: "product_test_123",
        returnPath: "/product-test",
        checkoutAttemptId: "attempt_test_123456",
    },
);

expect(paidRetryResult).toEqual({
    ok: false,
    error: "An order already exists for this Checkout Session.",
});

// A new checkout attempt must generate a different idempotency key.
await host.http.respond(
    STRIPE_URL,
    new Response(
        JSON.stringify({
            id: "cs_test_456",
            url: "https://checkout.stripe.com/c/pay/cs_test_456",
        }),
        {
            status: 200,
            headers: {
                "Content-Type": "application/json",
            },
        },
    ),
);

const newAttemptResult = await host.transport.invokeRoute(
    "createCheckoutSession",
    {
        productId: "product_test_123",
        returnPath: "/product-test",
        checkoutAttemptId: "attempt_test_654321",
    },
);

expect(newAttemptResult).toEqual({
    ok: true,
    sessionId: "cs_test_456",
    checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_456",
});

const allRequests = host.http.requests();

expect(allRequests).toHaveLength(4);

const newAttemptHeaders = new Headers(allRequests[3]?.headers);
const newAttemptKey = newAttemptHeaders.get("Idempotency-Key");

expect(newAttemptKey).toMatch(/^checkout_[a-f0-9]{64}$/);
expect(newAttemptKey).not.toBe(idempotencyKey);

const body = new TextDecoder().decode(requests[0]?.body);

	expect(body).toContain(
		"line_items%5B0%5D%5Bprice%5D=price_test_123",
	);

	expect(body).toContain(
		"success_url=https%3A%2F%2Fplugin.test%2Fproduct-test%3Fcheckout%3Dsuccess%26session_id%3D%7BCHECKOUT_SESSION_ID%7D",
	);
	expect(body).toContain(
		"cancel_url=https%3A%2F%2Fplugin.test%2Fproduct-test%3Fcheckout%3Dcancel",
	);

});

	it("creates a Checkout Session without checkoutAttemptId", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_legacy_123",
			status: "published",
			data: {
				name: "Legacy Product",
				price: 25,
				currency: "USD",
				active: true,
			},
		});

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.plugin.kv("state:product:product_legacy_123", {
			stripeProductId: "prod_legacy_123",
			stripePriceId: "price_legacy_123",
			price: 25,
			currency: "usd",
		});

		await host.http.respond(
			STRIPE_URL,
			new Response(
				JSON.stringify({
					id: "cs_test_legacy123",
					url: "https://checkout.stripe.com/c/pay/cs_test_legacy123",
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		// Existing integrations do not supply checkoutAttemptId.
		const result = await host.transport.invokeRoute(
			"createCheckoutSession",
			{
				productId: "product_legacy_123",
				returnPath: "/legacy-product",
			},
		);

		expect(result).toEqual({
			ok: true,
			sessionId: "cs_test_legacy123",
			checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_legacy123",
		});

		const requests = host.http.requests();

		expect(requests).toHaveLength(1);

		const headers = new Headers(requests[0]?.headers);

		expect(headers.has("Idempotency-Key")).toBe(false);
	});

	it("rejects checkout when the Stripe price is out of sync", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_outdated",
			status: "published",
			data: {
				name: "Test Product",
				price: 30,
				currency: "USD",
				active: true,
			},
		});

		await host.fixtures.plugin.kv("state:product:product_outdated", {
			stripeProductId: "prod_test_outdated",
			stripePriceId: "price_old_123",
			price: 25,
			currency: "usd",
		});

		const result = await host.transport.invokeRoute(
			"createCheckoutSession",
			{
				productId: "product_outdated",
			},
		);

		expect(result).toEqual({
			ok: false,
			error: "This product's price is not synchronized with Stripe.",
		});

		expect(host.http.requests()).toHaveLength(0);
	});
	
	it("rejects checkout for an inactive product", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_inactive",
			data: {
				name: "Inactive Test Product",
				active: false,
			},
		});

		await host.fixtures.plugin.kv("state:product:product_inactive", {
			stripeProductId: "prod_test_inactive",
			stripePriceId: "price_test_inactive",
			price: 25,
			currency: "usd",
		});

		const result = await host.transport.invokeRoute(
			"createCheckoutSession",
			{
				productId: "product_inactive",
			},
		);

		expect(result).toEqual({
			ok: false,
			error: "This product is currently unavailable for purchase.",
		});
	});

	it("rejects invalid checkout requests", async () => {
		host = await createPluginRuntimeTestHost();

		const invalidRequests = [
			{
				productId: "",
			},
			{
				productId: "product_test_123",
				checkoutAttemptId: "short",
			},
			{
				productId: "product_test_123",
				checkoutAttemptId: "invalid attempt id",
			},
			{
				productId: "product_test_123",
				checkoutAttemptId: "attempt_123!",
			},
			{
				productId: "product_test_123",
				checkoutAttemptId: 12345678,
			},
			{
				productId: "product_test_123",
				checkoutAttemptId: "a".repeat(129),
			},
		];

		for (const input of invalidRequests) {
			const result = await host.transport.invokeRoute(
				"createCheckoutSession",
				input,
			);

			expect(result).toEqual({
				ok: false,
				error: "Invalid checkout request.",
			});
		}

		expect(host.http.requests()).toHaveLength(0);
	});

	it("rejects an external return path", async () => {
		host = await createPluginRuntimeTestHost();

		const result = await host.transport.invokeRoute("createCheckoutSession", {
			productId: "product_test_123",
			returnPath: "//evil.example",
		});

		expect(result).toEqual({
			ok: false,
			error: "Invalid checkout request.",
		});
	});

	it("handles a Stripe API error", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_bad",
			status: "published",
			data: {
				name: "Test Product",
				price: 25,
				currency: "USD",
				active: true,
			},
		});

		await host.fixtures.plugin.setting("stripeSecretKey", "sk_test_example");

		await host.fixtures.plugin.kv("state:product:product_bad", {
			stripeProductId: "prod_test_bad",
			stripePriceId: "price_bad",
			price: 25,
			currency: "usd",
		});

		await host.http.respond(
			STRIPE_URL,
			new Response(
				JSON.stringify({
					error: {
						message: "No such price: 'price_bad'",
					},
				}),
				{
					status: 400,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		const result = await host.transport.invokeRoute("createCheckoutSession", {
			productId: "product_bad",
		});

		expect(result).toEqual({
			ok: false,
			error: "No such price: 'price_bad'",
		});
	});

	it("verifies a paid Stripe Checkout session", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting("stripeSecretKey", "sk_test_example");

		const sessionId = "cs_test_paid123";

		const now = new Date().toISOString();

		await host.fixtures.plugin.storage("orders", sessionId, {
			id: sessionId,
			stripeSessionId: sessionId,
			productId: "product_test_123",
			quantity: 1,
			amountTotal: 2500,
			currency: "usd",
			paymentStatus: "pending",
			customerEmail: null,
			createdAt: now,
			updatedAt: now,
			paidAt: null,
		});

		await host.http.respond(
			`https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
			new Response(
				JSON.stringify({
					id: sessionId,
					payment_status: "paid",
					client_reference_id: "product_test_123",
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		const result = await host.transport.invokeRoute(
			"verifyCheckoutSession",
			{
				sessionId,
				productId: "product_test_123",
			},
		);

		expect(result).toEqual({
			ok: true,
			sessionId,
			paid: true,
			paymentStatus: "paid",
		});
	});

	it("does not change a refunded order back to paid during checkout verification", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting("stripeSecretKey", "sk_test_example");

		const sessionId = "cs_test_refunded123";
		const now = new Date().toISOString();

		await host.fixtures.plugin.storage("orders", sessionId, {
			id: sessionId,
			stripeSessionId: sessionId,
			productId: "product_test_123",
			quantity: 1,
			amountTotal: 2500,
			currency: "usd",
			paymentStatus: "refunded",
			customerEmail: null,
			createdAt: now,
			updatedAt: now,
			paidAt: now,
			stripeRefundId: "re_test_123",
			refundStatus: "succeeded",
			refundedAt: now,
		});

		await host.http.respond(
			`https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
			new Response(
			JSON.stringify({
				id: sessionId,
				payment_status: "paid",
				client_reference_id: "product_test_123",
			}),
			{
				status: 200,
				headers: {
				"Content-Type": "application/json",
				},
			},
			),
		);

		const result = await host.transport.invokeRoute(
			"verifyCheckoutSession",
			{
			sessionId,
			productId: "product_test_123",
			},
		);

		expect(result).toEqual({
			ok: true,
			sessionId,
			paid: true,
			paymentStatus: "paid",
		});

		const storedOrder = await host.inspect.storage.get(
			"orders",
			sessionId,
		);

		expect(storedOrder).toMatchObject({
			paymentStatus: "refunded",
			stripeRefundId: "re_test_123",
			refundStatus: "succeeded",
			refundedAt: now,
		});
	});

	it("does not change a pending refund back to paid during checkout verification", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting("stripeSecretKey", "sk_test_example");

		const sessionId = "cs_test_refund_pending123";
		const now = new Date().toISOString();

		await host.fixtures.plugin.storage("orders", sessionId, {
			id: sessionId,
			stripeSessionId: sessionId,
			productId: "product_test_123",
			quantity: 1,
			amountTotal: 2500,
			currency: "usd",
			paymentStatus: "refund_pending",
			customerEmail: null,
			createdAt: now,
			updatedAt: now,
			paidAt: now,
			stripeRefundId: "re_test_123",
			refundStatus: "pending",
			refundedAt: null,
		});

		await host.http.respond(
			`https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
			new Response(
			JSON.stringify({
				id: sessionId,
				payment_status: "paid",
				client_reference_id: "product_test_123",
			}),
			{
				status: 200,
				headers: {
				"Content-Type": "application/json",
				},
			},
			),
		);

		const result = await host.transport.invokeRoute(
			"verifyCheckoutSession",
			{
			sessionId,
			productId: "product_test_123",
			},
		);

		expect(result).toEqual({
			ok: true,
			sessionId,
			paid: true,
			paymentStatus: "paid",
		});

		const storedOrder = await host.inspect.storage.get(
			"orders",
			sessionId,
		);

		expect(storedOrder).toMatchObject({
			paymentStatus: "refund_pending",
			stripeRefundId: "re_test_123",
			refundStatus: "pending",
			refundedAt: null,
		});
	});

	it("rejects a Checkout session for a different product", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting("stripeSecretKey", "sk_test_example");

		const sessionId = "cs_test_wrong_product";

		await host.http.respond(
			`https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
			new Response(
				JSON.stringify({
					id: sessionId,
					payment_status: "paid",
					client_reference_id: "product_a",
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		const result = await host.transport.invokeRoute(
			"verifyCheckoutSession",
			{
				sessionId,
				productId: "product_b",
			},
		);

		expect(result).toEqual({
			ok: false,
			error: "Checkout Session does not match this product.",
		});
	});

	it("does not verify an unpaid Stripe Checkout session as paid", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting("stripeSecretKey", "sk_test_example");

		const sessionId = "cs_test_unpaid123";

		await host.http.respond(
			`https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
			new Response(
				JSON.stringify({
					id: sessionId,
					payment_status: "unpaid",
					client_reference_id: "product_test_123",
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		const result = await host.transport.invokeRoute(
			"verifyCheckoutSession",
			{
				sessionId,
				productId: "product_test_123",
			},
		);

		expect(result).toEqual({
			ok: true,
			sessionId,
			paid: false,
			paymentStatus: "unpaid",
		});
	});

	it("rejects verification when the Stripe Secret Key is missing", async () => {
		host = await createPluginRuntimeTestHost();

		const result = await host.transport.invokeRoute(
			"verifyCheckoutSession",
			{
				sessionId: "cs_test_missing_key",
				productId: "product_test_123",
			},
		);

		expect(result).toEqual({
			ok: false,
			error: "Stripe Secret Key has not been configured.",
		});
	});

	it("handles a Stripe API error during Checkout verification", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting("stripeSecretKey", "sk_test_example");

		const sessionId = "cs_test_invalid123";

		await host.http.respond(
			`https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
			new Response(
				JSON.stringify({
					error: {
						message: "No such checkout.session",
					},
				}),
				{
					status: 404,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		const result = await host.transport.invokeRoute(
			"verifyCheckoutSession",
			{
				sessionId,
				productId: "product_test_123",
			},
		);

		expect(result).toEqual({
			ok: false,
			error: "Checkout Session could not be verified.",
		});
	});

	it("rejects checkout for an unpublished product", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_unpublished",
			status: "draft",
			data: {
				name: "Unpublished Test Product",
				active: true,
			},
		});

		await host.fixtures.plugin.kv("state:product:product_unpublished", {
			stripeProductId: "prod_test_unpublished",
			stripePriceId: "price_test_unpublished",
			price: 25,
			currency: "usd",
		});

		const result = await host.transport.invokeRoute(
			"createCheckoutSession",
			{
				productId: "product_unpublished",
			},
		);

		expect(result).toEqual({
			ok: false,
			error: "This product is currently unavailable for purchase.",
		});

		expect(host.http.requests()).toHaveLength(0);
	});
});

describe("product sync", () => {
	it("syncs products from a custom Content Type", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.plugin.setting(
		"productContentTypeSlug",
		"store_items",
	);

	await host.fixtures.collection({
		slug: "store_items",
		label: "Store Items",
		fields: [
			{ slug: "name", label: "Name", type: "string", required: true },
			{ slug: "description", label: "Description", type: "string" },
			{ slug: "price", label: "Price", type: "number" },
			{ slug: "currency", label: "Currency", type: "string" },
			{ slug: "sku", label: "SKU", type: "string" },
			{ slug: "active", label: "Active", type: "boolean" },
		],
	});

	await host.fixtures.content("store_items", {
		id: "custom_product_123",
		status: "published",
		data: {
			name: "Custom T-Shirt",
			description: "A product from a custom Content Type",
			price: 25,
			currency: "USD",
			sku: "CUSTOM-001",
			active: true,
		},
	});

		await host.http.respond(
			"https://api.stripe.com/v1/products",
			new Response(
				JSON.stringify({ id: "prod_custom_123" }),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		await host.http.respond(
			"https://api.stripe.com/v1/prices",
			new Response(
				JSON.stringify({ id: "price_custom_123" }),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		await host.transport.invokeHook("content:afterPublish", {
			collection: "store_items",
			content: {
				id: "custom_product_123",
				data: {
					name: "Custom T-Shirt",
					description: "A product from a custom Content Type",
					price: 25,
					currency: "USD",
					sku: "CUSTOM-001",
					active: true,
				},
			},
		});

		const requests = host.http.requests();

		expect(
			requests.some(
				(request) =>
					request.url === "https://api.stripe.com/v1/products",
			),
		).toBe(true);

		expect(
			requests.some(
				(request) =>
					request.url === "https://api.stripe.com/v1/prices",
			),
		).toBe(true);
	});
	
	it("creates a Stripe Product when a product is published", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "description", label: "Description", type: "string" },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_test_123",
			status: "published",
			data: {
				name: "Test T-Shirt",
				description: "A test product",
				price: 25,
				currency: "USD",
				sku: "SHIRT-001",
				active: true,
			},
		});

		await host.http.respond(
			"https://api.stripe.com/v1/products",
			new Response(
				JSON.stringify({
					id: "prod_test_123",
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		await host.http.respond(
			"https://api.stripe.com/v1/prices",
			new Response(
				JSON.stringify({
					id: "price_test_123",
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		await host.transport.invokeHook("content:afterPublish", {
			collection: "products",
			content: {
				id: "product_test_123",
				data: {
					name: "Test T-Shirt",
					description: "A test product",
					price: 25,
					currency: "USD",
					sku: "SHIRT-001",
					active: true,
				},
			},
		});

		const requests = host.http.requests();

		const productRequest = requests.find(
			(request) =>
				request.url === "https://api.stripe.com/v1/products",
		);

		expect(productRequest).toBeDefined();
		expect(productRequest?.headers["idempotency-key"]).toBe(
			"emdash-product-product_test_123",
		);

		const priceRequest = requests.find(
			(request) =>
				request.url === "https://api.stripe.com/v1/prices",
		);

		expect(priceRequest).toBeDefined();
		expect(priceRequest?.headers["idempotency-key"]).toMatch(
			/^emdash-price-product_test_123-[0-9a-f-]{36}$/,
		);

	});

	it("creates a new Stripe Price when the product price changes", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "description", label: "Description", type: "string" },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_test_123",
			status: "published",
			data: {
				name: "Test T-Shirt",
				description: "A test product",
				price: 30,
				currency: "USD",
				sku: "SHIRT-001",
				active: true,
			},
		});

		await host.fixtures.plugin.kv(
			"state:product:product_test_123",
			{
				stripeProductId: "prod_test_123",
				stripePriceId: "price_old_123",
				price: 25,
				currency: "usd",
			},
		);

		await host.http.respond(
			"https://api.stripe.com/v1/products/prod_test_123",
			new Response(
				JSON.stringify({
					id: "prod_test_123",
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		await host.http.respond(
			"https://api.stripe.com/v1/prices",
			new Response(
				JSON.stringify({
					id: "price_new_123",
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		await host.http.respond(
			"https://api.stripe.com/v1/prices/price_old_123",
			new Response(
				JSON.stringify({
					id: "price_old_123",
					active: false,
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		await host.transport.invokeHook("content:afterPublish", {
			collection: "products",
			content: {
				id: "product_test_123",
				data: {
					name: "Test T-Shirt",
					description: "A test product",
					price: 30,
					currency: "USD",
					sku: "SHIRT-001",
					active: true,
				},
			},
		});

		const requests = host.http.requests();

		const newPriceRequest = requests.find(
			(request) =>
				request.url === "https://api.stripe.com/v1/prices",
		);

		expect(newPriceRequest).toBeDefined();
		expect(newPriceRequest?.headers["idempotency-key"]).toMatch(
			/^emdash-price-product_test_123-[0-9a-f-]{36}$/,
		);

		const productCreateRequest = requests.find(
			(request) =>
				request.url === "https://api.stripe.com/v1/products",
		);

		expect(productCreateRequest).toBeUndefined();

		const oldPriceRequest = requests.find(
			(request) =>
				request.url ===
				"https://api.stripe.com/v1/prices/price_old_123",
		);

		expect(oldPriceRequest).toBeDefined();
		expect(oldPriceRequest?.method).toBe("POST");

		const oldPriceBody = new TextDecoder().decode(
			oldPriceRequest?.body,
		);

		expect(oldPriceBody).toContain("active=false");

	});

	it("does not create a new Stripe Price when the price is unchanged", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "description", label: "Description", type: "string" },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_test_123",
			status: "published",
			data: {
				name: "Updated Test T-Shirt",
				description: "Updated product description",
				price: 25,
				currency: "USD",
				sku: "SHIRT-001",
				active: true,
			},
		});

		await host.fixtures.plugin.kv(
			"state:product:product_test_123",
			{
				stripeProductId: "prod_test_123",
				stripePriceId: "price_existing_123",
				price: 25,
				currency: "usd",
			},
		);

		await host.http.respond(
			"https://api.stripe.com/v1/products/prod_test_123",
			new Response(
				JSON.stringify({
					id: "prod_test_123",
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		await host.transport.invokeHook("content:afterPublish", {
			collection: "products",
			content: {
				id: "product_test_123",
				data: {
					name: "Updated Test T-Shirt",
					description: "Updated product description",
					price: 25,
					currency: "USD",
					sku: "SHIRT-001",
					active: true,
				},
			},
		});

		const requests = host.http.requests();

		const productUpdateRequest = requests.find(
			(request) =>
				request.url ===
				"https://api.stripe.com/v1/products/prod_test_123",
		);

		expect(productUpdateRequest).toBeDefined();
		expect(productUpdateRequest?.method).toBe("POST");

		const priceCreateRequest = requests.find(
			(request) =>
				request.url === "https://api.stripe.com/v1/prices",
		);

		expect(priceCreateRequest).toBeUndefined();

	});

	it("deactivates a Stripe Product when an EmDash product is disabled", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting("stripeSecretKey", "sk_test_example");

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "description", label: "Description", type: "string" },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_test_123",
			status: "published",
			data: {
				name: "Test T-Shirt",
				description: "A test product",
				price: 25,
				currency: "USD",
				sku: "SHIRT-001",
				active: false,
			},
		});

		await host.fixtures.plugin.kv("state:product:product_test_123", {
			stripeProductId: "prod_test_123",
			stripePriceId: "price_existing_123",
			price: 25,
			currency: "usd",
		});

		await host.http.respond(
			"https://api.stripe.com/v1/products/prod_test_123",
			new Response(JSON.stringify({ id: "prod_test_123", active: false }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await host.transport.invokeHook("content:afterPublish", {
			collection: "products",
			content: {
				id: "product_test_123",
				data: {
					name: "Test T-Shirt",
					description: "A test product",
					price: 25,
					currency: "USD",
					sku: "SHIRT-001",
					active: false,
				},
			},
		});

		const requests = host.http.requests();

		const productUpdateRequest = requests.find(
			(request) =>
				request.url ===
				"https://api.stripe.com/v1/products/prod_test_123",
		);

		expect(productUpdateRequest).toBeDefined();
		expect(productUpdateRequest?.method).toBe("POST");

		const body = new TextDecoder().decode(productUpdateRequest?.body);

		expect(body).toContain("active=false");

		const priceCreateRequest = requests.find(
			(request) => request.url === "https://api.stripe.com/v1/prices",
		);

		expect(priceCreateRequest).toBeUndefined();
	});

	it("preserves the pending Stripe Price operation after a network exception", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "description", label: "Description", type: "string" },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_test_123",
			status: "published",
			data: {
				name: "Test T-Shirt",
				description: "A test product",
				price: 30,
				currency: "USD",
				sku: "SHIRT-001",
				active: true,
			},
		});

		await host.fixtures.plugin.kv(
			"state:product:product_test_123",
			{
				stripeProductId: "prod_test_123",
				stripePriceId: "price_old_123",
				price: 25,
				currency: "usd",
			},
		);

		// Product update succeeds.
		await host.http.respond(
			"https://api.stripe.com/v1/products/prod_test_123",
			new Response(
				JSON.stringify({ id: "prod_test_123" }),
				{ status: 200 },
			),
		);

		// Intentionally do NOT queue a response for /v1/prices.
		// The test host throws when no HTTP response is available,
		// simulating a network exception.

		const publishEvent = {
			collection: "products",
			content: {
				id: "product_test_123",
				data: {
					name: "Test T-Shirt",
					description: "A test product",
					price: 30,
					currency: "USD",
					sku: "SHIRT-001",
					active: true,
				},
			},
		};

		// The plugin should catch the network exception.
		await host.transport.invokeHook(
			"content:afterPublish",
			publishEvent,
		);

		const state = await host.inspect.kv.get<{
			stripePriceId?: string;
			price?: number;
			pendingPriceOperation?: {
				operationId: string;
				status?: string;
				attemptId?: string;
			};
		}>("state:product:product_test_123");

		// The previous Stripe Price must remain unchanged.
		expect(state?.stripePriceId).toBe("price_old_123");
		expect(state?.price).toBe(25);

		// The operation must remain pending for timeout recovery.
		expect(state?.pendingPriceOperation?.status).toBe("processing");
		expect(state?.pendingPriceOperation?.operationId).toBeTruthy();
		expect(state?.pendingPriceOperation?.attemptId).toBeTruthy();

		const requests = host.http.requests();

		// Stripe Price creation was attempted.
		expect(
			requests.filter(
				(request) =>
					request.url === "https://api.stripe.com/v1/prices",
			),
		).toHaveLength(1);

		// The previous Stripe Price must not be deactivated.
		expect(
			requests.some(
				(request) =>
					request.url ===
					"https://api.stripe.com/v1/prices/price_old_123",
			),
		).toBe(false);
	});
	
	it("recovers a timed-out Stripe Price operation using the original idempotency key", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "description", label: "Description", type: "string" },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_test_123",
			status: "published",
			data: {
				name: "Test T-Shirt",
				description: "A test product",
				price: 30,
				currency: "USD",
				sku: "SHIRT-001",
				active: true,
			},
		});

		const originalOperationId = "original-operation-123";
		const originalAttemptId = "original-attempt-123";
		const now = Date.now();

		await host.fixtures.plugin.kv(
			"state:product:product_test_123",
			{
				stripeProductId: "prod_test_123",
				stripePriceId: "price_old_123",
				price: 25,
				currency: "usd",
				pendingPriceOperation: {
					operationId: originalOperationId,
					attemptId: originalAttemptId,
					stripeProductId: "prod_test_123",
					currency: "usd",
					unitAmount: 3000,
					status: "processing",
					createdAt: now - 10 * 60 * 1000,
					processingStartedAt: now - 6 * 60 * 1000,
				},
			},
		);

		// Existing Stripe Product update succeeds.
		await host.http.respond(
			"https://api.stripe.com/v1/products/prod_test_123",
			new Response(
				JSON.stringify({ id: "prod_test_123" }),
				{ status: 200 },
			),
		);

		// Stripe returns the Price associated with the original operation.
		await host.http.respond(
			"https://api.stripe.com/v1/prices",
			new Response(
				JSON.stringify({ id: "price_recovered_123" }),
				{ status: 200 },
			),
		);

		// Previous Stripe Price can be deactivated after recovery.
		await host.http.respond(
			"https://api.stripe.com/v1/prices/price_old_123",
			new Response(
				JSON.stringify({
					id: "price_old_123",
					active: false,
				}),
				{ status: 200 },
			),
		);

		await host.transport.invokeHook("content:afterPublish", {
			collection: "products",
			content: {
				id: "product_test_123",
				data: {
					name: "Test T-Shirt",
					description: "A test product",
					price: 30,
					currency: "USD",
					sku: "SHIRT-001",
					active: true,
				},
			},
		});

		const requests = host.http.requests();

		const priceRequests = requests.filter(
			(request) =>
				request.url === "https://api.stripe.com/v1/prices",
		);

		expect(priceRequests).toHaveLength(1);

		expect(
			priceRequests[0].headers["idempotency-key"],
		).toBe(
			`emdash-price-product_test_123-${originalOperationId}`,
		);

		const state = await host.inspect.kv.get<{
			stripePriceId?: string;
			price?: number;
			currency?: string;
			pendingPriceOperation?: {
				operationId: string;
				attemptId?: string;
				status?: string;
			};
		}>("state:product:product_test_123");

		// Recovery saves the new Stripe Price.
		expect(state?.stripePriceId).toBe("price_recovered_123");
		expect(state?.price).toBe(30);
		expect(state?.currency).toBe("usd");

		// The pending operation is cleared after successful completion.
		expect(state?.pendingPriceOperation).toBeUndefined();

		// The previous Stripe Price is deactivated after completion.
		const deactivationRequests = requests.filter(
			(request) =>
				request.url ===
				"https://api.stripe.com/v1/prices/price_old_123",
		);

		expect(deactivationRequests).toHaveLength(1);
	});
	
	it("reuses the Stripe Price idempotency key when retrying a failed creation", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "description", label: "Description", type: "string" },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_test_123",
			status: "published",
			data: {
				name: "Test T-Shirt",
				description: "A test product",
				price: 30,
				currency: "USD",
				sku: "SHIRT-001",
				active: true,
			},
		});

		await host.fixtures.plugin.kv(
			"state:product:product_test_123",
			{
				stripeProductId: "prod_test_123",
				stripePriceId: "price_old_123",
				price: 25,
				currency: "usd",
			},
		);

		// Both publish attempts update the existing Stripe Product.
		for (let i = 0; i < 2; i++) {
			await host.http.respond(
				"https://api.stripe.com/v1/products/prod_test_123",
				new Response(
					JSON.stringify({ id: "prod_test_123" }),
					{ status: 200 },
				),
			);
		}

		// First price creation fails.
		await host.http.respond(
			"https://api.stripe.com/v1/prices",
			new Response(
				JSON.stringify({
					error: { message: "Unable to create Stripe Price" },
				}),
				{ status: 400 },
			),
		);

		// Retrying the same price creation succeeds.
		await host.http.respond(
			"https://api.stripe.com/v1/prices",
			new Response(
				JSON.stringify({ id: "price_retry_123" }),
				{ status: 200 },
			),
		);

		// Successful retry should deactivate the previous price.
		await host.http.respond(
			"https://api.stripe.com/v1/prices/price_old_123",
			new Response(
				JSON.stringify({ id: "price_old_123", active: false }),
				{ status: 200 },
			),
		);

		const publishEvent = {
			collection: "products",
			content: {
				id: "product_test_123",
				data: {
					name: "Test T-Shirt",
					description: "A test product",
					price: 30,
					currency: "USD",
					sku: "SHIRT-001",
					active: true,
				},
			},
		};

		// First attempt fails.
		await host.transport.invokeHook("content:afterPublish", publishEvent);

		const firstRequests = host.http.requests();

		const firstPriceRequest = firstRequests.find(
			(request) =>
				request.url === "https://api.stripe.com/v1/prices",
		);

		expect(firstPriceRequest).toBeDefined();

		expect(
			firstRequests.some(
				(request) =>
					request.url ===
					"https://api.stripe.com/v1/prices/price_old_123",
			),
		).toBe(false);

		// Second attempt retries the same product and price.
		await host.transport.invokeHook("content:afterPublish", publishEvent);

		const requests = host.http.requests();

		const priceRequests = requests.filter(
			(request) =>
				request.url === "https://api.stripe.com/v1/prices",
		);

		expect(priceRequests).toHaveLength(2);

		// Both attempts must use the same idempotency key.
		const firstKey = priceRequests[0].headers["idempotency-key"];
		const secondKey = priceRequests[1].headers["idempotency-key"];

		expect(firstKey).toBeTruthy();
		expect(secondKey).toBe(firstKey);

		// The old price is deactivated only after successful creation.
		const deactivationRequests = requests.filter(
			(request) =>
				request.url ===
				"https://api.stripe.com/v1/prices/price_old_123",
		);

		expect(deactivationRequests).toHaveLength(1);
	});

	it("deactivates Stripe Product when EmDash product is deleted", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.plugin.kv("state:product:product_test_123", {
			stripeProductId: "prod_test_123",
			stripePriceId: "price_test_123",
			price: 25,
			currency: "usd",
		});

		await host.http.respond(
			"https://api.stripe.com/v1/products/prod_test_123",
			new Response(JSON.stringify({
				id: "prod_test_123",
				active: false,
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await host.transport.invokeHook("content:afterDelete", {
			id: "product_test_123",
			collection: "products",
			permanent: false,
		});

		const request = host.http.requests().find(
			(request) =>
				request.url ===
				"https://api.stripe.com/v1/products/prod_test_123",
		);

		expect(request).toBeDefined();
		expect(request?.method).toBe("POST");

		const body = new TextDecoder().decode(request?.body);
		expect(body).toContain("active=false");

	});

	it("reactivates a published product when restored from trash", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "description", label: "Description", type: "string" },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		await host.fixtures.content("products", {
			id: "product_test_123",
			status: "published",
			data: {
				name: "Test Product",
				description: "Restored product",
				sku: "TEST-123",
				price: 25,
				currency: "usd",
				active: true,
			},
		});

		await host.fixtures.plugin.kv("state:product:product_test_123", {
			stripeProductId: "prod_test_123",
			stripePriceId: "price_test_123",
			price: 25,
			currency: "usd",
		});

		await host.http.respond(
			"https://api.stripe.com/v1/products/prod_test_123",
			new Response(JSON.stringify({
				id: "prod_test_123",
				active: true,
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await host.transport.invokeHook("content:afterRestore", {
			collection: "products",
			content: {
				id: "product_test_123",
				status: "published",
				data: {
					name: "Test Product",
					description: "Restored product",
					sku: "TEST-123",
					price: 25,
					currency: "usd",
					active: true,
				},
			},
		});

		const request = host.http.requests().find(
			(request) =>
				request.url ===
				"https://api.stripe.com/v1/products/prod_test_123",
		);

		expect(request).toBeDefined();
		expect(request?.method).toBe("POST");

		const body = new TextDecoder().decode(request?.body);
		expect(body).toContain("active=true");
	});

	it("does not reactivate a draft product when restored", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.plugin.kv("state:product:product_test_123", {
			stripeProductId: "prod_test_123",
			stripePriceId: "price_test_123",
			price: 25,
			currency: "usd",
		});

		await host.transport.invokeHook("content:afterRestore", {
			collection: "products",
			content: {
				id: "product_test_123",
				status: "draft",
				data: {
					name: "Test Product",
					price: 25,
					currency: "usd",
					active: true,
				},
			},
		});

		const stripeRequests = host.http.requests().filter(
			(request) =>
				request.url.includes("api.stripe.com/v1/products"),
		);

		expect(stripeRequests).toHaveLength(0);
	});

	it("deactivates Stripe Product when EmDash product is unpublished", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.plugin.kv("state:product:product_test_123", {
			stripeProductId: "prod_test_123",
			stripePriceId: "price_test_123",
			price: 25,
			currency: "usd",
		});

		await host.http.respond(
			"https://api.stripe.com/v1/products/prod_test_123",
			new Response(JSON.stringify({
				id: "prod_test_123",
				active: false,
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await host.transport.invokeHook("content:afterUnpublish", {
			collection: "products",
			content: {
				id: "product_test_123",
				status: "draft",
				data: {
					name: "Test Product",
					price: 25,
					currency: "usd",
					active: true,
				},
			},
		});

		const request = host.http.requests().find(
			(request) =>
				request.url ===
				"https://api.stripe.com/v1/products/prod_test_123",
		);

		expect(request).toBeDefined();
		expect(request?.method).toBe("POST");

		const body = new TextDecoder().decode(request?.body);
		expect(body).toContain("active=false");
	});

	it("does not sync an outdated publish event over a newer published price", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "currency", label: "Currency", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		// The currently published product has the newer $30 price.
		await host.fixtures.content("products", {
			id: "product_stale_event",
			status: "published",
			data: {
				name: "Test Product",
				price: 30,
				currency: "USD",
				active: true,
			},
		});

		await host.fixtures.plugin.kv("state:product:product_stale_event", {
			stripeProductId: "prod_stale_event",
			stripePriceId: "price_current_30",
			price: 30,
			currency: "usd",
		});

		// An older event arrives after the $30 price was published.
		await host.transport.invokeHook("content:afterPublish", {
			collection: "products",
			content: {
				id: "product_stale_event",
				data: {
					name: "Test Product",
					price: 25,
					currency: "USD",
					active: true,
				},
			},
		});

		// The older event must not change the Stripe Product or Price.
		expect(host.http.requests()).toHaveLength(0);
	});
});

describe("checkProductSchema route", () => {
	it("checks the Products collection schema", async () => {
		host = await createPluginRuntimeTestHost();

		const result = await host.transport.invokeRoute(
			"checkProductSchema",
		);

		expect(result).toEqual({
			ok: false,
			collectionExists: false,
			fields: [
				{
					slug: "name",
					expectedType: "string",
					required: true,
					exists: false,
					valid: false,
				},
				{
					slug: "description",
					expectedType: "text",
					required: false,
					exists: false,
					valid: false,
				},
				{
					slug: "image",
					expectedType: "image",
					required: false,
					exists: false,
					valid: false,
				},
				{
					slug: "price",
					expectedType: "number",
					required: true,
					exists: false,
					valid: false,
				},
				{
					slug: "currency",
					expectedType: "select",
					required: true,
					exists: false,
					valid: false,
				},
				{
					slug: "sku",
					expectedType: "string",
					required: false,
					exists: false,
					valid: false,
				},
				{
					slug: "active",
					expectedType: "boolean",
					required: false,
					exists: false,
					valid: false,
				},
			],
		});
	});

	it("reports invalid fields in the Products collection schema", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Product Name", type: "string" },
				{ slug: "description", label: "Description", type: "text" },
				{ slug: "price", label: "Price", type: "string" },
				{ slug: "currency", label: "Currency", type: "select", required: true },
			],
		});

		const result = await host.transport.invokeRoute(
			"checkProductSchema",
		);

		expect(result).toMatchObject({
			ok: false,
			collectionExists: true,
			fields: [
				{
					slug: "name",
					expectedType: "string",
					required: true,
					exists: true,
					valid: false,
				},
				{
					slug: "description",
					expectedType: "text",
					required: false,
					exists: true,
					valid: true,
				},
				{
					slug: "image",
					expectedType: "image",
					required: false,
					exists: false,
					valid: false,
				},
				{
					slug: "price",
					expectedType: "number",
					required: true,
					actualType: "string",
					exists: true,
					valid: false,
				},
				{
					slug: "currency",
					expectedType: "select",
					required: true,
					exists: true,
					valid: false,
				},
				{
					slug: "sku",
					expectedType: "string",
					required: false,
					exists: false,
					valid: false,
				},
				{
					slug: "active",
					expectedType: "boolean",
					required: false,
					exists: false,
					valid: false,
				},
			],
		});
	});

	it("accepts a valid Products collection schema", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Product Name", type: "string", required: true },
				{ slug: "description", label: "Description", type: "text" },
				{ slug: "image", label: "Product Image", type: "image" },
				{ slug: "price", label: "Price", type: "number", required: true },
				{
					slug: "currency",
					label: "Currency",
					type: "select",
					required: true,
					validation: {
						options: ["USD", "CAD", "EUR", "GBP"],
					},
				},
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		const result = await host.transport.invokeRoute(
			"checkProductSchema",
		);

		expect(result).toMatchObject({
			ok: true,
			collectionExists: true,
		});
	});
});

describe("admin route", () => {
	it("shows Products collection setup guidance on a fresh install", async () => {
			host = await createPluginRuntimeTestHost();

			const result = await host.transport.invokeRoute(
					"admin",
			);

			expect(result).toMatchObject({
					blocks: expect.any(Array),
			});

			const output = JSON.stringify(result);

			// Fresh installs should display onboarding guidance.
			expect(output).toContain("Stripe Setup");
			expect(output).toContain("Connect Stripe");
			expect(output).toContain("Enable Webhooks");
			expect(output).toContain("Configure Products");

			// Product setup should use the new accordion.
			expect(output).toContain(
					"Product Content Type Setup Instructions",
			);

			expect(output).toContain(
					'Create or configure a Content Type with the slug \\"products\\".',
			);

			// Verify the structured field table.
			const accordion = (result as any).blocks.find(
					(block: any) =>
							block.type === "accordion" &&
							block.label === "Product Content Type Setup Instructions",
			);

			expect(accordion).toBeDefined();

			const fieldTable = accordion.blocks.find(
					(block: any) =>
							block.type === "table" &&
							block.block_id === "stripe-product-setup-fields",
			);

			expect(fieldTable).toBeDefined();

			expect(fieldTable.rows).toEqual(
					expect.arrayContaining([
							{
									name: "Name",
									slug: "name",
									type: "String",
									required: "Yes",
							},
							{
									name: "Price",
									slug: "price",
									type: "Number",
									required: "Yes",
							},
							{
									name: "Currency",
									slug: "currency",
									type: "Select",
									required: "Yes",
							},
					]),
			);

			expect(output).toContain("USD, CAD, EUR, and GBP");
	});

	it("shows that Products are ready when the schema is valid", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.collection({
			slug: "products",
			label: "Products",
			fields: [
				{ slug: "name", label: "Product Name", type: "string", required: true },
				{ slug: "description", label: "Description", type: "text" },
				{ slug: "image", label: "Product Image", type: "image" },
				{ slug: "price", label: "Price", type: "number", required: true },
				{
					slug: "currency",
					label: "Currency",
					type: "select",
					required: true,
					validation: {
						options: ["USD", "CAD", "EUR", "GBP"],
					},
				},
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		const result = await host.transport.invokeRoute(
			"admin",
		);

		expect(JSON.stringify(result)).toContain(
			'"label":"Products","value":"Ready"',
		);
	});

	it("displays details for a selected order", async () => {
		host = await createPluginRuntimeTestHost();

		const orderId = "order_test_12345678";

		await host.fixtures.plugin.storage("orders", orderId, {
			id: orderId,
			stripeSessionId: "cs_test_order_123",
			productId: "product_test_123",
			quantity: 1,
			amountTotal: 2500,
			currency: "usd",
			paymentStatus: "paid",
			customerEmail: "customer@example.com",
			createdAt: "2026-10-15T12:00:00.000Z",
			updatedAt: "2026-10-15T12:00:00.000Z",
			paidAt: "2026-10-15T12:00:00.000Z",
		});

		const result = await host.transport.invokeRoute("admin", {
			type: "block_action",
			action_id: "stripe-order-details",
			value: orderId,
		});

		const output = JSON.stringify(result);

		expect(output).toContain("customer@example.com");
		expect(output).toContain("25.00 USD");
		expect(output).toContain("cs_test_order_123");
		expect(output).toContain('"label":"Payment Status","value":"Paid"');
		expect(output).toContain("Back to Orders");
	});

	it("handles an order that does not exist", async () => {
		host = await createPluginRuntimeTestHost();

		const result = await host.transport.invokeRoute("admin", {
			type: "block_action",
			action_id: "stripe-order-details",
			value: "order_does_not_exist",
		});

		const output = JSON.stringify(result);

		expect(output).toContain("Order Not Found");
		expect(output).toContain(
			"The requested order could not be found."
		);
		expect(output).toContain("Back to Orders");
	});

	it("returns to the Orders dashboard", async () => {
			host = await createPluginRuntimeTestHost();

			const result = await host.transport.invokeRoute("admin", {
					type: "block_action",
					action_id: "stripe-orders-back",
			});

			const output = JSON.stringify(result);

			// Verify the Orders dashboard is displayed.
			expect(output).toContain("Orders");

			// Verify the updated product setup guidance remains available.
			expect(output).toContain(
					"Product Content Type Setup Instructions",
			);

			expect(output).toContain(
					'Create or configure a Content Type with the slug \\"products\\".',
			);
	});
});

describe("testStripeConnection route", () => {
	it("rejects the connection test when the Stripe Secret Key is missing", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.kv(
			"state:stripe-connection",
			{
				mode: "test",
				accountId: "acct_old_123",
				verifiedAt: "2026-10-05T19:00:00.000Z",
			},
		);

		const result = await host.transport.invokeRoute(
			"testStripeConnection",
		);

		expect(result).toEqual({
			ok: false,
			error: "Stripe Secret Key is not configured.",
		});

		const savedConnection = await host.inspect.kv.get(
			"state:stripe-connection",
		);

		expect(savedConnection).toBeNull();
	});

	it("connects to Stripe and returns the account details", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

		await host.http.respond(
			STRIPE_ACCOUNT_URL,
			new Response(
				JSON.stringify({
					id: "acct_test_123",
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		const result = await host.transport.invokeRoute(
			"testStripeConnection",
		);

		expect(result).toEqual({
			ok: true,
			mode: "test",
			accountId: "acct_test_123",
		});

		const savedConnection = await host.inspect.kv.get<{
			mode: "test" | "live";
			accountId: string;
			verifiedAt: string;
		}>("state:stripe-connection");

		expect(savedConnection).toMatchObject({
			mode: "test",
			accountId: "acct_test_123",
		});

		expect(savedConnection?.verifiedAt).toBeTruthy();

		const requests = host.http.requests();

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(STRIPE_ACCOUNT_URL);
		expect(requests[0]?.method).toBe("GET");
	});

	it("handles an invalid Stripe Secret Key", async () => {
		host = await createPluginRuntimeTestHost();
		await host.fixtures.plugin.kv(
			"state:stripe-connection",
				{
					mode: "test",
					accountId: "acct_old_123",
					verifiedAt: "2026-10-05T19:00:00.000Z",
				},
		);

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_invalid",
		);

		await host.http.respond(
			STRIPE_ACCOUNT_URL,
			new Response(
				JSON.stringify({
					error: {
						message: "Invalid API Key provided",
					},
				}),
				{
					status: 401,
					headers: {
						"Content-Type": "application/json",
					},
				},
			),
		);

		const result = await host.transport.invokeRoute(
			"testStripeConnection",
		);

		expect(result).toEqual({
			ok: false,
			error: "Invalid API Key provided",
		});
	});

});


describe("getStorefrontConfig route", () => {
    it("returns the default Product Content Type slug", async () => {
        host = await createPluginRuntimeTestHost();

        const result = await host.transport.invokeRoute(
            "getStorefrontConfig",
        );

        expect(result).toEqual({
            productContentTypeSlug: "products",
        });
    });

    it("returns the configured Product Content Type slug", async () => {
        host = await createPluginRuntimeTestHost();

        await host.fixtures.plugin.setting(
            "productContentTypeSlug",
            "ecommerceaveproducts",
        );

        const result = await host.transport.invokeRoute(
            "getStorefrontConfig",
        );

        expect(result).toEqual({
            productContentTypeSlug: "ecommerceaveproducts",
        });
    });
});