import { describe, expect, it } from "vitest";

import {
    normalizeCurrency,
    SUPPORTED_CURRENCIES,
} from "../src/products/currency.js";

describe("Currency validation", () => {
    it.each([
        ["USD", "usd"],
        ["CAD", "cad"],
        ["EUR", "eur"],
        ["GBP", "gbp"],
    ])("normalizes %s to %s", (input, expected) => {
        expect(normalizeCurrency(input)).toBe(expected);
    });

    it("accepts lowercase currency codes", () => {
        for (const currency of SUPPORTED_CURRENCIES) {
            expect(normalizeCurrency(currency)).toBe(currency);
        }
    });

    it("trims surrounding whitespace", () => {
        expect(normalizeCurrency("  CAD  ")).toBe("cad");
    });

    it.each([
        undefined,
        null,
        "",
        "   ",
        "JPY",
        "AUD",
        "US",
        123,
        {},
    ])("rejects unsupported or missing currency: %s", (input) => {
        expect(normalizeCurrency(input)).toBeNull();
    });

    it("supports exactly the four v1 currencies", () => {
        expect(SUPPORTED_CURRENCIES).toEqual([
            "usd",
            "cad",
            "eur",
            "gbp",
        ]);
    });
});