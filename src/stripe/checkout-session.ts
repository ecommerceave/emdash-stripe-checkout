import type { PluginContext } from "emdash/plugin";

export type StripeCheckoutSessionDetails = {
    id: string;
    payment_status?: string;
    status?: string;
    mode?: string;
    client_reference_id?: string | null;
    payment_intent?: string | null;
    amount_total?: number | null;
    currency?: string | null;
    line_items?: {
        has_more?: boolean;
        data?: Array<{
            quantity?: number | null;
            amount_total?: number;
            price?: {
                id?: string;
                product?: string | {
                    id: string;
                    name?: string;
                    metadata?: Record<string, string>;
                };
                unit_amount?: number | null;
                currency?: string;
            } | null;
            description?: string | null;
        }>;
    };
    customer_details?: {
        email?: string | null;
    } | null;
};

export async function retrieveCheckoutSession(
    ctx: PluginContext,
    sessionId: string,
): Promise<StripeCheckoutSessionDetails | null> {
    if (!/^cs_(test_|live_)[a-zA-Z0-9]+$/.test(sessionId)) {
        return null;
    }

    const stripeSecretKey =
        await ctx.settings.get<string>("stripeSecretKey");

    if (!stripeSecretKey || !ctx.http) {
        return null;
    }

    const response = await ctx.http.fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand%5B%5D=line_items.data.price.product`,
        {
            method: "GET",
            headers: {
                Authorization: `Bearer ${stripeSecretKey}`,
            },
        },
    );

    if (!response.ok) {
        return null;
    }

    const session =
        (await response.json()) as StripeCheckoutSessionDetails;

    if (session.id !== sessionId) {
        return null;
    }

    return session;
}
