
import type { PluginContext } from "emdash/plugin";
import { getProductContentTypeSlug } from "./content-type.js";

export const REQUIRED_PRODUCT_FIELDS = [
    { slug: "name", type: "string", required: true },
    { slug: "description", type: "text", required: false },
    { slug: "image", type: "image", required: false },
    { slug: "price", type: "number", required: true },
    { slug: "currency", type: "select", required: true },
    { slug: "sku", type: "string", required: false },
    { slug: "active", type: "boolean", required: false },
] as const;

export type ProductSchemaCheck = {
    ok: boolean;
    collectionExists: boolean;
    fields: Array<{
        slug: string;
        expectedType: string;
        required: boolean;
        actualType?: string;
        exists: boolean;
        valid: boolean;
    }>;
};

export async function checkProductSchema(
    ctx: PluginContext,
): Promise<ProductSchemaCheck> {
    const collection = await ctx.schema?.getCollection(
        await getProductContentTypeSlug(ctx),
    );

    if (!collection) {
        return {
            ok: false,
            collectionExists: false,
            fields: REQUIRED_PRODUCT_FIELDS.map((field) => ({
                slug: field.slug,
                expectedType: field.type,
                required: field.required,
                exists: false,
                valid: false,
            })),
        };
    }

    const fields = REQUIRED_PRODUCT_FIELDS.map((requiredField) => {
        const actualField = collection.fields.find(
            (field) => field.slug === requiredField.slug,
        );

        return {
            slug: requiredField.slug,
            expectedType: requiredField.type,
            required: requiredField.required,
            actualType: actualField?.type,
            exists: Boolean(actualField),
            valid:
                Boolean(actualField) &&
                actualField?.type === requiredField.type &&
                (!requiredField.required || actualField.required) &&
                (requiredField.slug !== "currency" ||
                    ["USD", "CAD", "EUR", "GBP"].every((currency) =>
                        actualField?.validation?.options?.includes(currency),
                    )),
        };
    });

    return {
        ok: fields.every((field) => field.valid),
        collectionExists: true,
        fields,
    };
}

export function getProductSchemaGuidance(
    schema: ProductSchemaCheck,
    contentTypeSlug = "products",
): string {
    if (!schema.collectionExists) {
    return [
            `Stripe Checkout requires a Product Content Type with the slug "${contentTypeSlug}".`,
            "",
            "SETUP INSTRUCTIONS",
            "",
            "1. Open Content Types in your EmDash admin.",
            "2. Create or configure a Content Type with:",
            "   Name: Products (or your preferred name)",
            `   Slug: ${contentTypeSlug}`,
            "",
            "3. Add the following fields:",
            "",
            "Name — name — String — Required",
            "Description — description — Text — Optional",
            "Image — image — Image — Optional",
            "Price — price — Number — Required",
            "Currency — currency — Select — Required",
            "SKU — sku — String — Optional",
            "Active — active — Boolean — Optional",
            "",
            "4. Configure the Currency field:",
            "   Options: USD, CAD, EUR, GBP",
            "   Default: USD",
            "",
            "5. Save your collection and return to Stripe Checkout.",
            "",
           "The plugin will automatically detect the configured Content Type.",
        ].join("\n");
    }

    const invalidFields = schema.fields.filter(
        (field) => !field.valid,
    );

    if (invalidFields.length === 0) {
        return `The Product Content Type "${contentTypeSlug}" is configured correctly.`;
    }

    return [
        `The Product Content Type "${contentTypeSlug}" exists, but some fields need attention:`,
        "",
        ...invalidFields.map((field) => {
            const requirement = field.required
                ? ", required"
                : "";

            if (!field.exists) {
                return `${field.slug}: add ${field.expectedType}${requirement}`;
            }

            return `${field.slug}: expected ${field.expectedType}${requirement}, found ${field.actualType ?? "unknown"}`;
        }),
    ].join("\n");
}
