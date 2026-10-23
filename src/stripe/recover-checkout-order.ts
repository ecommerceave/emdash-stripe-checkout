import type { PluginContext } from "emdash/plugin";
import type { Order } from "../orders/types.js";
import {
    createOrder,
    getOrder,
    savePaymentIntentOrderLookup,
} from "../orders/storage.js";
import { retrieveCheckoutSession } from "./checkout-session.js";
import { validateCheckoutForRecovery } from "./checkout-recovery.js";

export async function recoverCheckoutOrder(
    ctx: PluginContext,
    sessionId: string,
    expectedProductId: string | undefined,
    expectedPaymentIntentId: string | null | undefined,
): Promise<Order | null> {
    try {
        const session = await retrieveCheckoutSession(ctx, sessionId);

        if (!session) {
            return null;
        }

        const purchase = validateCheckoutForRecovery(session);

        if (
            !purchase ||
            !expectedProductId ||
            purchase.productId !== expectedProductId ||
            !expectedPaymentIntentId ||
            purchase.paymentIntentId !== expectedPaymentIntentId
        ) {
            return null;
        }

        const now = new Date().toISOString();

        const order: Order = {
            id: purchase.sessionId,
            stripeSessionId: purchase.sessionId,
            stripePaymentIntentId: purchase.paymentIntentId,
            productId: purchase.productId,
            productName: purchase.productName,
            quantity: purchase.quantity,
            amountTotal: purchase.amountTotal,
            currency: purchase.currency,
            paymentStatus: "paid",
            customerEmail: purchase.customerEmail,
            createdAt: now,
            updatedAt: now,
            paidAt: now,
        };

        const created = await createOrder(ctx, order);

        const savedOrder = created
            ? order
            : await getOrder(ctx, sessionId);

        if (
            !savedOrder ||
            savedOrder.id !== purchase.sessionId ||
            savedOrder.stripeSessionId !== purchase.sessionId ||
            savedOrder.productId !== purchase.productId ||
            savedOrder.stripePaymentIntentId !== purchase.paymentIntentId ||
            savedOrder.quantity !== purchase.quantity ||
            savedOrder.amountTotal !== purchase.amountTotal ||
            savedOrder.currency !== purchase.currency ||
            savedOrder.paymentStatus !== "paid"
        ) {
            return null;
        }

        await savePaymentIntentOrderLookup(
            ctx,
            purchase.paymentIntentId,
            savedOrder.id,
        );

        return savedOrder;
    } catch (error) {
        ctx.log.error("Stripe Checkout order recovery failed", {
            sessionId,
            error: String(error),
        });

        return null;
    }
}
