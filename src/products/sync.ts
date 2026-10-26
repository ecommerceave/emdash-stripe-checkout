
import type { SandboxedPlugin } from "emdash/plugin";

import { getProductContentTypeSlug } from "./content-type.js";

import {
    createStripeProduct,
    updateStripeProduct,
    createStripePrice,
    deactivateStripePrice,
} from "./stripe-api.js";

import {
    claimPriceOperation,
    markPriceOperationRetryable,
    completePriceOperation,
    discardOutdatedPriceOperation,
} from "./price-operation.js";

export type StripeProductState = {
    stripeProductId?: string;
    stripePriceId?: string;
    price?: number;
    currency?: string;
    pendingPriceOperation?: {
        operationId: string;
        stripeProductId: string;
        currency: string;
        unitAmount: number;
    };
};

type PublishHook = Extract<
    NonNullable<SandboxedPlugin["hooks"]>["content:afterPublish"],
    (...args: any[]) => any
>;

const MAX_SYNC_ATTEMPTS = 2;

async function syncPublishedProduct(
    event: Parameters<PublishHook>[0],
    ctx: Parameters<PublishHook>[1],
    attempt: number,
): Promise<void> {
    if (event.collection !== await getProductContentTypeSlug(ctx)) {
        return;
    }

    const contentId = String(event.content.id);

    // Retrieve the current published product instead of trusting
    // potentially outdated data from the publish event.
    if (!ctx.content) {
        console.error(
            "[PLUGIN] Content access is not available.",
            { contentId },
        );
        return;
    }

    const currentProduct = await ctx.content.get(
        event.collection,
        contentId,
    );

    if (!currentProduct || currentProduct.status !== "published") {
        console.warn(
            "[PLUGIN] Skipping Stripe synchronization because the product is not currently published.",
            { contentId },
        );
        return;
    }

    const product = currentProduct.data as Record<string, unknown>;
    const eventProduct = event.content.data as Record<string, unknown>;

    // Ignore an older publish event if its price or currency
    // differs from the currently published product.
    const publishedPrice = product.price;
    const eventPrice = eventProduct.price;

    const publishedCurrency =
        typeof product.currency === "string"
            ? product.currency.trim().toLowerCase()
            : "usd";

    const eventCurrency =
        typeof eventProduct.currency === "string"
            ? eventProduct.currency.trim().toLowerCase()
            : "usd";

    if (
        publishedPrice !== eventPrice ||
        publishedCurrency !== eventCurrency
    ) {
        console.warn(
            "[PLUGIN] Skipping outdated product publish event.",
            { contentId },
        );
        return;
    }

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
        const claim = await claimPriceOperation(
            ctx,
            stateKey,
            currentState.stripeProductId,
            currency,
            unitAmount,
        );

        if (!claim || !claim.acquired) {
            return;
        }

        const { operationId } = claim;

        let stripePriceId: string | null;

        try {
            stripePriceId = await createStripePrice(ctx, {
                contentId,
                stripeProductId: currentState.stripeProductId,
                currency,
                unitAmount,
                stripeSecretKey,
                operationId,
            });
        } catch (error) {
            console.error(
                "[PLUGIN] Stripe Price creation encountered an exception.",
                {
                    contentId,
                    operationId,
                    error,
                },
            );

            // The request may have succeeded at Stripe.
            // Leave the operation in "processing" so recovery
            // can reuse the original idempotency key.
            return;
        }

        if (!stripePriceId) {
            const markedRetryable =
                await markPriceOperationRetryable(
                    ctx,
                    stateKey,
                    operationId,
                    claim.attemptId,
                );

            if (!markedRetryable) {
                console.error(
                    "[PLUGIN] Failed to mark Stripe Price operation as retryable.",
                    { contentId, operationId },
                );
            }

            return;
        }

        // Check whether the published product changed while Stripe
        // was creating the Price.
        const latestProduct = await ctx.content.get(
            event.collection,
            contentId,
        );

        const latestData = latestProduct?.data as
            | Record<string, unknown>
            | undefined;

        const latestPrice = latestData?.price;

        const latestCurrency =
            typeof latestData?.currency === "string"
                ? latestData.currency.trim().toLowerCase()
                : "usd";

        const priceIsOutdated =
            latestProduct?.status !== "published" ||
            latestPrice !== price ||
            latestCurrency !== currency;

        if (priceIsOutdated) {
            console.warn(
                "[PLUGIN] Stripe Price became outdated during creation.",
                { contentId, operationId, stripePriceId },
            );

            const discarded =
                await discardOutdatedPriceOperation(
                    ctx,
                    stateKey,
                    operationId,
                    claim.attemptId,
                );

            if (!discarded) {
                console.error(
                    "[PLUGIN] Could not safely resolve outdated Stripe Price operation.",
                    { contentId, operationId, stripePriceId },
                );
                return;
            }

            await deactivateStripePrice(
                ctx,
                stripePriceId,
                stripeSecretKey,
            );

            // Retry using the latest published product, up to
            // the configured maximum number of attempts.
            if (
                latestProduct?.status === "published" &&
                attempt < MAX_SYNC_ATTEMPTS
            ) {
                await syncPublishedProduct(
                    {
                        ...event,
                        content: {
                            id: latestProduct.id,
                            data: latestProduct.data,
                        },
                    },
                    ctx,
                    attempt + 1,
                );
            }

            return;
        }

        // Atomically save the new Stripe Price before deactivating
        // the previous one.
        const completed = await completePriceOperation(
            ctx,
            stateKey,
            operationId,
            claim.attemptId,
            stripePriceId,
            price,
            currency,
        );

        if (!completed) {
            console.error(
                "[PLUGIN] Stripe Price was created, but its state could not be saved.",
                { contentId, operationId, stripePriceId },
            );

            return;
        }

        if (currentState.stripePriceId && priceChanged) {
            await deactivateStripePrice(
                ctx,
                currentState.stripePriceId,
                stripeSecretKey,
            );
        }
    }
}

// Export the standard EmDash publish hook.
// The attempt counter remains internal to the plugin.
export const syncProductAfterPublish: PublishHook = async (
    event,
    ctx,
) => {
    await syncPublishedProduct(event, ctx, 1);
};
