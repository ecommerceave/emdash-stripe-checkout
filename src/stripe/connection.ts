
import type { PluginContext } from "emdash/plugin";

export const STRIPE_CONNECTION_STATE_KEY = "state:stripe-connection";

export type StripeConnectionResult = {
    ok: boolean;
    mode?: "test" | "live";
    accountId?: string;
    error?: string;
};

export type StripeConnectionState = {
    mode: "test" | "live";
    accountId: string;
    verifiedAt: string;
};

export async function testStripeConnection(
    ctx: PluginContext,
): Promise<StripeConnectionResult> {
    const stripeSecretKey =
        await ctx.settings.get<string>("stripeSecretKey");

    if (!stripeSecretKey) {
        await ctx.kv.delete(STRIPE_CONNECTION_STATE_KEY);

        return {
            ok: false,
            error: "Stripe Secret Key is not configured.",
        };
    }

    if (!ctx.http) {
        return {
            ok: false,
            error: "Network access is not available.",
        };
    }

    const response = await ctx.http.fetch(
        "https://api.stripe.com/v1/account",
        {
            method: "GET",
            headers: {
                Authorization: `Bearer ${stripeSecretKey}`,
            },
        },
    );

    const data = (await response.json()) as {
        id?: string;
        error?: {
            message?: string;
        };
    };

    if (!response.ok) {
        await ctx.kv.delete(STRIPE_CONNECTION_STATE_KEY);

        return {
            ok: false,
            error:
                data.error?.message ??
                "Unable to connect to Stripe.",
        };
    }

    const mode = stripeSecretKey.startsWith("sk_test_")
        ? "test"
        : "live";

    if (data.id) {
        await ctx.kv.set(STRIPE_CONNECTION_STATE_KEY, {
            mode,
            accountId: data.id,
            verifiedAt: new Date().toISOString(),
        });
    }

    return {
        ok: true,
        mode,
        accountId: data.id,
    };
}
