# EmDash Products Setup Helper

This directory contains development utilities for the
eCommerce Ave Stripe Checkout plugin.

## Products Collection Setup

`setup-products.js` creates and validates the collection
and fields required by Stripe Checkout.

### Required Fields

| Field | Type | Required |
|---|---|---|
| Name | string | Yes |
| Description | text | No |
| Image | image | No |
| Price | number | Yes |
| Currency | select | Yes |
| SKU | string | No |
| Active | boolean | No |

Supported currencies: USD, CAD, EUR, GBP.

## Running the Helper

This is currently a development utility, not a
customer-facing installer.

1. Start an EmDash installation.
2. Sign in as an administrator with `schema:manage` permission.
3. Open the EmDash administration interface.
4. Open the browser Developer Console.
5. Review and copy the contents of `setup-products.js`.
6. Paste the script into the Console and execute it.

The helper uses the authenticated administrator session
and EmDash's schema API.

## Safety

- Existing fields are not overwritten.
- Missing fields are created automatically.
- Existing field types and required settings are checked.
- Currency defaults and dropdown options are validated.
- The helper can be executed repeatedly without duplicating fields.
- Schema changes require administrator authorization.

## Development Status

The helper currently targets the temporary
`ecommerceaveproducts` collection.

It must not be used as a production Products installer
until the target collection, validation, and administrator
setup experience have been finalized.

The Stripe Checkout plugin itself does not require
additional schema-management permissions.