export const SUPPORTED_CURRENCIES = [
    "usd",
    "cad",
    "eur",
    "gbp",
] as const;

export type SupportedCurrency =
    (typeof SUPPORTED_CURRENCIES)[number];

export function normalizeCurrency(
    value: unknown,
): SupportedCurrency | null {
    if (typeof value !== "string") {
        return null;
    }

    const currency = value.trim().toLowerCase();

    return SUPPORTED_CURRENCIES.find(
        (supported) => supported === currency,
    ) ?? null;
}