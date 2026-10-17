import type { PluginContext } from "emdash/plugin";

import {
    listOrders,
    savePaymentIntentOrderLookup,
} from "./storage.js";

import type { Order } from "./types.js";

type StripeSession = {
    id?: string;
    client_reference_id?: string;
    payment_intent?: string | null;
    customer_details?: {
        email?: string | null;
    } | null;
    error?: {
        message?: string;
    };
};

type SyncOutcome = "updated" | "skipped" | "failed";

export type OrderSyncResult = {
    checked: number;
    updated: number;
    skipped: number;
    failed: number;
};

type MissingOrderDetails = {
    customerEmail?: string;
    productName?: string;
    stripePaymentIntentId?: string;
};

/**
 * Update only missing order information.
 *
 * Uses compareAndSet to prevent overwriting changes
 * made by another request.
 */
async function fillMissingOrderDetails(
    ctx: PluginContext,
    order: Order,
    details: MissingOrderDetails,
): Promise<SyncOutcome> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const current =
            await ctx.storage.orders.getVersioned(order.id);

        if (!current) {
            return "failed";
        }

        const storedOrder = current.value as Order;

        // Ensure this is still the same checkout/order.
        if (
            storedOrder.stripeSessionId !== order.stripeSessionId ||
            storedOrder.productId !== order.productId
        ) {
            return "failed";
        }

        const changes: Partial<Order> = {};

        // Never overwrite an existing customer email.
        if (
            !storedOrder.customerEmail &&
            details.customerEmail
        ) {
            changes.customerEmail = details.customerEmail;
        }

        // Never overwrite an existing product name.
        if (
            !storedOrder.productName &&
            details.productName
        ) {
            changes.productName = details.productName;
        }

        // Never overwrite an existing Stripe PaymentIntent ID.
        if (
            !storedOrder.stripePaymentIntentId &&
            details.stripePaymentIntentId?.startsWith("pi_")
        ) {
            changes.stripePaymentIntentId =
                details.stripePaymentIntentId;
        }

        if (Object.keys(changes).length === 0) {
            return "skipped";
        }

        const result =
            await ctx.storage.orders.compareAndSet(
                order.id,
                current.revision,
                {
                    ...storedOrder,
                    ...changes,
                    updatedAt: new Date().toISOString(),
                },
            );

        if (result.applied) {
            if (changes.stripePaymentIntentId) {
                await savePaymentIntentOrderLookup(
                    ctx,
                    changes.stripePaymentIntentId,
                    order.id,
                );
            }

            return "updated";
        }
    }

    return "failed";
}

/**
 * Synchronize missing order details.
 *
 * - Missing customer emails come from Stripe.
 * - Missing product names come from EmDash.
 * - Existing values are never overwritten.
 * - Payment and refund information remains unchanged.
 */
export async function syncOrderCustomerEmails(
    ctx: PluginContext,
): Promise<OrderSyncResult> {
    const stripeSecretKey =
        await ctx.settings.get<string>("stripeSecretKey");

    if (!stripeSecretKey) {
        throw new Error(
            "Stripe Secret Key has not been configured.",
        );
    }

    if (!ctx.http) {
        throw new Error("Network access is not available.");
    }

    const result: OrderSyncResult = {
        checked: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
    };

    let cursor: string | undefined;

    do {
        const page = await listOrders(ctx, cursor);

        for (const order of page.orders) {
            result.checked++;

            const missingEmail = !order.customerEmail;
            const missingProductName = !order.productName;
            const missingPaymentIntent = !order.stripePaymentIntentId;

            // Ensure existing PaymentIntent IDs have a lookup entry.
            if (order.stripePaymentIntentId?.startsWith("pi_")) {
                try {
                    await savePaymentIntentOrderLookup(
                        ctx,
                        order.stripePaymentIntentId,
                        order.id,
                    );
                } catch (error) {
                    result.failed++;

                    ctx.log.error("Order PaymentIntent lookup sync failed", {
                        orderId: order.id,
                        paymentIntentId: order.stripePaymentIntentId,
                        message:
                            error instanceof Error
                                ? error.message
                                : "Unknown error",
                    });

                    continue;
                }
            }

            // Nothing to synchronize for this order.
            if (!missingEmail && !missingProductName && !missingPaymentIntent) {
                result.skipped++;
                continue;
            }

            const details: MissingOrderDetails = {};
            let hadError = false;

            // ----------------------------------------
            // Recover missing product name from EmDash
            // ----------------------------------------
            if (missingProductName) {
                try {
                    const product = await ctx.content?.get(
                        "products",
                        order.productId,
                    );

                    const name = product?.data?.name;

                    if (
                        typeof name === "string" &&
                        name.trim().length > 0
                    ) {
                        details.productName = name.trim();
                    }
                } catch (error) {
                    hadError = true;

                    ctx.log.error(
                        "Order product name sync error",
                        {
                            orderId: order.id,
                            productId: order.productId,
                            message:
                                error instanceof Error
                                    ? error.message
                                    : "Unknown error",
                        },
                    );
                }
            }

            // ----------------------------------------
            // Recover missing customer email from Stripe
            // ----------------------------------------
            if (missingEmail || missingPaymentIntent) {
                if (
                    !order.stripeSessionId?.startsWith("cs_")
                ) {
                    hadError = true;
                } else {
                    try {
                        const response =
                            await ctx.http.fetch(
                                `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(
                                    order.stripeSessionId,
                                )}`,
                                {
                                    method: "GET",
                                    headers: {
                                        Authorization:
                                            `Bearer ${stripeSecretKey}`,
                                    },
                                },
                            );

                        if (!response.ok) {
                            hadError = true;

                            ctx.log.warn(
                                "Stripe order email sync failed",
                                {
                                    orderId: order.id,
                                    status: response.status,
                                },
                            );
                        } else {
                            const session =
                                (await response.json()) as StripeSession;

                            // Verify the session belongs to this order.
                            if (
                                session.id !==
                                    order.stripeSessionId ||
                                session.client_reference_id !==
                                    order.productId
                            ) {
                                hadError = true;

                                ctx.log.warn(
                                    "Stripe session mismatch during order sync",
                                    {
                                        orderId: order.id,
                                    },
                                );
                            } else {
                                const email =
                                    session.customer_details?.email?.trim();

                                if (email) {
                                    details.customerEmail = email;
                                }
                                // Recover the PaymentIntent ID from Stripe.
                                if (
                                    missingPaymentIntent &&
                                    typeof session.payment_intent === "string" &&
                                    session.payment_intent.startsWith("pi_")
                                ) {
                                    details.stripePaymentIntentId =
                                        session.payment_intent;
                                }
                            }
                        }
                    } catch (error) {
                        hadError = true;

                        ctx.log.error(
                            "Stripe order email sync error",
                            {
                                orderId: order.id,
                                message:
                                    error instanceof Error
                                        ? error.message
                                        : "Unknown error",
                            },
                        );
                    }
                }
            }

            // ----------------------------------------
            // Save recovered information
            // ----------------------------------------
            const outcome =
                await fillMissingOrderDetails(
                    ctx,
                    order,
                    details,
                );

            if (outcome === "failed" || hadError) {
                result.failed++;
            } else if (outcome === "updated") {
                result.updated++;
            } else {
                result.skipped++;
            }
        }

        if (!page.hasMore) {
            break;
        }

        if (!page.cursor || page.cursor === cursor) {
            throw new Error(
                "Order pagination could not continue safely.",
            );
        }

        cursor = page.cursor;
    } while (true);

    return result;
}