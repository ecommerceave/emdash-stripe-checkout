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

export type StripeConnectionResult = {
    ok: boolean;
    mode?: "test" | "live";
    accountId?: string;
    error?: string;
};

type StripeConnectionState = {
    mode: "test" | "live";
    accountId: string;
    verifiedAt: string;
};

const STRIPE_CONNECTION_STATE_KEY = "state:stripe-connection";

export async function buildOrderDetailsPage(
  ctx: PluginContext,
  orderId: string,
): Promise<BlockResponse> {
  const order = await getOrder(ctx, orderId);

  if (!order) {
    return {
      blocks: [
        blocks.header("Order Not Found"),
        blocks.section("The requested order could not be found."),
        blocks.actions([
          elements.button("stripe-orders-back", "Back to Orders"),
        ]),
      ],
    };
  }

  return {
    blocks: [
		blocks.header(`Order #${order.id.slice(-8).toUpperCase()}`),
		blocks.fields([
			{ label: "Order ID", value: order.id },
			{ label: "Stripe Session ID", value: order.stripeSessionId },
			{ label: "Customer Email", value: order.customerEmail ?? "Not provided" },
			{ label: "Product ID", value: order.productId },
			{ label: "Quantity", value: String(order.quantity) },
			{
			label: "Amount",
			value:
				order.amountTotal != null && order.currency
				? `${(order.amountTotal / 100).toFixed(2)} ${order.currency.toUpperCase()}`
				: "Unavailable",
			},
			{ label: "Payment Status", value: order.paymentStatus },
			{ label: "Created", value: order.createdAt },
			{ label: "Updated", value: order.updatedAt },
			{ label: "Paid At", value: order.paidAt ?? "Not paid" },
			{
				label: "Stripe Refund ID",
				value: order.stripeRefundId ?? "Not refunded",
			},
			{
				label: "Refund Status",
				value: order.refundStatus ?? "Not refunded",
			},
			{
				label: "Refunded At",
				value: order.refundedAt ?? "Not refunded",
			},
		]),
		blocks.actions([
			elements.button("stripe-orders-back", "Back to Orders"),

			...(order.paymentStatus === "paid"
				? [
					elements.button(
					"stripe-order-refund",
					"Refund Order",
					{ value: order.id },
					),
				]
				: []),

			...(order.paymentStatus === "refund_pending" && order.stripeRefundId
				? [
					elements.button(
					"stripe-refund-check-status",
					"Check Refund Status",
					{ value: order.id },
					),
				]
				: []),

			...(order.paymentStatus === "refund_processing"
				? [
					elements.button(
					"stripe-refund-reconcile",
					"Check Stripe Refunds",
					{ value: order.id },
					),
				]
				: []),
			]),
    	],
  	};
}

