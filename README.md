# Stripe Checkout for EmDash

A lightweight Stripe Checkout integration for [EmDash CMS](https://emdashcms.com), developed by [eCommerce Ave](https://ecommerceave.com).

Stripe Checkout allows EmDash users to sell products through Stripe's hosted checkout experience without needing a full eCommerce platform.

## Features

- Connect an existing Stripe account using a Stripe Secret Key.
- Support Stripe test mode and live mode.
- Manage products directly within EmDash CMS.
- Automatically synchronize published products with Stripe.
- Create and update Stripe products and prices.
- Support USD, CAD, EUR, and GBP currencies.
- Generate Stripe-hosted checkout sessions.
- Verify checkout session payment status.
- Validate the required Products collection structure.

## Installation

Stripe Checkout is available through the EmDash Plugin Registry.

### Install from the Plugin Registry

1. Open your EmDash administration dashboard.
2. Navigate to **Plugins**.
3. Find **Stripe Checkout** by eCommerce Ave in the plugin registry.
4. Install and enable the plugin.
5. Open the Stripe Checkout plugin settings.
6. Enter your Stripe Secret Key.
7. Click **Test Stripe Connection** to verify your connection.

**Plugin Registry:** https://plugins.emdashcms.com/plugins/@ecommerceave.com/emdash-stripe-checkout

No manual changes to `astro.config.mjs` are required when installing through the registry.

### Local Development Installation

The following instructions are intended for developers working with a local copy of Stripe Checkout. If you installed the plugin through the EmDash Plugin Registry, you can skip this section.

Open your EmDash site's `astro.config.mjs` file.

Import the plugin:

```js
import stripeCheckout from "emdash-stripe-checkout";
```

Register it inside your existing EmDash integration:

```js
emdash({
    // Your existing EmDash configuration
    sandboxed: [
        stripeCheckout,
    ],
})
```

### Stripe Configuration

You will need a Stripe account to accept payments.

1. Sign in to your [Stripe Dashboard](https://dashboard.stripe.com/).
2. Navigate to **Developers → API keys**.
3. Copy your Stripe Secret Key.
4. Add the key to the Stripe Checkout plugin settings in EmDash.

Use a Stripe test-mode secret key (`sk_test_`) while testing.

When you're ready to accept real payments, configure your live-mode secret key (`sk_live_`).

**Security:** Never expose your Stripe Secret Key in frontend code or commit it to GitHub.

## Products Collection Setup

Stripe Checkout requires a Products collection in EmDash.

### Create the Collection

1. Open your EmDash administration dashboard.
2. Navigate to **Content Types**.
3. Create a new collection with:
   - Name: Products
   - Slug: products
4. Add the fields listed below.

### Required Collection Fields

| Field | Slug | Type | Required |
|-------|------|------|----------|
| Name | name | String | Yes |
| Description | description | Text | No |
| Image | image | Image | No |
| Price | price | Number | Yes |
| Currency | currency | Select | Yes |
| SKU | sku | String | No |
| Active | active | Boolean | No |

### Currency Configuration

Configure the Currency select field with:

- Options: USD, CAD, EUR, GBP
- Default value: USD

Save the collection when finished.

### Verify Your Setup

1. Navigate to **Plugins → Stripe Checkout**.
2. Confirm **Products Collection** displays **Found**.
3. Confirm **Product Schema** displays **Valid**.
4. Look for the message **Products are ready to use.**

Once validated, you can create products in EmDash. Publishing a product automatically synchronizes it with Stripe.

## How Stripe Checkout Works

Stripe Checkout uses Stripe's hosted payment pages to process customer payments.

### Product Synchronization

1. Create a product in your EmDash Products collection.
2. Enter the product name, description, price, and currency.
3. Publish the product.
4. Stripe Checkout automatically creates the corresponding product and price in Stripe.
5. When an existing product's price changes, the plugin creates a new Stripe Price.

### Integrating a Buy Now Button

The examples below use the registry ID for the official eCommerce Ave Stripe Checkout plugin (`@ecommerceave.com/emdash-stripe-checkout`).

EmDash generates this ID deterministically from the plugin's publisher DID and slug. It remains consistent across installations using the same registry identity and ID-generation algorithm.

If you are developing with a locally registered version of the plugin, your plugin ID may differ. Update the API endpoint accordingly.

Stripe Checkout provides a public API endpoint that allows an EmDash website to create a Stripe-hosted checkout session.

**Endpoint:**

`/_emdash/api/plugins/r_2gmaxm63r5xhxist/createCheckoutSession`

**Method:** `POST`

**Request body:**

```json
{
  "productId": "YOUR_EMDASH_PRODUCT_ID",
  "returnPath": "/products/example-product"
}
```

**Example JavaScript:**

```javascript
async function startCheckout(productId) {
  const response = await fetch(
    "/_emdash/api/plugins/r_2gmaxm63r5xhxist/createCheckoutSession",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        productId,
        returnPath: window.location.pathname,
      }),
    }
  );

  const result = await response.json();

  if (!result.success || !result.data?.checkoutUrl) {
    throw new Error(
      result.data?.error || result.error?.message || "Unable to start checkout."
    );
  }

  window.location.href = result.data.checkoutUrl;
}
```

Call `startCheckout(productId)` when the customer clicks a Buy Now button.

The plugin creates a Stripe Checkout session and returns a hosted checkout URL.

**Important:** Use the EmDash product's internal ID, not its slug or SKU. The product must be published, active, and synchronized with Stripe.

### Verifying a Successful Payment

After checkout, Stripe redirects the customer back to your website.

**Important:** A successful redirect does not guarantee that payment was completed. Always verify the Checkout Session before displaying a payment confirmation.

**Endpoint:**

`/_emdash/api/plugins/r_2gmaxm63r5xhxist/verifyCheckoutSession`

**Method:** `POST`

**Request body:**

```json
{
  "sessionId": "cs_test_EXAMPLE_SESSION_ID",
  "productId": "YOUR_EMDASH_PRODUCT_ID"
}
```

**Example JavaScript:**

```javascript
async function verifyPayment(sessionId, productId) {
  const response = await fetch(
    "/_emdash/api/plugins/r_2gmaxm63r5xhxist/verifyCheckoutSession",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId,
        productId,
      }),
    }
  );

  const result = await response.json();

  if (result.success && result.data?.paid === true) {
    return true;
  }

  return false;
}
```

Call `verifyPayment(sessionId, productId)` after the customer returns from Stripe Checkout.

Only display a successful payment confirmation when the plugin confirms the payment.

**Production note:** Browser-side verification is useful for displaying payment status, but it should not be the sole mechanism for fulfilling orders or delivering digital products. Reliable fulfillment should use server-side verification and an appropriate webhook or reconciliation process.

### Customer Checkout

The plugin provides two checkout-related routes:

- `createCheckoutSession` — Creates a Stripe-hosted Checkout session for a product.
- `verifyCheckoutSession` — Verifies the payment status of a Stripe Checkout session.

A website frontend can use these routes to initiate checkout and verify the resulting payment.

**Note:** The plugin provides the checkout functionality, but a storefront or Buy button must be integrated separately.

### Testing Payments

Use Stripe test mode to verify your checkout integration before accepting live payments.

Test transactions do not charge real payment methods.

## Develop

```sh
pnpm install
pnpm run validate
pnpm run typecheck
pnpm run test
pnpm run build
```

To test against a running EmDash site, run `pnpm run dev` in this
directory (rebuilds on save) and `pnpm add file:../path/to/this`
in the site. Then `import emdashStripeCheckout from "emdash-stripe-checkout"` and pass
it into `emdash({ sandboxed: [emdashStripeCheckout] })`.

`pnpm run test` builds the plugin and runs its tests through Worker Loader using
EmDash's production sandbox wrapper and host bridge.

## Publish

```sh
pnpm run login -- ecommerceave.com
pnpm run publish
```

To publish from GitHub Actions, run `pnpm run release:setup`. The command
creates one shared workflow at the Git repository root.

## Version bumps

Bump `version` in `package.json` when you ship a release. The
scaffold's `emdash-plugin.jsonc` deliberately omits `version` —
the build pipeline reads it from `package.json` so there's a single
source of truth. **Bump major** for breaking changes, **bump minor**
for new routes or hooks, **bump patch** for fixes.

You MUST bump version whenever you change `capabilities`, `allowedHosts`,
or `storage` in the manifest. Installed users have consented to the
old trust contract; a change without a version bump would let new
behaviour slip past consent.
