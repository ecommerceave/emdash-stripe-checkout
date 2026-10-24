
import { blocks, elements } from "@emdash-cms/blocks/server";
import type { Order } from "../orders/types.js";

type OrdersTableInput = {
    orders: Order[];
    nextCursor?: string;
    hasMore: boolean;
};

export function buildOrdersTable({
    orders,
    nextCursor,
    hasMore,
}: OrdersTableInput) {
    return blocks.table({
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

        emptyText: "No orders have been placed yet.",
    });
}
