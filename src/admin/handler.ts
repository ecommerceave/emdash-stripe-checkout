import type { PluginContext } from "emdash/plugin";

import {
    blocks,
    elements,
    type BlockInteraction,
} from "@emdash-cms/blocks/server";

import {
    getOrder,
    recordPendingRefund,
    recordSuccessfulRefund,
    claimOrderForRefund,
} from "../orders/storage.js";

import {
    getStripePaymentIntent,
    createStripeRefund,
    getStripeRefund,
    listStripeRefunds,
} from "../refunds/stripe.js";

import { testStripeConnection } from "../stripe/connection.js";

import {
    buildAdminPage,
    buildOrderDetailsPage,
    buildRefundConfirmationPage,
} from "./pages.js";
export async function handleAdminInteraction(
    interaction: BlockInteraction,
    ctx: PluginContext,
) {

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

			// Reconcile an existing Stripe refund without creating another refund.
			// Only matching full refunds with succeeded or pending status update the order.
			// Ambiguous or mismatched refunds require manual reconciliation.
			if (
				interaction.type === "block_action" &&
				interaction.action_id === "stripe-refund-reconcile"
			) {
			const orderId = interaction.value;

			if (typeof orderId !== "string" || !orderId.trim()) {
				return {
					blocks: [
						blocks.header("Invalid Order"),
						blocks.section("No valid order ID was provided."),
					],
				};
			}

			const order = await getOrder(ctx, orderId);

			if (!order || order.paymentStatus !== "refund_processing") {
				return {
					blocks: [
						blocks.header("Reconciliation Unavailable"),
						blocks.section(
						"This order is not currently awaiting refund reconciliation.",
						),
						blocks.actions([
						elements.button("stripe-orders-back", "Back to Orders"),
						]),
					],
				};
			}

			try {
				const paymentIntentId = await getStripePaymentIntent(
				ctx,
				order.stripeSessionId,
				);

				const refunds = await listStripeRefunds(ctx, paymentIntentId);

				if (refunds.has_more) {
					return {
						blocks: [
							blocks.header("Manual Reconciliation Required"),
							blocks.section(
								"Stripe returned additional pages of refunds. Review the complete refund history in Stripe before updating this order.",
							),
							blocks.actions([
								elements.button("stripe-order-details", "Back to Order", {
								value: order.id,
								}),
							]),
						],
					};
				}

				if (!refunds.data || refunds.data.length === 0) {
					return {
						blocks: [
						blocks.header("No Stripe Refund Found"),
						blocks.section(
							"Stripe currently reports no refunds for this payment. The order remains locked because an earlier refund request may have had an uncertain outcome. Verify the payment in Stripe before taking further action.",
						),
						blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
							value: order.id,
							}),
						]),
						],
					};
				}

				if (refunds.data.length > 1) {
					return {
						blocks: [
						blocks.header("Manual Reconciliation Required"),
						blocks.section(
							"Stripe returned multiple refunds for this payment. Review all refunds in Stripe before updating this order. The order remains locked.",
						),
						blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
							value: order.id,
							}),
						]),
						],
					};
				}

				const refund = refunds.data[0];

				if (
					order.amountTotal === null ||
					!Number.isSafeInteger(order.amountTotal) ||
					order.amountTotal <= 0 ||
					typeof order.currency !== "string" ||
					refund.amount !== order.amountTotal ||
					refund.currency !== order.currency.toLowerCase()
					) {
					return {
						blocks: [
						blocks.header("Manual Reconciliation Required"),
						blocks.section(
							"The Stripe refund amount or currency does not match the original order. This may indicate a partial refund or inconsistent payment information. Review the transaction in Stripe before making any changes. The order remains locked.",
						),
						blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
							value: order.id,
							}),
						]),
						],
					};
				}

				if (refund.status === "succeeded") {
					const recorded = await recordSuccessfulRefund(
						ctx,
						order.id,
						refund.id!,
					);

					if (!recorded) {
						return {
						blocks: [
							blocks.header("Manual Reconciliation Required"),
							blocks.section(
							"Stripe confirmed a successful refund, but the order could not be updated safely. The order remains locked. Review the transaction in Stripe.",
							),
							blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
								value: order.id,
							}),
							]),
						],
						};
					}
				}

				if (refund.status === "pending") {
					const recorded = await recordPendingRefund(
						ctx,
						order.id,
						refund.id!,
					);

					if (!recorded) {
						return {
						blocks: [
							blocks.header("Manual Reconciliation Required"),
							blocks.section(
							"Stripe confirmed a pending refund, but the order could not be updated safely. The order remains locked. Review the transaction in Stripe.",
							),
							blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
								value: order.id,
							}),
							]),
						],
						};
					}
				}

				if (
					refund.status !== "succeeded" &&
					refund.status !== "pending"
					) {
					return {
						blocks: [
						blocks.header("Manual Reconciliation Required"),
						blocks.section(
							`Stripe reports refund ${refund.id} with status "${refund.status}". This refund cannot be automatically reconciled. Review it in Stripe before taking further action. The order remains locked.`,
						),
						blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
							value: order.id,
							}),
						]),
						],
					};
				}

				return {
					blocks: [
						blocks.header("Stripe Refunds Found"),
						blocks.section(
						"Existing refunds were found for this payment. Review their status in Stripe before making any changes.",
						),
						blocks.fields(
						refunds.data.map((refund) => ({
							label: refund.id ?? "Unknown Refund",
							value: refund.status ?? "Unknown status",
						})),
						),
						blocks.actions([
						elements.button("stripe-order-details", "Back to Order", {
							value: order.id,
						}),
						]),
					],
				};
			} catch (error) {
				return {
				blocks: [
					blocks.header("Reconciliation Check Failed"),
					blocks.section(
					error instanceof Error
						? error.message
						: "Unable to retrieve refund information from Stripe.",
					),
					blocks.section(
					"The order remains locked. Check Stripe manually before taking further action.",
					),
					blocks.actions([
					elements.button("stripe-order-details", "Back to Order", {
						value: order.id,
					}),
					]),
				],
				};
			}
			}

			// Check the status of an existing Stripe refund (read-only)
			if (
			interaction.type === "block_action" &&
			interaction.action_id === "stripe-refund-check-status"
			) {
			const orderId = interaction.value;

			if (typeof orderId !== "string" || !orderId.trim()) {
				return {
				blocks: [
					blocks.header("Invalid Order"),
					blocks.section("No valid order ID was provided."),
				],
				};
			}

			const order = await getOrder(ctx, orderId);

			if (
				!order ||
				order.paymentStatus !== "refund_pending" ||
				!order.stripeRefundId
			) {
				return {
				blocks: [
					blocks.header("Refund Status Unavailable"),
					blocks.section(
					"This order does not have a pending refund to check.",
					),
					blocks.actions([
					elements.button("stripe-orders-back", "Back to Orders"),
					]),
				],
				};
			}

			try {
				const refund = await getStripeRefund(ctx, order.stripeRefundId);

				if (refund.status === "succeeded") {
				const updated = await recordSuccessfulRefund(
					ctx,
					order.id,
					order.stripeRefundId,
				);

				if (!updated) {
					throw new Error(
					"Stripe confirms the refund succeeded, but the local order could not be updated. Manual reconciliation is required.",
					);
				}

				const response = await buildOrderDetailsPage(ctx, order.id);

				response.toast = {
					message: "Refund confirmed and order updated.",
					type: "success",
				};

				return response;
				}

				if (refund.status === "pending") {
				const response = await buildOrderDetailsPage(ctx, order.id);

				response.toast = {
					message: "Stripe reports that this refund is still pending.",
					type: "success",
				};

				return response;
				}

				return {
				blocks: [
					blocks.header("Refund Requires Review"),
					blocks.section(
					`Stripe reports refund ${order.stripeRefundId} with status "${refund.status}". Review it in Stripe before taking further action.`,
					),
					blocks.actions([
					elements.button("stripe-order-details", "Back to Order", {
						value: order.id,
					}),
					]),
				],
				};
			} catch (error) {
				return {
				blocks: [
					blocks.header("Refund Status Check Failed"),
					blocks.section(
					error instanceof Error
						? error.message
						: "Unable to retrieve the refund status from Stripe.",
					),
					blocks.actions([
					elements.button("stripe-order-details", "Back to Order", {
						value: order.id,
					}),
					]),
				],
				};
			}
			}

			// Process a confirmed full refund
			if (
				interaction.type === "block_action" &&
				interaction.action_id === "stripe-refund-confirm"
			) {
			const orderId = interaction.value;

			if (typeof orderId !== "string" || !orderId.trim()) {
				return {
				blocks: [
					blocks.header("Invalid Order"),
					blocks.section("No valid order ID was provided."),
				],
				};
			}

			const order = await getOrder(ctx, orderId);

			if (!order || order.paymentStatus !== "paid") {
				return {
				blocks: [
					blocks.header("Refund Unavailable"),
					blocks.section(
					"This order was not found or is no longer eligible for a refund.",
					),
					blocks.actions([
					elements.button("stripe-orders-back", "Back to Orders"),
					]),
				],
				};
			}

			const claimed = await claimOrderForRefund(ctx, order.id);

			if (!claimed) {
				return {
					blocks: [
					blocks.header("Refund Already Being Processed"),
					blocks.section(
						"This order could not be claimed for a refund. It may already be processing or may no longer be eligible.",
					),
					blocks.actions([
						elements.button("stripe-orders-back", "Back to Orders"),
					]),
					],
				};
			}

			try {
				const paymentIntentId = await getStripePaymentIntent(
					ctx,
					order.stripeSessionId,
			);

				const refund = await createStripeRefund(
				ctx,
				paymentIntentId,
				order.id,
				);

				if (refund.status === "pending") {
					const recorded = await recordPendingRefund(
						ctx,
						order.id,
						refund.id!,
					);

					return {
						blocks: [
							blocks.header(
								recorded ? "Refund Pending" : "Refund Requires Reconciliation",
							),
							blocks.section(
								recorded
									? `Stripe accepted refund ${refund.id}, but processing is still pending. Check Stripe for its final status.`
									: `Stripe accepted refund ${refund.id}, but the local order could not be updated. Reconcile this order with Stripe before retrying.`,
								),
								blocks.actions([
									elements.button("stripe-orders-back", "Back to Orders"),
								]),
							],
						};
					}

					if (refund.status !== "succeeded") {
						return {
							blocks: [
							blocks.header("Refund Requires Review"),
							blocks.section(
								`Stripe returned refund ${refund.id} with status "${refund.status}". Check Stripe before attempting another refund.`,
							),
							blocks.actions([
								elements.button("stripe-orders-back", "Back to Orders"),
							]),
							],
						};
					}

				const updated = await recordSuccessfulRefund(
					ctx,
					order.id,
					refund.id!,
				);

				if (!updated) {
				throw new Error(
					"Stripe refunded the payment, but the local order could not be updated. Reconcile this order before retrying.",
				);
				}

				const response = await buildOrderDetailsPage(ctx, order.id);

				response.toast = {
				message: "Full refund completed successfully.",
				type: "success",
				};

				return response;
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: "An unexpected error occurred.";

				ctx.log.error("Stripe refund requires reconciliation", {
					orderId: order.id,
					message: errorMessage,
				});

				return {
					blocks: [
						blocks.header("Refund Requires Reconciliation"),
						blocks.section(
							`The refund could not be confirmed. Error: ${errorMessage}`,
						),
						blocks.section(
							"This order has been locked in refund_processing to prevent duplicate refunds. Check the payment and refund history in Stripe before taking further action. Do not initiate another refund until the outcome has been verified.",
						),
						blocks.actions([
							elements.button("stripe-order-details", "Back to Order", {
								value: order.id,
							}),
						]),
					],
				};
			}
			}

			// Show refund confirmation screen
			if (
				interaction.type === "block_action" &&
				interaction.action_id === "stripe-order-refund"
				) {
					const orderId = interaction.value;

					if (typeof orderId !== "string" || !orderId.trim()) {
						return {
						blocks: [
							blocks.header("Invalid Order"),
							blocks.section("No valid order ID was provided."),
							blocks.actions([
							elements.button("stripe-orders-back", "Back to Orders"),
							]),
						],
						};
					}

					return await buildRefundConfirmationPage(ctx, orderId);
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
