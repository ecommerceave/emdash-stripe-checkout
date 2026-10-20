
# Stripe Checkout — Storefront Integration

The EmDash Stripe Checkout plugin provides reusable helpers for integrating Stripe Checkout into custom storefronts built with EmDash.

These helpers allow developers to create checkout sessions, connect Buy Now buttons, and verify successful payments.

## Requirements

- EmDash with the Stripe Checkout plugin installed and configured.
- A published product in the configured Product Content Type.
- A storefront page with access to the product's content entry ID.
- The API base URL of the active Stripe Checkout plugin installation.

## Importing the Helpers

```ts
import {
  startCheckout,
  initializeCheckoutButtons,
  verifyCheckout,
} from "emdash-stripe-checkout/storefront";
```

## 1. Creating a Checkout Session

Use `startCheckout()` to create a Stripe Checkout session.

```ts
const checkoutUrl = await startCheckout({
  apiBase: "/_emdash/api/plugins/YOUR_PLUGIN_ID",
  productId: "YOUR_PRODUCT_ID",
  returnPath: "/products/example-product",
});

window.location.assign(checkoutUrl);
```

The helper returns the Stripe Checkout URL.

Replace `YOUR_PLUGIN_ID` with the active plugin installation ID and `YOUR_PRODUCT_ID` with the EmDash product entry ID.

## 2. Adding a Buy Now Button

Add the following HTML to your product page:

```html
<button
  type="button"
  data-stripe-checkout
  data-product-id="YOUR_PRODUCT_ID"
  data-checkout-api="/_emdash/api/plugins/YOUR_PLUGIN_ID"
>
  Buy Now
</button>
```

Initialize the checkout buttons using client-side JavaScript:

```ts
import { initializeCheckoutButtons } from "emdash-stripe-checkout/storefront";

initializeCheckoutButtons();
```

The helper automatically:

- Finds buttons using the `data-stripe-checkout` attribute.
- Reads the product ID and plugin API URL.
- Creates a Stripe Checkout session.
- Redirects the customer to Stripe Checkout.
- Temporarily disables the button while processing.
- Restores the button if checkout initialization fails.

## 3. Verifying a Completed Payment

After the customer returns from Stripe Checkout, use `verifyCheckout()` to confirm the payment.

```ts
import { verifyCheckout } from "emdash-stripe-checkout/storefront";

const verified = await verifyCheckout({
  apiBase: "/_emdash/api/plugins/YOUR_PLUGIN_ID",
  sessionId: "STRIPE_CHECKOUT_SESSION_ID",
  productId: "YOUR_PRODUCT_ID",
});

if (verified) {
  console.log("Payment verified successfully.");
} else {
  console.log("Payment could not be verified.");
}
```

Do not display a successful payment message solely because the customer returned to your website. Verify the checkout session first.

## 4. Resolving the Plugin API URL

The Stripe Checkout plugin may have different installation IDs depending on how it was installed.

For example, local development and marketplace installations may use different IDs.

The API URL follows this structure:

```text
/_emdash/api/plugins/{PLUGIN_INSTALLATION_ID}
```

Resolve the active plugin installation ID from EmDash rather than hardcoding a marketplace-specific ID.

## 5. Product Content Types

Stripe Checkout supports configurable Product Content Types.

The default Content Type slug is:

```text
products
```

Developers can configure a different slug through the plugin's **Product Content Type** setting.

Your storefront must query the same Content Type configured in Stripe Checkout.

## Important Notes

- Keep Stripe secret keys on the server.
- Never expose Stripe secret keys in storefront JavaScript.
- Use the plugin's API routes to create and verify checkout sessions.
- Verify payments before displaying confirmation messages.
- Stripe webhooks and server-side order records should remain the authoritative source for payment and fulfillment status.
