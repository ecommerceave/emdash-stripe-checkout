import type { PluginContext } from "emdash/plugin";

type StripeContext = Pick<PluginContext, "settings" | "http">;

type StripeSession = {
  id: string;
  payment_intent?: string | null;
  error?: {
    message?: string;
  };
};

type StripeRefund = {
    id?: string;
    status?: string;
    amount?: number;
    currency?: string;
    payment_intent?: string | null;
    error?: {
    message?: string;
    };
};

type StripeRefundList = {
  object?: string;
  data?: StripeRefund[];
  has_more?: boolean;
  error?: {
    message?: string;
  };
};

export async function getStripePaymentIntent(
  ctx: StripeContext,
  stripeSessionId: string,
): Promise<string> {
  const stripeSecretKey =
    await ctx.settings.get<string>("stripeSecretKey");

  if (!stripeSecretKey) {
    throw new Error("Stripe Secret Key is not configured.");
  }

  if (!stripeSessionId.startsWith("cs_")) {
    throw new Error("Invalid Stripe Checkout Session ID.");
  }

  if (!ctx.http) {
    throw new Error("Network access is not available.");
  }

  const response = await ctx.http.fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(stripeSessionId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
      },
    },
  );

  const session = (await response.json()) as StripeSession;

  if (!response.ok) {
    throw new Error(
      session.error?.message ??
        "Unable to retrieve Stripe Checkout Session.",
    );
  }

  if (!session.payment_intent) {
    throw new Error(
      "Stripe Checkout Session does not have a PaymentIntent.",
    );
  }

  return session.payment_intent;
}

export async function createStripeRefund(
  ctx: StripeContext,
  paymentIntentId: string,
  orderId: string,
): Promise<StripeRefund> {
  const stripeSecretKey =
    await ctx.settings.get<string>("stripeSecretKey");

  if (!stripeSecretKey) {
    throw new Error("Stripe Secret Key is not configured.");
  }

  if (!paymentIntentId.startsWith("pi_")) {
    throw new Error("Invalid Stripe PaymentIntent ID.");
  }

  if (!orderId.startsWith("cs_")) {
    throw new Error("Invalid order ID.");
  }

  if (!ctx.http) {
    throw new Error("Network access is not available.");
  }

  const body = new URLSearchParams();
  body.set("payment_intent", paymentIntentId);

  const response = await ctx.http.fetch(
    "https://api.stripe.com/v1/refunds",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `emdash-refund-${orderId}`,
      },
      body: body.toString(),
    },
  );

  const refund = (await response.json()) as StripeRefund;

  if (!response.ok) {
    throw new Error(
      refund.error?.message ?? "Stripe refund request failed.",
    );
  }

  if (!refund.id || !refund.status) {
    throw new Error("Stripe returned an invalid refund response.");
  }

  return refund;
}

/**
 * Retrieve an existing Stripe refund by its ID.
 *
 * This is read-only and does not create another refund.
 */
export async function getStripeRefund(
  ctx: StripeContext,
  refundId: string,
): Promise<StripeRefund> {
  if (!refundId.startsWith("re_")) {
    throw new Error("Invalid Stripe refund ID.");
  }

  const stripeSecretKey =
    await ctx.settings.get<string>("stripeSecretKey");

  if (!stripeSecretKey) {
    throw new Error("Stripe Secret Key is not configured.");
  }

  if (!ctx.http) {
    throw new Error("Network access is not available.");
  }

  const response = await ctx.http.fetch(
    `https://api.stripe.com/v1/refunds/${encodeURIComponent(refundId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
      },
    },
  );

  const refund = (await response.json()) as StripeRefund;

  if (!response.ok) {
    throw new Error(
      refund.error?.message ??
        "Unable to retrieve Stripe refund.",
    );
  }

  if (refund.id !== refundId || !refund.status) {
    throw new Error("Stripe returned an invalid refund response.");
  }

  return refund;
}

/**
 * List existing refunds for a Stripe PaymentIntent.
 *
 * This is read-only. It does not initiate a refund.
 *
 * The result includes has_more so callers can detect
 * when Stripe has additional pages of refunds.
 */
export async function listStripeRefunds(
  ctx: StripeContext,
  paymentIntentId: string,
): Promise<StripeRefundList> {
  if (!paymentIntentId.startsWith("pi_")) {
    throw new Error("Invalid Stripe PaymentIntent ID.");
  }

  const stripeSecretKey =
    await ctx.settings.get<string>("stripeSecretKey");

  if (!stripeSecretKey) {
    throw new Error("Stripe Secret Key is not configured.");
  }

  if (!ctx.http) {
    throw new Error("Network access is not available.");
  }

  const params = new URLSearchParams();
  params.set("payment_intent", paymentIntentId);
  params.set("limit", "100");

  const response = await ctx.http.fetch(
    `https://api.stripe.com/v1/refunds?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
      },
    },
  );

  const refunds = (await response.json()) as StripeRefundList;

  if (!response.ok) {
    throw new Error(
      refunds.error?.message ??
        "Unable to retrieve Stripe refunds.",
    );
  }

  if (
    refunds.object !== "list" ||
    !Array.isArray(refunds.data) ||
    typeof refunds.has_more !== "boolean"
  ) {
    throw new Error("Stripe returned an invalid refund list.");
  }

  for (const refund of refunds.data) {
    if (
        !refund.id?.startsWith("re_") ||
        !refund.status ||
        refund.payment_intent !== paymentIntentId
    ) {
        throw new Error(
        "Stripe returned a refund that does not match the PaymentIntent.",
        );
    }

    if (
        typeof refund.amount !== "number" ||
        !Number.isSafeInteger(refund.amount) ||
        refund.amount <= 0 ||
        typeof refund.currency !== "string" ||
        !/^[a-z]{3}$/.test(refund.currency)
    ) {
        throw new Error(
        "Stripe returned a refund with an invalid amount or currency.",
        );
    }
}

  return refunds;
}