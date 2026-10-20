import type { SandboxedPlugin } from "emdash/plugin";
import { deactivateStripeProduct } from "./delete.js";
import { getProductContentTypeSlug } from "./content-type.js";

export const syncProductAfterUnpublish: NonNullable<
    SandboxedPlugin["hooks"]
>["content:afterUnpublish"] = async (event, ctx) => {
    if (event.collection !== await getProductContentTypeSlug(ctx)) {
        return;
    }

    const contentId = event.content.id;

    if (typeof contentId !== "string" || !contentId) {
        return;
    }

    await deactivateStripeProduct(contentId, ctx);
};