import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";

import {
  getStripePaymentIntent,
  createStripeRefund,
  getStripeRefund,
  listStripeRefunds,
} from "../src/refunds/stripe.js";

type StripeContext = Pick<PluginContext, "settings" | "http">;

function createContext(fetchMock: ReturnType<typeof vi.fn>): StripeContext {
  return {
    settings: {
      get: vi.fn().mockResolvedValue("sk_test_example"),
    },
    http: {
      fetch: fetchMock,
    },
  } as unknown as StripeContext;
}

describe("Stripe refunds", () => {
  it("retrieves a PaymentIntent from a Checkout Session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "cs_test_123",
          payment_intent: "pi_test_123",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const ctx = createContext(fetchMock);

    const paymentIntent = await getStripePaymentIntent(
      ctx,
      "cs_test_123",
    );

    expect(paymentIntent).toBe("pi_test_123");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/checkout/sessions/cs_test_123",
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer sk_test_example",
        },
      }),
    );
  });

  it("creates a full refund with an idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "re_test_123",
          status: "succeeded",
        }),
        { status: 200 },
      ),
    );

    const ctx = createContext(fetchMock);

    const refund = await createStripeRefund(
      ctx,
      "pi_test_123",
      "cs_test_123",
    );

    expect(refund.id).toBe("re_test_123");
    expect(refund.status).toBe("succeeded");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/refunds",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer sk_test_example",
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": "emdash-refund-cs_test_123",
        },
        body: "payment_intent=pi_test_123",
      }),
    );
  });

  it("handles Stripe refund API errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "Charge has already been refunded.",
          },
        }),
        { status: 400 },
      ),
    );

    const ctx = createContext(fetchMock);

    await expect(
      createStripeRefund(ctx, "pi_test_123", "cs_test_123"),
    ).rejects.toThrow("Charge has already been refunded.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects refunds when the Stripe Secret Key is missing", async () => {
    const fetchMock = vi.fn();

    const ctx = {
      settings: {
        get: vi.fn().mockResolvedValue(null),
      },
      http: {
        fetch: fetchMock,
      },
    } as unknown as StripeContext;

    await expect(
      createStripeRefund(ctx, "pi_test_123", "cs_test_123"),
    ).rejects.toThrow("Stripe Secret Key is not configured.");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retrieves an existing Stripe refund without creating a new one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "re_test_123",
          status: "succeeded",
        }),
        { status: 200 },
      ),
    );

    const ctx = createContext(fetchMock);

    const refund = await getStripeRefund(ctx, "re_test_123");

    expect(refund.id).toBe("re_test_123");
    expect(refund.status).toBe("succeeded");

    expect(fetchMock).toHaveBeenCalledOnce();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/refunds/re_test_123",
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer sk_test_example",
        },
      }),
    );
  });

  describe("listStripeRefunds", () => {
    it("retrieves existing refunds for a PaymentIntent", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            object: "list",
            data: [
                {
                    id: "re_test_123",
                    status: "succeeded",
                    amount: 2500,
                    currency: "usd",
                    payment_intent: "pi_test_123",
                },
            ],
            has_more: false,
          }),
          { status: 200 },
        ),
      );

      const ctx = createContext(fetchMock);

      const result = await listStripeRefunds(ctx, "pi_test_123");

      expect(result.data).toHaveLength(1);
      expect(result.data?.[0].id).toBe("re_test_123");
      expect(result.data?.[0].status).toBe("succeeded");
      expect(result.has_more).toBe(false);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.stripe.com/v1/refunds?payment_intent=pi_test_123&limit=100",
        expect.objectContaining({
          method: "GET",
          headers: {
            Authorization: "Bearer sk_test_example",
          },
        }),
      );

      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("rejects refunds with a missing amount", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
            JSON.stringify({
                object: "list",
                data: [
                {
                    id: "re_test_123",
                    status: "succeeded",
                    currency: "usd",
                    payment_intent: "pi_test_123",
                },
                ],
                has_more: false,
            }),
            { status: 200 },
            ),
        );

        await expect(
            listStripeRefunds(
            createContext(fetchMock),
            "pi_test_123",
            ),
        ).rejects.toThrow(
            "Stripe returned a refund with an invalid amount or currency.",
        );
    });

    it("handles an empty refund list", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            object: "list",
            data: [],
            has_more: false,
          }),
          { status: 200 },
        ),
      );

      const result = await listStripeRefunds(
        createContext(fetchMock),
        "pi_test_123",
      );

      expect(result.data).toEqual([]);
      expect(result.has_more).toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("reports when additional refund pages exist", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            object: "list",
            data: [
                {
                    id: "re_test_123",
                    status: "pending",
                    amount: 2500,
                    currency: "usd",
                    payment_intent: "pi_test_123",
                },
            ],
            has_more: true,
          }),
          { status: 200 },
        ),
      );

      const result = await listStripeRefunds(
        createContext(fetchMock),
        "pi_test_123",
      );

      expect(result.has_more).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it("rejects invalid Stripe refund list responses", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "re_test_123",
                status: "succeeded",
                payment_intent: "pi_different",
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        ),
      );

      await expect(
        listStripeRefunds(
          createContext(fetchMock),
          "pi_test_123",
        ),
      ).rejects.toThrow(
        "Stripe returned a refund that does not match the PaymentIntent.",
      );
    });

    it("handles Stripe API errors", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "Invalid API Key provided.",
            },
          }),
          { status: 401 },
        ),
      );

      await expect(
        listStripeRefunds(
          createContext(fetchMock),
          "pi_test_123",
        ),
      ).rejects.toThrow("Invalid API Key provided.");

      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});