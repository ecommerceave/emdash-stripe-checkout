
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import type { StripeProductState } from "./sync.js";
import { getProductContentTypeSlug } from "./content-type.js";

export async function deactivateStripeProduct(
    contentId: string,
    ctx: PluginContext,
): Promise<void> {
    const stateKey = `state:product:${contentId}`;
    const stripeState = await ctx.kv.get<StripeProductState>(stateKey);

    if (!stripeState?.stripeProductId) {
        return;
    }

    const stripeSecretKey =
        await ctx.settings.get<string>("stripeSecretKey");

    if (!stripeSecretKey || !ctx.http) {
        console.error("[PLUGIN] Cannot deactivate Stripe Product", {
            id: contentId,
        });
        return;
    }

    const body = new URLSearchParams();
    body.set("active", "false");

    const response = await ctx.http.fetch(
        `https://api.stripe.com/v1/products/${stripeState.stripeProductId}`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${stripeSecretKey}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
        },
    );

    if (!response.ok) {
        console.error("[PLUGIN] Stripe Product deactivation failed", {
            id: contentId,
            stripeProductId: stripeState.stripeProductId,
            status: response.status,
        });
        return;
    }

    console.log("[PLUGIN] Stripe Product deactivated", {
        id: contentId,
        stripeProductId: stripeState.stripeProductId,
    });
}

export const syncProductAfterDelete: NonNullable<
    SandboxedPlugin["hooks"]
>["content:afterDelete"] = async (event, ctx) => {
    if (event.collection !== await getProductContentTypeSlug(ctx)) {
        return;
    }

    await deactivateStripeProduct(event.id, ctx);
};
