import type { SandboxedPlugin } from "emdash/plugin";
import { syncProductAfterPublish } from "./sync.js";

export const syncProductAfterRestore: NonNullable<
    SandboxedPlugin["hooks"]
>["content:afterRestore"] = async (event, ctx) => {
    if (event.collection !== "products") {
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