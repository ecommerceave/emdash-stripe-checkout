
/**
 * Format a product price using its configured currency.
 *
 * Supports standard ISO 4217 currency codes, including
 * USD, CAD, EUR, GBP, AUD, JPY, and others.
 *
 * Formats prices only; does not convert currencies.
 */
export function formatCurrency(
  amount: number | string,
  currency: string,
): string {
  const currencyCode = currency.trim().toUpperCase();

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
  }).format(Number(amount));
}
