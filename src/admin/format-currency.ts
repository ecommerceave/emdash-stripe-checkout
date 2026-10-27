export function formatCurrency(
    amount: number | null | undefined,
    currency: string | null | undefined,
): string {
    if (
        amount == null ||
        !Number.isFinite(amount) ||
        typeof currency !== "string" ||
        !currency.trim()
    ) {
        return "Unavailable";
    }

    const formattedAmount = (amount / 100).toFixed(2);
    const currencyCode = currency.trim().toUpperCase();

    return `${formattedAmount} ${currencyCode}`;
}