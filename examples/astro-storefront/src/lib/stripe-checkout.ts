import { getDb } from "emdash/runtime";

export const STRIPE_CHECKOUT_PLUGIN_ID = "emdash-stripe-checkout";

const STRIPE_CHECKOUT_PUBLISHER_DID =
  "did:plc:wlshattmcjplayfxlgzbhxvk";

export async function getStripeCheckoutApi(): Promise<string> {
  const db = await getDb();

  // Check for an active locally configured plugin first.
  const localPlugin = await db
    .selectFrom("_plugin_state")
    .select("plugin_id")
    .where("plugin_id", "=", STRIPE_CHECKOUT_PLUGIN_ID)
    .where("source", "=", "config")
    .where("status", "=", "active")
    .executeTakeFirst();

  if (localPlugin) {
    return `/_emdash/api/plugins/${localPlugin.plugin_id}`;
  }

  // Fall back to the marketplace installation.
  const registryPlugin = await db
    .selectFrom("_plugin_state")
    .select("plugin_id")
    .where("source", "=", "registry")
    .where("status", "=", "active")
    .where("registry_publisher_did", "=", STRIPE_CHECKOUT_PUBLISHER_DID)
    .where("registry_slug", "=", STRIPE_CHECKOUT_PLUGIN_ID)
    .executeTakeFirst();

  if (registryPlugin) {
    return `/_emdash/api/plugins/${registryPlugin.plugin_id}`;
  }

  throw new Error("No active Stripe Checkout plugin installation found.");
}
export async function getStripeCheckoutProductContentType(
  siteOrigin: string,
): Promise<string> {
  const api = await getStripeCheckoutApi();

  const response = await fetch(
    `${siteOrigin}${api}/getStorefrontConfig`,
  );

  if (!response.ok) {
    throw new Error("Unable to load Stripe Checkout storefront configuration.");
  }

  const result = (await response.json()) as {
    success: boolean;
    data?: {
      productContentTypeSlug?: string;
    };
  };

  if (
    result.success !== true ||
    typeof result.data?.productContentTypeSlug !== "string"
  ) {
    throw new Error("Invalid Stripe Checkout storefront configuration.");
  }

  return result.data.productContentTypeSlug;
}
