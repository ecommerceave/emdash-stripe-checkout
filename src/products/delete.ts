import type { SandboxedPlugin } from "emdash/plugin";
import type { StripeProductState } from "./sync.js";

export const syncProductAfterDelete: NonNullable<
    SandboxedPlugin["hooks"]
>["content:afterDelete"] = async (event, ctx) => {
    if (event.collection !== "products") {
        return;
    }

    const stateKey = `state:product:${event.id}`;
    const stripeState = await ctx.kv.get<StripeProductState>(stateKey);

    if (!stripeState?.stripeProductId) {
        return;
    }

    const stripeSecretKey =
        await ctx.settings.get<string>("stripeSecretKey");

    if (!stripeSecretKey || !ctx.http) {
        console.error("[PLUGIN] Cannot deactivate deleted Stripe Product", {
            id: event.id,
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
            id: event.id,
            stripeProductId: stripeState.stripeProductId,
            status: response.status,
        });
        return;
    }

    console.log("[PLUGIN] Deleted product deactivated in Stripe", {
        id: event.id,
        stripeProductId: stripeState.stripeProductId,
        permanent: event.permanent,
    });
};