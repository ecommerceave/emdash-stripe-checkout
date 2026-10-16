import { pluginRoute, type SandboxedPlugin } from "emdash/plugin";
import type { BlockInteraction } from "@emdash-cms/blocks/server";

import { checkProductSchema } from "./products/schema.js";
import { syncProductAfterPublish } from "./products/sync.js";
import { testStripeConnection } from "./stripe/connection.js";
import { handleAdminInteraction } from "./admin/handler.js";
import { createCheckoutSession, verifyCheckoutSession } from "./checkout/handler.js";
import { handleStripeWebhook } from "./stripe/webhook-handler.js";

const plugin: SandboxedPlugin = {
    hooks: {
        "content:afterPublish": syncProductAfterPublish,
    },

    routes: {
        admin: pluginRoute({
            methods: ["POST"],
            request: {
                body: "json",
            },
            handler: async (routeCtx, ctx) => {
                return handleAdminInteraction(
                    routeCtx.input as BlockInteraction,
                    ctx,
                );
            },
        }),

        checkProductSchema: pluginRoute({
            methods: ["GET"],
            request: {
                body: "none",
            },
            handler: async (_routeCtx, ctx) => {
                return await checkProductSchema(ctx);
            },
        }),

        testStripeConnection: pluginRoute({
            methods: ["POST"],
            request: {
                body: "none",
            },
            handler: async (_routeCtx, ctx) => {
                return await testStripeConnection(ctx);
            },
        }),

        createCheckoutSession: pluginRoute({
            public: true,
            methods: ["POST"],
            request: {
                body: "json",
            },
            handler: createCheckoutSession,
        }),

        stripeWebhook: pluginRoute({
            public: true,
            methods: ["POST"],
            response: "raw",
            request: {
                body: "bytes",
                headers: ["stripe-signature"],
                maxBytes: 65536,
            },
            handler: handleStripeWebhook,
        }),

        verifyCheckoutSession: pluginRoute({
            public: true,
            methods: ["POST"],
            request: {
                body: "json",
            },
            handler: verifyCheckoutSession,
        }),
    },
};

export default plugin;
