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

		await host.fixtures.plugin.setting("stripeSecretKey", "sk_test_example");

		await host.fixtures.plugin.kv("state:product:product_test_123", {
			stripeProductId: "prod_test_123",
			stripePriceId: "price_test_123",
			price: 25,
			currency: "usd",
		});

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

		const result = await host.transport.invokeRoute("createCheckoutSession", {
			productId: "product_test_123",
			returnPath: "/product-test",
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

	it("rejects an invalid checkout request", async () => {
		host = await createPluginRuntimeTestHost();

		const result = await host.transport.invokeRoute("createCheckoutSession", {
			productId: "",
		});

		expect(result).toEqual({
			ok: false,
			error: "Invalid checkout request.",
		});
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

});

describe("product sync", () => {
	it("creates a Stripe Product when a product is published", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

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
		expect(priceRequest?.headers["idempotency-key"]).toBe(
			"emdash-price-product_test_123-usd-2500",
		);

	});

	it("creates a new Stripe Price when the product price changes", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

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
		expect(newPriceRequest?.headers["idempotency-key"]).toBe(
			"emdash-price-product_test_123-usd-3000",
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

	it("keeps the old Stripe Price active when creating a new Price fails", async () => {
		host = await createPluginRuntimeTestHost();

		await host.fixtures.plugin.setting(
			"stripeSecretKey",
			"sk_test_example",
		);

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
					error: {
						message: "Unable to create Stripe Price",
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

		const deactivateOldPriceRequest = requests.find(
			(request) =>
				request.url ===
				"https://api.stripe.com/v1/prices/price_old_123",
		);

		expect(deactivateOldPriceRequest).toBeUndefined();

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
					valid: true,
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
				{ slug: "currency", label: "Currency", type: "select", required: true },
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

		expect(JSON.stringify(result)).toContain(
			"Stripe Checkout needs a Products collection before you can add products.",
		);

		expect(JSON.stringify(result)).toContain(
			"Product Name — name — string — required",
		);

		expect(JSON.stringify(result)).toContain(
			"Price — price — number — required",
		);

		expect(JSON.stringify(result)).toContain(
			"Currency — currency — select — required",
		);
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
				{ slug: "currency", label: "Currency", type: "select", required: true },
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "active", label: "Active", type: "boolean" },
			],
		});

		const result = await host.transport.invokeRoute(
			"admin",
		);

		expect(JSON.stringify(result)).toContain(
			"Products are ready to use.",
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