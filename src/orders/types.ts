export type OrderPaymentStatus =
    | "pending"
    | "paid"
    | "failed"
    | "refund_processing"
    | "refund_pending"
    | "refunded";

/**
 * A refund created and managed through Stripe.
 *
 * Amounts are stored in the smallest currency unit
 * (for example, cents for USD).
 */
export type OrderRefund = {
    id: string;
    amount: number;
    currency: string;
    status: string;

    createdAt: string;
    updatedAt: string;

    failureReason?: string | null;
};

export type Order = {
    id: string;
    stripeSessionId: string;
    stripePaymentIntentId?: string | null;

    // Product information captured at checkout
    productId: string;
    productName?: string | null;
    quantity: number;

    amountTotal: number | null;
    currency: string | null;

    paymentStatus: OrderPaymentStatus;
    customerEmail: string | null;

    createdAt: string;
    updatedAt: string;
    paidAt: string | null;

    // Legacy refund fields retained for existing orders
    stripeRefundId?: string | null;
    refundStatus?: string | null;
    refundedAt?: string | null;

    // Refund history synchronized from Stripe
    refunds?: OrderRefund[];

    // Total amount successfully refunded, in minor currency units
    refundedAmount?: number;
};