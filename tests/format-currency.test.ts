import { describe, expect, it } from "vitest";

import { formatCurrency } from "../src/admin/format-currency.js";

describe("Admin currency formatting", () => {
    it.each([
        [2500, "usd", "25.00 USD"],
        [3500, "cad", "35.00 CAD"],
        [4500, "eur", "45.00 EUR"],
        [5500, "gbp", "55.00 GBP"],
        [1999, "USD", "19.99 USD"],
        [0, "CAD", "0.00 CAD"],
        [125, " eur ", "1.25 EUR"],
    ])(
        "formats %i minor units in %s as %s",
        (amount, currency, expected) => {
            expect(formatCurrency(amount, currency)).toBe(expected);
        },
    );

    it.each([
        [null, "usd"],
        [undefined, "usd"],
        [NaN, "usd"],
        [Infinity, "usd"],
        [2500, null],
        [2500, undefined],
        [2500, ""],
        [2500, "   "],
    ])(
        "returns Unavailable for invalid amount or currency",
        (amount, currency) => {
            expect(formatCurrency(amount, currency)).toBe(
                "Unavailable",
            );
        },
    );
});