
import type { PluginContext } from "emdash/plugin";

import {
    blocks,
    elements,
    type BlockResponse,
} from "@emdash-cms/blocks/server";

import { listOrders } from "../orders/storage.js";
import { buildOrdersTable } from "./orders-table.js";
import { getProductContentTypeSlug } from "../products/content-type.js";

import {
    checkProductSchema,
    getProductSchemaGuidance,
} from "../products/schema.js";

import {
    STRIPE_CONNECTION_STATE_KEY,
    type StripeConnectionResult,
    type StripeConnectionState,
} from "../stripe/connection.js";

export type OrdersPaginationState = {
    page: number;
    cursor?: string;
    previousCursors: Array<string | undefined>;
};

export async function buildAdminPage(
    ctx: PluginContext,
    stripeConnection?: StripeConnectionResult,
    pagination: OrdersPaginationState = {
        page: 1,
        previousCursors: [],
    },
): Promise<BlockResponse> {
    const schema = await checkProductSchema(ctx);

    const { orders, cursor: nextCursor, hasMore } =
        await listOrders(ctx, pagination.cursor);

    // Stripe API credentials
    const stripeSecretKey =
        await ctx.settings.get<string>("stripeSecretKey");

    // Stripe webhook signing secret
    const stripeWebhookSecret =
        await ctx.settings.get<string>("stripeWebhookSecret");

    // Previously verified Stripe connection
    const savedConnection =
        await ctx.kv.get<StripeConnectionState>(
            STRIPE_CONNECTION_STATE_KEY,
        );

    const connection =
        stripeConnection ??
        (savedConnection
            ? {
                  ok: true,
                  mode: savedConnection.mode,
                  accountId: savedConnection.accountId,
                  verifiedAt: savedConnection.verifiedAt,
              }
            : undefined);

    // Determine whether onboarding guidance is needed.
    // A configured webhook secret does not necessarily mean
    // webhook delivery has been verified.
    const needsSetup =
        !stripeSecretKey ||
        !connection?.ok ||
        !stripeWebhookSecret ||
        !schema.ok;

    const webhookUrl = ctx.url(
        `/_emdash/api/plugins/${encodeURIComponent(ctx.plugin.id)}/stripeWebhook`,
    );

    return {
        blocks: [
            // Dashboard Header
            blocks.header("Stripe Checkout"),

            blocks.section(
                "Lightweight Stripe Checkout integration for EmDash.",
            ),

            // Setup Banner
            ...(needsSetup
                ? [
                      blocks.banner({
                          variant: "default",
                          title: "Stripe Setup",
                          description:
                              "Connect your Stripe account, enable webhooks, and configure your products to start accepting payments.",
                      }),
                  ]
                : []),


            // Guided Setup
            ...(needsSetup
                ? [
                      blocks.columns([
                          ...(!stripeSecretKey || !connection?.ok
                              ? [
                                    [
                                        blocks.header("Connect Stripe"),
                                        blocks.section(
                                            !stripeSecretKey
                                                ? "Add your Stripe Secret Key in plugin settings, then test your connection."
                                                : "Run a Stripe connection test to verify your credentials.",
                                        ),
                                    ],
                                ]
                              : []),

                          ...(!stripeWebhookSecret
                              ? [
                                    [
                                        blocks.header("Enable Webhooks"),
                                        blocks.section(
                                            "Create a webhook endpoint in Stripe using the URL below, then add its signing secret to plugin settings.",
                                        ),
                                    ],
                                ]
                              : []),

                          ...(!schema.ok
                              ? [
                                    [
                                        blocks.header("Configure Products"),
                                        blocks.section(
                                            "Configure your Product Content Type to enable product synchronization with Stripe.",
                                        ),
                                    ],
                                ]
                              : []),
                      ]),
                  ]
                : []),


            // Webhook Endpoint URL
            ...(needsSetup
                ? [
                      blocks.section("Stripe Webhook Endpoint"),
                      blocks.fields([
                          {
                              label: "Webhook URL",
                              value: webhookUrl,
                          },
                      ]),
                  ]
                : []),

            // Stripe Configuration Links
            blocks.actions([
                elements.link("Get Stripe API Keys", {
                    kind: "external",
                    url: "https://dashboard.stripe.com/apikeys",
                }),
                elements.link("Configure Stripe Webhooks", {
                    kind: "external",
                    url: "https://dashboard.stripe.com/webhooks",
                }),
                elements.link("Configure Plugin Settings", {
                    kind: "plugin-settings",
                }),
            ]),

            // Dashboard Overview
            blocks.stats([
                {
                    label: "Stripe Connection",
                    value: !stripeSecretKey
                        ? "Needs Setup"
                        : !connection
                          ? "Not Tested"
                          : connection.ok
                            ? "Connected"
                            : "Connection Failed",
                    description: !stripeSecretKey
                        ? "Configure your Stripe secret key"
                        : !connection
                          ? "Run a connection test"
                          : connection.ok
                            ? connection.mode === "test"
                                ? "Stripe Test Mode"
                                : "Stripe Live Mode"
                            : "Check your Stripe credentials",
                },
                {
                    label: "Webhooks",
                    value: stripeWebhookSecret
                        ? "Configured"
                        : "Needs Setup",
                    description: stripeWebhookSecret
                        ? "Signing secret saved; delivery not yet verified"
                        : "Add your Stripe webhook signing secret",
                },
                {
                    label: "Products",
                    value: schema.ok ? "Ready" : "Needs Attention",
                    description: schema.ok
                        ? "Product Content Type configured"
                        : "Product Content Type requires attention",
                },
                {
                    label: "Orders on This Page",
                    value: orders.length,
                    description: `Page ${pagination.page} of your orders`,
                },
            ]),



            // Product Schema Guidance
            ...(!schema.ok
                ? [
                      blocks.section(
                          "Your Product Content Type needs to be configured before products can synchronize with Stripe.",
                      ),
                      blocks.accordion({
                          label: "Product Content Type Setup Instructions",
                          defaultOpen: false,
                          blocks: [
                              blocks.section(
                                  `Create or configure a Content Type with the slug "${await getProductContentTypeSlug(ctx)}".`,
                              ),
                              blocks.table({
                                    blockId: "stripe-product-setup-fields",
                                    pageActionId: "stripe-product-setup-page",
                                  columns: [
                                      { key: "name", label: "Field", format: "text" },
                                      { key: "slug", label: "Slug", format: "code" },
                                      { key: "type", label: "Type", format: "text" },
                                      { key: "required", label: "Required", format: "text" },
                                  ],
                                  rows: [
                                      { name: "Name", slug: "name", type: "String", required: "Yes" },
                                      { name: "Description", slug: "description", type: "Text", required: "No" },
                                      { name: "Image", slug: "image", type: "Image", required: "No" },
                                      { name: "Price", slug: "price", type: "Number", required: "Yes" },
                                      { name: "Currency", slug: "currency", type: "Select", required: "Yes" },
                                      { name: "SKU", slug: "sku", type: "String", required: "No" },
                                      { name: "Active", slug: "active", type: "Boolean", required: "No" },
                                  ],
                              }),
                              blocks.section(
                                  "Currency field: Add USD, CAD, EUR, and GBP as Select options. Set USD as the default.",
                              ),
                              blocks.section(
                                  "Save the Content Type, then return to Stripe Checkout. The plugin will automatically detect the configuration.",
                              ),
                          ],
                      }),
                  ]
                : []),


            // Technical Connection Details
            blocks.accordion({
                label: "Stripe Connection Details",
                defaultOpen: false,
                blocks: [
                    blocks.fields([
                        {
                            label: "Stripe Account ID",
                            value:
                                connection?.ok && connection.accountId
                                    ? connection.accountId
                                    : "Unavailable",
                        },
                        {
                            label: "Last Verified",
                            value:
                                connection?.ok && savedConnection?.verifiedAt
                                    ? `${new Date(
                                          savedConnection.verifiedAt,
                                      ).toLocaleString(ctx.site.locale, {
                                          timeZone: "UTC",
                                      })} UTC`
                                    : "Never",
                        },
                    ]),

                    ...(!stripeSecretKey || !connection?.ok
                        ? [
                              blocks.section(
                                  !stripeSecretKey
                                      ? "Add your Stripe Secret Key in plugin settings."
                                      : !connection
                                        ? "Run a connection test to verify your Stripe credentials."
                                        : "error" in connection
                                          ? connection.error ??
                                            "Unable to connect to Stripe."
                                          : "Unable to connect to Stripe.",
                              ),
                          ]
                        : []),
                ],
            }),

            // Stripe Administrative Actions
            blocks.actions([
                elements.button(
                    "test-stripe-connection",
                    "Test Stripe Connection",
                    {
                        style: "secondary",
                    },
                ),
                elements.button(
                    "stripe-orders-sync",
                    "Sync Orders",
                    {
                        style: "secondary",
                    },
                ),
            ]),

            // Orders
            blocks.divider(),

            blocks.header("Orders"),

            ...(orders.length > 0
                ? [
                    blocks.section(
                        `Page ${pagination.page} — Showing ${orders.length} orders.`,
                    ),
                ]
                : []),

            // Orders Table
            buildOrdersTable({
                orders,
                nextCursor: undefined,
                hasMore: false,
            }),

            // Orders Pagination
            ...(pagination.page > 1 || hasMore
                ? [
                    blocks.actions([
                        ...(pagination.page > 1
                            ? [
                                    elements.button(
                                        "stripe-orders-previous",
                                        "Previous",
                                        {
                                            style: "secondary",
                                            value: pagination,
                                        },
                                    ),
                                ]
                            : []),

                        ...(hasMore && nextCursor
                            ? [
                                    elements.button(
                                        "stripe-orders-next",
                                        "Next",
                                        {
                                            style: "secondary",
                                            value: {
                                                page: pagination.page + 1,
                                                cursor: nextCursor,
                                                previousCursors: [
                                                    ...pagination.previousCursors,
                                                    pagination.cursor,
                                                ],
                                            },
                                        },
                                    ),
                                ]
                            : []),
                    ]),
                ]
            : []),
        ],
    };
}
