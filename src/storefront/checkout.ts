export type CheckoutOptions = {
  apiBase: string;
  productId: string;
  returnPath?: string;
};

type CheckoutResponse = {
  success: boolean;
  data?: {
    checkoutUrl?: string;
  };
  error?: string | { message?: string };
};

export async function startCheckout(
  options: CheckoutOptions,
  checkoutAttemptId: string = crypto.randomUUID(),
): Promise<string> {
  const { apiBase, productId, returnPath } = options;

  if (!apiBase || !productId) {
    throw new Error("Checkout API URL and product ID are required.");
  }

  const response = await fetch(
    `${apiBase.replace(/\/$/, "")}/createCheckoutSession`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        productId,
        returnPath: returnPath ?? window.location.pathname,
        checkoutAttemptId,
      }),
    },
  );

  const result = (await response.json()) as CheckoutResponse;

  if (!response.ok || !result.success || !result.data?.checkoutUrl) {
    const message =
      typeof result.error === "string"
        ? result.error
        : result.error?.message ?? "Unable to start checkout.";

    throw new Error(message);
  }

  return result.data.checkoutUrl;
}
