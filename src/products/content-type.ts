import type { PluginContext } from "emdash/plugin";

export async function getProductContentTypeSlug(
    ctx: PluginContext,
): Promise<string> {
    const configuredSlug = await ctx.settings.get<string>(
        "productContentTypeSlug",
    );

    return configuredSlug?.trim() || "products";
}
