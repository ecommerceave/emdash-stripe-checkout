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

		expect(body).toContain("success_url=");
		expect(body).toContain("cancel_url=");

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
});