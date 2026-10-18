import type { PluginContext } from "emdash/plugin";

import {
    blocks,
    elements,
    type BlockResponse,
} from "@emdash-cms/blocks/server";

import {
    getOrder,
    listOrders,
} from "../orders/storage.js";

import {
    checkProductSchema,
    getProductSchemaGuidance,
} from "../products/schema.js";

import {
    STRIPE_CONNECTION_STATE_KEY,
    type StripeConnectionResult,
    type StripeConnectionState,
} from "../stripe/connection.js";

export async function buildOrderDetailsPage(
    ctx: PluginContext,
    orderId: string,
): Promise<BlockResponse> {
    const order = await getOrder(ctx, orderId);

    if (!order) {
        return {
            blocks: [
                blocks.header("Order Not Found"),
                blocks.section(
                    "The requested order could not be found.",
                ),
                blocks.actions([
                    elements.button(
                        "stripe-orders-back",
                        "Back to Orders",
                    ),
                ]),
            ],
        };
    }

    // Format the order amount
    const formattedAmount =
        order.amountTotal != null && order.currency
            ? `${(order.amountTotal / 100).toFixed(2)} ${order.currency.toUpperCase()}`
            : "Unavailable";

    // Format dates for readability
    const formatDate = (
        value: string | null | undefined,
    ): string => {
        if (!value) {
            return "Unavailable";
        }

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return "Unavailable";
        }

        return (
            date.toLocaleString("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "UTC",
            }) + " UTC"
        );
    };

    // Format payment status
    const paymentStatus = order.paymentStatus
        .replace(/_/g, " ")
        .replace(/\b\w/g, (character) =>
            character.toUpperCase(),
        );

    // Determine whether refund information is relevant
    const hasRefundInformation =
        Boolean(order.stripeRefundId) ||
        Boolean(order.refundStatus) ||
        Boolean(order.refundedAt) ||
        order.paymentStatus.includes("refund");

    return {
        blocks: [
            // Page Header
            blocks.header(
                `Order #${order.id.slice(-8).toUpperCase()}`,
            ),

            // Order Summary
            blocks.section("Order Summary"),

            // Product purchased
            blocks.fields([
                {
                    label: "Product",
                    value: order.productName || "Not available",
                },
            ]),

            blocks.columns([
                [
                    blocks.fields([
                        {
                            label: "Customer",
                            value: order.customerEmail ?? "Not provided",
                        },
                        {
                            label: "Quantity",
                            value: String(order.quantity),
                        },
                    ]),
                ],
                [
                    blocks.fields([
                        {
                            label: "Order Date",
                            value: formatDate(order.createdAt),
                        },
                        {
                            label: "Payment Status",
                            value: paymentStatus,
                        },
                    ]),
                ],
            ]),

            // Order Total
            blocks.divider(),

            blocks.stats([
                {
                    label:
                        order.paymentStatus === "paid"
                            ? "Total Paid"
                            : "Order Total",
                    value: formattedAmount,
                    description:
                        order.paymentStatus === "paid"
                            ? "Payment completed"
                            : `Payment status: ${paymentStatus}`,
                },
            ]),

            // Refund Information
            ...(hasRefundInformation || (order.refunds?.length ?? 0) > 0
                ? [
                    blocks.section("Refund Information"),

                    blocks.fields([
                        {
                            label: "Refund Status",
                            value: order.refundStatus ?? paymentStatus,
                        },
                        {
                            label: "Refunded Amount",
                            value: `${(
                                (order.refundedAmount ??
                                    (order.paymentStatus === "refunded"
                                        ? order.amountTotal ?? 0
                                        : 0)) / 100
                            ).toFixed(2)} ${(order.currency ?? "USD").toUpperCase()}`,
                        },
                        {
                            label: "Remaining Balance",
                            value:
                                order.amountTotal != null
                                    ? `${(
                                        Math.max(
                                            0,
                                            order.amountTotal -
                                                (order.refundedAmount ??
                                                    (order.paymentStatus === "refunded"
                                                        ? order.amountTotal
                                                        : 0)),
                                        ) / 100
                                    ).toFixed(2)} ${(order.currency ?? "USD").toUpperCase()}`
                                    : "Unavailable",
                        },
                        {
                            label: "Refunded At",
                            value: order.refundedAt
                                ? formatDate(order.refundedAt)
                                : "Not fully refunded",
                        },
                    ]),

                    ...(order.refunds?.length
                        ? [
                            blocks.section("Refund History"),

                            ...order.refunds.map((refund) =>
                                blocks.fields([
                                    {
                                        label: "Refund ID",
                                        value: refund.id,
                                    },
                                    {
                                        label: "Amount",
                                        value: `${(refund.amount / 100).toFixed(2)} ${refund.currency.toUpperCase()}`,
                                    },
                                    {
                                        label: "Status",
                                        value: refund.status
                                            .replace(/_/g, " ")
                                            .replace(/\b\w/g, (character) =>
                                                character.toUpperCase(),
                                            ),
                                    },
                                    {
                                        label: "Created",
                                        value: formatDate(refund.createdAt),
                                    },
                                    ...(refund.failureReason
                                        ? [
                                            {
                                                label: "Failure Reason",
                                                value: refund.failureReason,
                                            },
                                        ]
                                        : []),
                                ]),
                            ),
                        ]
                        : []),
                ]
                : []),

            // Collapsible Technical Details
            blocks.accordion({
                label: "Technical Details",
                defaultOpen: false,
                blocks: [
                    blocks.fields([
                        {
                            label: "Order ID",
                            value: order.id,
                        },
                        {
                            label: "Stripe Session ID",
                            value: order.stripeSessionId,
                        },
                        {
                            label: "Stripe Payment Intent ID",
                            value: order.stripePaymentIntentId ?? "Not available",
                        },
                        {
                            label: "Product ID",
                            value: order.productId,
                        },
                        {
                            label: "Created",
                            value: formatDate(order.createdAt),
                        },
                        {
                            label: "Last Updated",
                            value: formatDate(order.updatedAt),
                        },
                        {
                            label: "Paid At",
                            value: order.paidAt
                                ? formatDate(order.paidAt)
                                : "Not paid",
                        },
                        ...(order.stripeRefundId
                            ? [
                                  {
                                      label: "Stripe Refund ID",
                                      value: order.stripeRefundId,
                                  },
                              ]
                            : []),
                    ]),
                ],
            }),

            // Navigation
            blocks.actions([
                elements.button(
                    "stripe-orders-back",
                    "Back to Orders",
                    {
                        style: "secondary",
                    },
                ),
            ]),
        ],
    };
}

