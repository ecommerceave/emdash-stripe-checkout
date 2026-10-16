export type OrderPaymentStatus =
  | "pending"
  | "paid"
  | "failed"
  | "refund_processing"
  | "refund_pending"
  | "refunded";

export type Order = {
  id: string;
  stripeSessionId: string;
  productId: string;
  quantity: number;

  amountTotal: number | null;
  currency: string | null;

  paymentStatus: OrderPaymentStatus;
  customerEmail: string | null;

  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  
  stripeRefundId?: string | null;
  refundStatus?: string | null;
  refundedAt?: string | null;
};