
import type { PluginContext } from "emdash/plugin";

export type StripeCheckoutSession = {
    id?: string;
    url?: string;
    payment_status?: string;
    payment_intent?: string | null;
    client_reference_id?: string;
    amount_total?: number | null;
    currency?: string | null;
    customer_details?: {
        email?: string | null;
    };
    error?: {
        message?: string;
    };
};

type CreateStripeSessionInput = {
    stripeSecretKey: string;
    productId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    checkoutAttemptId?: string;
};

type StripeSessionResult =
    | {
          ok: true;
          session: StripeCheckoutSession;
      }
    | {
          ok: false;
          error: string;
      };

export async function createStripeSession(
    ctx: PluginContext,
    input: CreateStripeSessionInput,
): Promise<StripeSessionResult> {
    const {
        stripeSecretKey,
        productId,
        priceId,
        successUrl,
        cancelUrl,
        checkoutAttemptId,
    } = input;

    const body = new URLSearchParams();

    body.set("mode", "payment");
    body.set("client_reference_id", productId);
    body.set("line_items[0][price]", priceId);
    body.set("line_items[0][quantity]", "1");
    body.set("success_url", successUrl);
    body.set("cancel_url", cancelUrl);

    let idempotencyKey: string | undefined;

    if (checkoutAttemptId) {
        const keyData = JSON.stringify({
            checkoutAttemptId,
            productId,
            priceId,
            body: body.toString(),
        });

        const hashBuffer = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(keyData),
        );

        const hash = Array.from(new Uint8Array(hashBuffer))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");

        idempotencyKey = `checkout_${hash}`;
    }

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
                ...(idempotencyKey
                    ? {
                          "Idempotency-Key": idempotencyKey,
                      }
                    : {}),
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

    return {
        ok: true,
        session: stripeResponse,
    };
}
