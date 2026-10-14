import { describe, expect, it } from "vitest";
import { verifyStripeWebhookSignature } from "../src/stripe/webhooks.js";

describe("Stripe webhook signature verification", () => {
    it("accepts a valid Stripe signature", async () => {
        const secret = "whsec_test_secret";
        const payload = new TextEncoder().encode(
            JSON.stringify({
                id: "evt_test_123",
                type: "checkout.session.completed",
            })
        );

        const timestamp = Math.floor(Date.now() / 1000);
        const signedPayload = new TextEncoder().encode(
            `${timestamp}.${new TextDecoder().decode(payload)}`
        );

        const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );

        const signature = await crypto.subtle.sign(
            "HMAC",
            key,
            signedPayload
        );

        const hexSignature = Array.from(new Uint8Array(signature))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");

        const signatureHeader = `t=${timestamp},v1=${hexSignature}`;

        const result = await verifyStripeWebhookSignature(
            payload,
            signatureHeader,
            secret
        );

        expect(result).toBe(true);
    });

    it("rejects an invalid Stripe signature", async () => {
        const secret = "whsec_test_secret";

        const payload = new TextEncoder().encode(
            JSON.stringify({
                id: "evt_test_123",
                type: "checkout.session.completed",
            })
        );

        const timestamp = Math.floor(Date.now() / 1000);

        const signatureHeader = `t=${timestamp},v1=${"0".repeat(64)}`;

        const result = await verifyStripeWebhookSignature(
            payload,
            signatureHeader,
            secret
        );

        expect(result).toBe(false);
    });

    it("rejects an expired Stripe signature", async () => {
        const secret = "whsec_test_secret";

        const payload = new TextEncoder().encode(
            JSON.stringify({
                id: "evt_test_123",
                type: "checkout.session.completed",
            })
        );

        // Ten minutes ago
        const timestamp = Math.floor(Date.now() / 1000) - 600;

        const signedPayload = new TextEncoder().encode(
            `${timestamp}.${new TextDecoder().decode(payload)}`
        );

        const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );

        const signature = await crypto.subtle.sign(
            "HMAC",
            key,
            signedPayload
        );

        const hexSignature = Array.from(new Uint8Array(signature))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");

        const result = await verifyStripeWebhookSignature(
            payload,
            `t=${timestamp},v1=${hexSignature}`,
            secret
        );

        expect(result).toBe(false);
    });

    it("rejects a modified webhook payload", async () => {
        const secret = "whsec_test_secret";
        const timestamp = Math.floor(Date.now() / 1000);

        const originalPayload = new TextEncoder().encode(
            JSON.stringify({
                id: "evt_test_123",
                type: "checkout.session.completed",
                amount_total: 2500,
            })
        );

        const modifiedPayload = new TextEncoder().encode(
            JSON.stringify({
                id: "evt_test_123",
                type: "checkout.session.completed",
                amount_total: 100,
            })
        );

        const prefix = new TextEncoder().encode(`${timestamp}.`);
        const signedPayload = new Uint8Array(
            prefix.length + originalPayload.length
        );

        signedPayload.set(prefix);
        signedPayload.set(originalPayload, prefix.length);

        const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );

        const signature = await crypto.subtle.sign(
            "HMAC",
            key,
            signedPayload
        );

        const hexSignature = Array.from(new Uint8Array(signature))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");

        const result = await verifyStripeWebhookSignature(
            modifiedPayload,
            `t=${timestamp},v1=${hexSignature}`,
            secret
        );

        expect(result).toBe(false);
    });
});