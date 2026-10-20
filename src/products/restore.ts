import type { SandboxedPlugin } from "emdash/plugin";
import { syncProductAfterPublish } from "./sync.js";
import { getProductContentTypeSlug } from "./content-type.js";

export const syncProductAfterRestore: NonNullable<
    SandboxedPlugin["hooks"]
>["content:afterRestore"] = async (event, ctx) => {
    if (event.collection !== await getProductContentTypeSlug(ctx)) {
        return;
    }

    const content = event.content as {
        id: string;
        status?: string;
        data?: Record<string, unknown>;
    };

    if (!content.id || !content.data) {
        return;
    }

    // Only synchronize products that are published.
    if (content.status !== "published") {
        return;
    }

    // Reuse the existing Stripe product synchronization.
    await syncProductAfterPublish(event, ctx);
};