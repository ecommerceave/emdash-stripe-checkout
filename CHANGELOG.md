
# Changelog

All notable changes to Stripe Checkout for EmDash are documented in this file.

This changelog begins with the first stable release, v1.0.0. Earlier versions were development releases and are not individually documented here.

## [Unreleased]

### Added

- Stripe Checkout integration for EmDash CMS.
- Support for Stripe test mode and live mode.
- Stripe connection testing from the plugin administration interface.
- Product management through configurable EmDash content types.
- Automatic synchronization of published products with Stripe.
- Creation and updating of Stripe products and prices.
- Support for USD, CAD, EUR, and GBP currencies.
- Stripe-hosted checkout session creation.
- Checkout session payment-status verification.
- Stripe webhook handling for payment and refund updates.
- Order management and order details within the EmDash administration interface.
- Product collection validation and configuration guidance.
- Public storefront configuration endpoint.
- Storefront integration utilities for custom Astro websites.
- Installation through the EmDash Plugin Registry.
- Automated TypeScript validation, tests, and production builds through GitHub Actions.
- GitHub Actions release workflow with signed build provenance generation.
- Maintainer release documentation.

### Security

- Stripe secret keys are configured through the plugin administration interface.
- Stripe webhook signature verification.
- EmDash sandboxed plugin execution.
- Release workflow configured to generate signed build provenance.

### Documentation

- Plugin installation and configuration instructions.
- Stripe webhook setup instructions.
- Product synchronization and storefront integration guidance.
- Dedicated release guide covering versioning, validation, publication, and verification.

<!--
Release preparation:
Replace [Unreleased] with [1.0.0] - YYYY-MM-DD when the
release is finalized. Do not assign a release date before
publication is confirmed.
-->
