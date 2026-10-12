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

1. Install the Stripe Checkout plugin package in your EmDash project.
2. Register the plugin in your site's `astro.config.mjs` file using the instructions below.
3. Restart your EmDash application.
4. Open the EmDash administration dashboard.
5. Navigate to **Plugins → Stripe Checkout**.
6. Configure your Stripe Secret Key in the plugin settings.
7. Click **Test Stripe Connection** to verify your Stripe account.

### Register the Plugin

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
