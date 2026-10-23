
import { startCheckout } from "./checkout.js";

const checkoutAttempts = new WeakMap<HTMLButtonElement, string>();

export function initializeCheckoutButtons(
  root: ParentNode = document,
): void {
  const buttons = root.querySelectorAll<HTMLButtonElement>(
    "button[data-stripe-checkout]",
  );

  for (const button of buttons) {
    if (button.dataset.stripeCheckoutInitialized === "true") {
      continue;
    }

    button.dataset.stripeCheckoutInitialized = "true";

    button.addEventListener("click", async () => {
      const apiBase = button.dataset.checkoutApi;
      const productId = button.dataset.productId;

      if (!apiBase || !productId) {
        console.error("Missing Stripe Checkout API URL or product ID.");
        return;
      }

      const originalText = button.textContent ?? "Buy Now";

      let attemptId = checkoutAttempts.get(button);

      if (!attemptId) {
        attemptId = crypto.randomUUID();
        checkoutAttempts.set(button, attemptId);
      }

      button.disabled = true;
      button.textContent = "Loading...";

      try {
        // Preserve the selected product for payment verification
        // when Stripe redirects back to the storefront.
        const returnUrl = new URL(window.location.pathname, window.location.origin);
        returnUrl.searchParams.set("product_id", productId);

        const checkoutUrl = await startCheckout(
          {
            apiBase,
            productId,
            returnPath: `${returnUrl.pathname}${returnUrl.search}`,
          },
          attemptId,
        );

        window.location.assign(checkoutUrl);
      } catch (error) {
        console.error("Stripe Checkout error:", error);

        button.disabled = false;
        button.textContent = originalText;
      }
    });
  }
}