export async function buildRefundConfirmationPage(
  ctx: PluginContext,
  orderId: string,
): Promise<BlockResponse> {
  const order = await getOrder(ctx, orderId);

  if (!order || order.paymentStatus !== "paid") {
    return {
      blocks: [
        blocks.header("Refund Unavailable"),
        blocks.section(
          "This order cannot be refunded because it was not found or is not currently paid.",
        ),
        blocks.actions([
          elements.button("stripe-orders-back", "Back to Orders"),
        ]),
      ],
    };
  }

  return {
    blocks: [
      blocks.header("Confirm Refund"),
      blocks.section(
        "You are about to issue a full refund for this order. Please review the details before continuing.",
      ),
      blocks.fields([
        { label: "Order ID", value: order.id },
        {
          label: "Customer Email",
          value: order.customerEmail ?? "Not provided",
        },
        {
          label: "Refund Amount",
          value:
            order.amountTotal != null && order.currency
              ? `${(order.amountTotal / 100).toFixed(2)} ${order.currency.toUpperCase()}`
              : "Unavailable",
        },
        { label: "Payment Status", value: order.paymentStatus },
      ]),
      blocks.actions([
		elements.button("stripe-order-details", "Cancel", {
			value: order.id,
		}),
		elements.button("stripe-refund-confirm", "Confirm Full Refund", {
			value: order.id,
		}),
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
  
  const stripeSecretKey =
    await ctx.settings.get<string>("stripeSecretKey");
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

    return {
        blocks: [
            blocks.header("Stripe Checkout"),
            blocks.section(
                "Lightweight Stripe Checkout integration for EmDash.",
            ),
            blocks.fields([
                {
                label: "Stripe Connection",
                value: !stripeSecretKey
                    ? "Needs setup"
                    : !connection
                    ? "Not tested"
                    : connection.ok
                        ? "Connected"
                        : "Connection failed",
                },
                {
                label: "Connection Details",
                value: !stripeSecretKey
                    ? "Add your Stripe Secret Key in plugin settings."
                    : !connection
                    ? "Click Test Stripe Connection to verify your credentials."
                    : connection.ok
                        ? "Stripe credentials verified successfully."
                        : connection.error ?? "Unable to connect to Stripe.",
                },
                {
                label: "Stripe Mode",
                value: !stripeSecretKey
                    ? "Not configured"
                    : !connection
                    ? "Pending connection test"
                    : connection.ok
                        ? connection.mode === "test"
                        ? "Test"
                        : "Live"
                        : "Unavailable",
                },
                {
                label: "Stripe Account",
                value: !stripeSecretKey
                    ? "Not configured"
                    : !connection
                    ? "Pending connection test"
                    : connection.ok && connection.accountId
                        ? connection.accountId
                        : "Unavailable",
                },
                {
                label: "Last Verified",
                value:
                    connection?.ok && savedConnection?.verifiedAt
                    ? `${new Date(savedConnection.verifiedAt).toLocaleString(
                        ctx.site.locale,
                        {
                            timeZone: "UTC",
                        },
                        )} UTC`
                    : "Never",
                },
                {
                label: "Products Collection",
                value: schema.collectionExists ? "Found" : "Missing",
                },
                {
                label: "Product Schema",
                value: schema.ok ? "Valid" : "Needs attention",
                },
            ]),
            blocks.section(
                schema.ok
                    ? "Products are ready to use."
                    : getProductSchemaGuidance(schema),
            ),
            blocks.actions([
                elements.button(
                    "test-stripe-connection",
                    "Test Stripe Connection",
                    {
                        style: "primary",
                    },
                ),
            ]),
            blocks.header("Orders"),
            blocks.section(
                orders.length === 0
                    ? "No orders have been placed yet."
                    : `Showing ${orders.length} recent orders.`,
                ),
                blocks.table({
                blockId: "stripe-orders-table",
                columns: [
                    { key: "order", label: "Order", format: "code" },
                    { key: "customer", label: "Customer", format: "text" },
                    { key: "quantity", label: "Qty", format: "number" },
                    { key: "amount", label: "Amount", format: "text" },
                    { key: "status", label: "Status", format: "badge" },
                    { key: "date", label: "Date", format: "text" },
                    { key: "actions", label: "Actions", format: "element" },
                ],
                rows: orders.map((order) => ({
                    order: `#${order.id.slice(-8).toUpperCase()}`,
                    customer: order.customerEmail ?? "Not provided",
                    quantity: order.quantity,
                    amount:
                    order.amountTotal != null && order.currency
                        ? `${(order.amountTotal / 100).toFixed(2)} ${order.currency.toUpperCase()}`
                        : "Unavailable",
                    status: order.paymentStatus,
                    date:
                    new Date(order.createdAt).toLocaleString("en-US", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "UTC",
                    }) + " UTC",
                    actions: elements.button(
                        "stripe-order-details",
                        "View Details",
                        {
                            style: "secondary",
                            value: order.id,
                        },
                    ),
                })),
                nextCursor: hasMore ? nextCursor : undefined,
                pageActionId: "stripe-orders-next-page",
                emptyText: "No orders have been placed yet.",
            }),
        ],
    };
}