export type VerifyCheckoutOptions = {
  apiBase: string;
  sessionId: string;
  productId: string;
};

type VerifyCheckoutResponse = {
  success: boolean;
  data?: {
    paid?: boolean;
  };
  error?: string | { message?: string };
};

export async function verifyCheckout(
  options: VerifyCheckoutOptions,
): Promise<boolean> {
  const { apiBase, sessionId, productId } = options;

  if (!apiBase || !sessionId || !productId) {
    throw new Error(
      "Checkout API URL, session ID, and product ID are required.",
    );
  }

  const response = await fetch(
    `${apiBase.replace(/\/$/, "")}/verifyCheckoutSession`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId,
        productId,
      }),
    },
  );

  const result = (await response.json()) as VerifyCheckoutResponse;

  if (!response.ok || !result.success) {
    const message =
      typeof result.error === "string"
        ? result.error
        : result.error?.message ?? "Unable to verify checkout.";

    throw new Error(message);
  }

  return result.data?.paid === true;
}
