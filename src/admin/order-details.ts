import type { PluginContext } from "emdash/plugin";

import {
    blocks,
    elements,
    type BlockResponse,
} from "@emdash-cms/blocks/server";

import { getOrder } from "../orders/storage.js";
import { formatCurrency } from "./format-currency.js";

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
    const formattedAmount = formatCurrency(
        order.amountTotal,
        order.currency,
    );

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
                            value: formatCurrency(
                                order.refundedAmount ??
                                    (order.paymentStatus === "refunded"
                                        ? order.amountTotal ?? 0
                                        : 0),
                                order.currency,
                            ),
                        },
                        {
                            label: "Remaining Balance",
                            value:
                                order.amountTotal != null
                                    ? formatCurrency(
                                        Math.max(
                                            0,
                                            order.amountTotal -
                                                (order.refundedAmount ??
                                                    (order.paymentStatus === "refunded"
                                                        ? order.amountTotal
                                                        : 0)),
                                        ),
                                        order.currency,
                                    )
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
                                        value: formatCurrency(
                                            refund.amount,
                                            refund.currency,
                                        ),
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

