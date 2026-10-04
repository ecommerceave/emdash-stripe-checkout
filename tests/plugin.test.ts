import { afterEach, describe, expect, it } from "vitest";

import {
	createPluginRuntimeTestHost,
	type PluginRuntimeTestHost,
} from "@emdash-cms/plugin-test";

const STRIPE_URL = "https://api.stripe.com/v1/checkout/sessions";

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

});