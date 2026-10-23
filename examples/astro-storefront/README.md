# Astro Storefront Examples

These examples demonstrate how to build a storefront using the Stripe Checkout plugin for EmDash.

They provide two approaches:

1. **Product listing with detail pages** — Customers browse products, open individual product pages, and purchase using Stripe Checkout.
2. **Direct checkout listing** — Customers purchase directly from a product listing using Buy Now buttons.

Both approaches use the same Stripe Checkout plugin and configured Product Content Type.

## Requirements

- An Astro-based EmDash website
- The Stripe Checkout plugin installed and active
- Stripe configured in the plugin settings
- A configured Product Content Type containing published, active products

These examples were developed against these dependency ranges:

- Astro ^7.3.2
- EmDash ^1.3.1

Compatibility with other versions has not yet been verified.

## Files

The example includes six source files:

- src/lib/format-currency.ts
- src/lib/stripe-checkout.ts
- src/lib/product-types.ts
- src/pages/products/index.astro
- src/pages/products/[slug].astro
- src/pages/products/direct-checkout/index.astro

## Installation

1. Install and configure the Stripe Checkout plugin in your EmDash website.
2. Copy the three shared helper files into your project's src/lib/ directory.
3. Copy the desired storefront pages into your project's src/pages/ directory.
4. Start your Astro development server.
5. Visit the storefront URLs listed below.

The examples use standalone HTML documents and do not require a custom Astro layout.

If your website already has a shared layout, you can adapt the templates to use it.

## Storefront URLs

### Product listing and detail pages

- /products/ — Product listing
- /products/[slug] — Individual product details and checkout

These pages work together.

### Direct checkout listing

- /products/direct-checkout/ — Product listing with Buy Now buttons

This approach allows customers to start checkout without visiting individual product pages.

You can use either approach or both.

## How Products Are Loaded

The examples retrieve the Product Content Type configured in the Stripe Checkout plugin.

The shared stripe-checkout.ts helper discovers the active plugin installation and requests its storefront configuration.

It supports:

- Locally configured plugin installations
- Marketplace-installed versions of the plugin

The helper currently reads EmDash's internal _plugin_state database table to discover the installation. This implementation dependency may require changes if future EmDash versions modify their internal plugin storage.

## Checkout and Payment Verification

The examples redirect customers to Stripe Checkout for payment.

After Stripe redirects the customer back to the storefront, the page calls the plugin's checkout verification endpoint before displaying a successful payment message.

A checkout success URL alone must not be treated as proof of payment.

For order fulfillment or other sensitive operations, use server-side payment confirmation rather than relying on browser messages.

## Customization

The templates include their own basic responsive styling.

You can customize:

- Product card layouts
- Typography and colors
- Product images
- Button labels
- Page titles and descriptions
- Storefront URLs

The standalone examples include a basic color-scheme setting. When integrating them into an existing website, adjust this to follow your site's theme.

## Additional Documentation

See docs/storefront-integration.md in the main repository for additional integration details and API information.
