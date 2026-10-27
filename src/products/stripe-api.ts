
import type { PluginContext } from "emdash/plugin";

type StripeApiResponse = {
    id?: string;
    error?: {
        message?: string;
    };
};

type StripeProductInput = {
    contentId: string;
    name: string;
    description: string;
    sku: string;
    active: boolean;
    imageUrl: string;
    stripeSecretKey: string;
};

type StripePriceInput = {
    contentId: string;
    stripeProductId: string;
    currency: string;
    unitAmount: number;
    stripeSecretKey: string;
    operationId: string;
};

function stripeHeaders(stripeSecretKey: string) {
    return {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
    };
}

export async function createStripeProduct(
    ctx: PluginContext,
    input: StripeProductInput,
): Promise<string | null> {
    if (!ctx.http) {
        console.error("[PLUGIN] Network access is not available.");
        return null;
    }

    const body = new URLSearchParams();

    body.set("name", input.name);
    body.set("active", input.active ? "true" : "false");
    body.set("metadata[emdash_content_id]", input.contentId);

    if (input.description) {
        body.set("description", input.description);
    }

    if (input.imageUrl) {
        body.set("images[0]", input.imageUrl);
    }

    if (input.sku) {
        body.set("metadata[sku]", input.sku);
    }

    const response = await ctx.http.fetch(
        "https://api.stripe.com/v1/products",
        {
            method: "POST",
            headers: {
                ...stripeHeaders(input.stripeSecretKey),
                "Idempotency-Key": `emdash-product-${input.contentId}`,
            },
            body: body.toString(),
        },
    );

    const product = (await response.json()) as StripeApiResponse;

    if (!response.ok || !product.id) {
        console.error("[PLUGIN] Stripe Product creation failed", {
            status: response.status,
            message: product.error?.message,
        });
        return null;
    }

    console.log("[PLUGIN] Stripe Product created", {
        emdashContentId: input.contentId,
        stripeProductId: product.id,
    });

    return product.id;
}

export async function updateStripeProduct(
    ctx: PluginContext,
    stripeProductId: string,
    input: StripeProductInput,
): Promise<boolean> {
    if (!ctx.http) {
        console.error("[PLUGIN] Network access is not available.");
        return false;
    }

    const body = new URLSearchParams();

    body.set("name", input.name);
    body.set("active", input.active ? "true" : "false");
    body.set("description", input.description);
    body.set("metadata[emdash_content_id]", input.contentId);
    body.set("metadata[sku]", input.sku);

    if (input.imageUrl) {
        body.set("images[0]", input.imageUrl);
    }

    const response = await ctx.http.fetch(
        `https://api.stripe.com/v1/products/${stripeProductId}`,
        {
            method: "POST",
            headers: stripeHeaders(input.stripeSecretKey),
            body: body.toString(),
        },
    );

    if (!response.ok) {
        const product = (await response.json()) as StripeApiResponse;

        console.error("[PLUGIN] Stripe Product update failed", {
            status: response.status,
            message: product.error?.message,
        });

        return false;
    }

    console.log("[PLUGIN] Stripe Product updated", {
        stripeProductId,
    });

    return true;
}

export async function createStripePrice(
    ctx: PluginContext,
    input: StripePriceInput,
): Promise<string | null> {
    if (!ctx.http) {
        console.error("[PLUGIN] Network access is not available.");
        return null;
    }

    const body = new URLSearchParams();

    body.set("product", input.stripeProductId);
    body.set("currency", input.currency);
    body.set("unit_amount", String(input.unitAmount));

    const response = await ctx.http.fetch(
        "https://api.stripe.com/v1/prices",
        {
            method: "POST",
            headers: {
                ...stripeHeaders(input.stripeSecretKey),
                "Idempotency-Key":
                    `emdash-price-${input.contentId}-${input.operationId}`,
            },
            body: body.toString(),
        },
    );

    const price = (await response.json()) as StripeApiResponse;

    if (!response.ok || !price.id) {
        console.error("[PLUGIN] Stripe Price creation failed", {
            status: response.status,
            message: price.error?.message,
        });

        return null;
    }

    console.log("[PLUGIN] Stripe Price created", {
        stripeProductId: input.stripeProductId,
        stripePriceId: price.id,
        price: input.unitAmount / 100,
        currency: input.currency,
        unitAmount: input.unitAmount,
    });

    return price.id;
}

export async function deactivateStripePrice(
    ctx: PluginContext,
    stripePriceId: string,
    stripeSecretKey: string,
): Promise<boolean> {
    if (!ctx.http) {
        console.error("[PLUGIN] Network access is not available.");
        return false;
    }

    const body = new URLSearchParams();
    body.set("active", "false");

    try {
        const response = await ctx.http.fetch(
            `https://api.stripe.com/v1/prices/${stripePriceId}`,
            {
                method: "POST",
                headers: stripeHeaders(stripeSecretKey),
                body: body.toString(),
            },
        );

        if (!response.ok) {
            console.error(
                "[PLUGIN] Old Stripe Price could not be deactivated",
                {
                    stripePriceId,
                    status: response.status,
                },
            );
            return false;
        }

        console.log("[PLUGIN] Old Stripe Price deactivated", {
            stripePriceId,
        });

        return true;
    } catch (error) {
        console.error(
            "[PLUGIN] Stripe Price deactivation encountered an exception.",
            {
                stripePriceId,
                error,
            },
        );

        return false;
    }
}
