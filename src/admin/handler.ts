import type { PluginContext } from "emdash/plugin";

import {
    blocks,
    elements,
    type BlockInteraction,
} from "@emdash-cms/blocks/server";

import { testStripeConnection } from "../stripe/connection.js";
import { syncOrderCustomerEmails } from "../orders/sync.js";

import { buildAdminPage } from "./pages.js";
import { buildOrderDetailsPage } from "./order-details.js";

export async function handleAdminInteraction(
    interaction: BlockInteraction,
    ctx: PluginContext,
) {
    // Sync missing customer emails and product names
    if (
        interaction.type === "block_action" &&
        interaction.action_id === "stripe-orders-sync"
    ) {
        try {
            const result = await syncOrderCustomerEmails(ctx);

            const response = await buildAdminPage(ctx);

            response.toast = {
                message:
                    `Stripe sync complete. ` +
                    `${result.updated} updated, ` +
                    `${result.skipped} skipped, ` +
                    `${result.failed} failed ` +
                    `(${result.checked} orders checked).`,
                type: result.failed > 0 ? "error" : "success",
            };

            return response;
        } catch (error) {
            ctx.log.error("Stripe order synchronization failed", {
                message:
                    error instanceof Error
                        ? error.message
                        : "Unknown error",
            });

            const response = await buildAdminPage(ctx);

            response.toast = {
                message:
                    error instanceof Error
                        ? error.message
                        : "Unable to synchronize orders with Stripe.",
                type: "error",
            };

            return response;
        }
    }

    // Test Stripe connection
    if (
        interaction.type === "block_action" &&
        interaction.action_id === "test-stripe-connection"
    ) {
        const stripeConnection = await testStripeConnection(ctx);

        const response = await buildAdminPage(
            ctx,
            stripeConnection,
        );

        response.toast = {
            message: stripeConnection.ok
                ? "Stripe connection verified successfully."
                : stripeConnection.error ??
                  "Unable to connect to Stripe.",
            type: stripeConnection.ok ? "success" : "error",
        };

        return response;
    }

    // View individual order details
    if (
        interaction.type === "block_action" &&
        interaction.action_id === "stripe-order-details"
    ) {
        const orderId = interaction.value;

        if (typeof orderId !== "string" || !orderId.trim()) {
            return {
                blocks: [
                    blocks.header("Invalid Order"),
                    blocks.section("No valid order ID was provided."),
                    blocks.actions([
                        elements.button(
                            "stripe-orders-back",
                            "Back to Orders",
                        ),
                    ]),
                ],
            };
        }

        return await buildOrderDetailsPage(ctx, orderId);
    }

    // Return to Orders dashboard
    if (
        interaction.type === "block_action" &&
        interaction.action_id === "stripe-orders-back"
    ) {
        return await buildAdminPage(ctx);
    }

    // Orders pagination
    if (
        interaction.type === "block_action" &&
        interaction.action_id === "stripe-orders-next-page"
    ) {
        const value = interaction.value;

        const cursor =
            typeof value === "object" &&
            value !== null &&
            "cursor" in value &&
            typeof value.cursor === "string"
                ? value.cursor
                : undefined;

        return await buildAdminPage(ctx, undefined, cursor);
    }

    // Default dashboard
    return await buildAdminPage(ctx);
}