export async function buildAdminPage(
    ctx: PluginContext,
    stripeConnection?: StripeConnectionResult,
    ordersCursor?: string,
): Promise<BlockResponse> {
    const schema = await checkProductSchema(ctx);

    const { orders, cursor: nextCursor, hasMore } =
        await listOrders(ctx, ordersCursor);

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
                        [
                            blocks.header("1. Connect Stripe"),
                            blocks.section(
                                "Add your Stripe Secret Key in plugin settings, then test your connection.",
                            ),
                        ],
                        [
                            blocks.header("2. Enable Webhooks"),
                            blocks.section(
                                "Create a webhook endpoint in Stripe using the URL below, then add its signing secret to plugin settings.",
                            ),
                        ],
                        [
                            blocks.header("3. Configure Products"),
                            blocks.section(
                                "Configure your product collection and add products to begin accepting payments.",
                            ),
                        ],
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
                : []
            ),

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
                        ? "Product collection configured"
                        : "Product schema requires attention",
                },
                {
                    label: "Recent Orders",
                    value: orders.length,
                    description: "Orders loaded on this page",
                },
            ]),

            // Product Schema Guidance
            ...(!schema.ok
                ? [
                      blocks.section(
                          getProductSchemaGuidance(schema),
                      ),
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

            blocks.section(
                orders.length === 0
                    ? "No orders have been placed yet."
                    : `Showing ${orders.length} recent orders.`,
            ),

            // Orders Table
            blocks.table({
                blockId: "stripe-orders-table",
                columns: [
                    {
                        key: "order",
                        label: "Order",
                        format: "code",
                    },
                    {
                        key: "product",
                        label: "Product",
                        format: "text",
                    },
                    {
                        key: "customer",
                        label: "Customer",
                        format: "text",
                    },
                    {
                        key: "quantity",
                        label: "Qty",
                        format: "number",
                    },
                    {
                        key: "amount",
                        label: "Amount",
                        format: "text",
                    },
                    {
                        key: "status",
                        label: "Status",
                        format: "badge",
                    },
                    {
                        key: "date",
                        label: "Date",
                        format: "text",
                    },
                    {
                        key: "actions",
                        label: "Actions",
                        format: "element",
                    },
                ],

                rows: orders.map((order) => ({
                    order: `#${order.id.slice(-8).toUpperCase()}`,

                    product: order.productName || "Not available",

                    customer:
                        order.customerEmail ?? "Not provided",

                    quantity: order.quantity,

                    amount:
                        order.amountTotal != null && order.currency
                            ? `${(order.amountTotal / 100).toFixed(2)} ${order.currency.toUpperCase()}`
                            : "Unavailable",

                    status: order.paymentStatus,

                    date:
                        new Date(order.createdAt).toLocaleString(
                            "en-US",
                            {
                                dateStyle: "medium",
                                timeStyle: "short",
                                timeZone: "UTC",
                            },
                        ) + " UTC",

                    actions: elements.button(
                        "stripe-order-details",
                        "View Details",
                        {
                            style: "secondary",
                            value: order.id,
                        },
                    ),
                })),

                nextCursor: hasMore
                    ? nextCursor
                    : undefined,

                pageActionId: "stripe-orders-next-page",

                emptyText:
                    "No orders have been placed yet.",
            }),
        ],
    };
}