import type { PluginContext } from "emdash/plugin";

export type StripeRefund = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  created: number;
  payment_intent: string | null;
  failure_reason?: string | null;
};

type StripeRefundListResponse = {
  data?: StripeRefund[];
  has_more?: boolean;
  error?: {
    message?: string;
  };
};

/**
 * Retrieve refunds associated with a Stripe PaymentIntent.
 *
 * Read-only: this function never creates or modifies refunds.
 */
export async function listStripeRefunds(
  ctx: PluginContext,
  paymentIntentId: string,
): Promise<StripeRefund[]> {
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

  const refunds: StripeRefund[] = [];
  let startingAfter: string | undefined;

  do {
    const url = new URL("https://api.stripe.com/v1/refunds");

    url.searchParams.set("payment_intent", paymentIntentId);
    url.searchParams.set("limit", "100");

    if (startingAfter) {
      url.searchParams.set("starting_after", startingAfter);
    }

    const response = await ctx.http.fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
      },
    });

    const data =
      (await response.json()) as StripeRefundListResponse;

    if (!response.ok) {
      throw new Error(
        data.error?.message ?? "Unable to retrieve Stripe refunds.",
      );
    }

    if (!Array.isArray(data.data)) {
      throw new Error("Invalid Stripe refund response.");
    }

    refunds.push(...data.data);

    if (!data.has_more) {
      break;
    }

    const lastRefund = data.data.at(-1);

    if (!lastRefund?.id) {
      throw new Error("Stripe refund pagination failed.");
    }

    startingAfter = lastRefund.id;
  } while (true);

  return refunds;
}