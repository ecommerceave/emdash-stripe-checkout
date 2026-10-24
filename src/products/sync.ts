
import type { SandboxedPlugin } from "emdash/plugin";

import { getProductContentTypeSlug } from "./content-type.js";

import {
    createStripeProduct,
    updateStripeProduct,
    createStripePrice,
    deactivateStripePrice,
} from "./stripe-api.js";

export type StripeProductState = {
    stripeProductId?: string;
    stripePriceId?: string;
    price?: number;
    currency?: string;
};

export const syncProductAfterPublish: Extract<
    NonNullable<SandboxedPlugin["hooks"]>["content:afterPublish"],
    (...args: any[]) => any
> = async (event, ctx) => {
    if (event.collection !== await getProductContentTypeSlug(ctx)) {
        return;
    }

    const product = event.content.data as Record<string, unknown>;
    const contentId = String(event.content.id);

    const stateKey = `state:product:${contentId}`;
    const stripeState = await ctx.kv.get<StripeProductState>(stateKey);

    const name =
        typeof product.name === "string"
            ? product.name.trim()
            : "";

    const description =
        typeof product.description === "string"
            ? product.description.trim()
            : "";

    const sku =
        typeof product.sku === "string"
            ? product.sku.trim()
            : "";

    const price =
        typeof product.price === "number"
            ? product.price
            : NaN;

    const currency =
        typeof product.currency === "string"
            ? product.currency.trim().toLowerCase()
            : "usd";

    const active =
        product.active === true || product.active === 1;

    // Resolve the product image for Stripe.
    let imageUrl = "";

    if (
        typeof product.image === "object" &&
        product.image !== null &&
        "id" in product.image &&
        typeof product.image.id === "string"
    ) {
        const media = await ctx.media?.get(product.image.id);

        if (media?.url) {
            const siteUrl = new URL(ctx.site.url);

            const isLocal =
                siteUrl.hostname === "localhost" ||
                siteUrl.hostname === "127.0.0.1";

            if (!isLocal) {
                imageUrl = new URL(media.url, siteUrl).toString();
            }
        }
    }

    // Validate product information before syncing.
    if (
        !name ||
        !Number.isFinite(price) ||
        price < 0 ||
        !currency
    ) {
        console.error("[PLUGIN] Product cannot be synced to Stripe", {
            id: contentId,
            name,
            price,
            currency,
        });

        return;
    }

    const unitAmount = Math.round(price * 100);

    const stripeSecretKey =
        await ctx.settings.get<string>("stripeSecretKey");

    if (!stripeSecretKey) {
        console.error(
            "[PLUGIN] Stripe Secret Key has not been configured.",
        );
        return;
    }

    if (!ctx.http) {
        console.error(
            "[PLUGIN] Network access is not available.",
        );
        return;
    }

    const stripeProductInput = {
        contentId,
        name,
        description,
        sku,
        active,
        imageUrl,
        stripeSecretKey,
    };

    // Create a Stripe product if one does not already exist.
    if (!stripeState) {
        const stripeProductId = await createStripeProduct(
            ctx,
            stripeProductInput,
        );

        if (!stripeProductId) {
            return;
        }

        await ctx.kv.set(stateKey, {
            stripeProductId,
        });
    }

    // Update existing Stripe products.
    // Newly created products are not updated again.
    if (stripeState?.stripeProductId) {
        const updated = await updateStripeProduct(
            ctx,
            stripeState.stripeProductId,
            stripeProductInput,
        );

        if (!updated) {
            return;
        }
    }

    // Reload state after product creation or update.
    const currentState =
        (await ctx.kv.get<StripeProductState>(stateKey)) ?? {};

    const priceChanged =
        currentState.price !== price ||
        currentState.currency !== currency;

    // Create a Stripe Price when missing or changed.
    if (
        currentState.stripeProductId &&
        (!currentState.stripePriceId || priceChanged)
    ) {
        const stripePriceId = await createStripePrice(ctx, {
            contentId,
            stripeProductId: currentState.stripeProductId,
            currency,
            unitAmount,
            stripeSecretKey,
        });

        if (!stripePriceId) {
            return;
        }

        // Save the new price before deactivating the old one.
        await ctx.kv.set(stateKey, {
            ...currentState,
            stripePriceId,
            price,
            currency,
        });

        if (currentState.stripePriceId && priceChanged) {
            await deactivateStripePrice(
                ctx,
                currentState.stripePriceId,
                stripeSecretKey,
            );
        }
    }
};
