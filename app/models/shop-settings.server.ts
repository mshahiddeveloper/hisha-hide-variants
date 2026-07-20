import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { getStorefrontManualVisibility } from "./manual-visibility.server";
import type { ShopBillingAccess } from "./shop-entitlement.server";

export type VisibilitySettings = {
  hideSoldOutVariants: boolean;
  hideFullySoldOutProducts: boolean;
};

export type PersistedVisibilitySettings = VisibilitySettings & {
  shop: string;
};

export const DEFAULT_VISIBILITY_SETTINGS: VisibilitySettings = {
  hideSoldOutVariants: true,
  hideFullySoldOutProducts: false,
};

const SETTINGS_NAMESPACE = "hisha";
const SETTINGS_KEY = "visibility_settings";
const STOREFRONT_SYNC_TIMEOUT_MS = 8_000;

type InstallationResponse = {
  data?: {
    currentAppInstallation?: {
      id: string;
      metafield?: { value: string } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

type MetafieldsSetResponse = {
  data?: {
    metafieldsSet?: {
      userErrors: Array<{ field?: string[] | null; message: string }>;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

function graphQlErrors(errors?: Array<{ message: string }>) {
  return errors?.map(({ message }) => message).join(", ");
}

async function syncStorefrontSettingsInternal(
  admin: AdminApiContext,
  settings: PersistedVisibilitySettings,
  billingAccess: ShopBillingAccess,
) {
  const manualVisibility = await getStorefrontManualVisibility(settings.shop);
  const value = JSON.stringify({
    version: 3,
    entitled: billingAccess.entitled,
    entitlementValidUntil: billingAccess.entitlementValidUntil,
    hideSoldOutVariants: settings.hideSoldOutVariants,
    hideFullySoldOutProducts: settings.hideFullySoldOutProducts,
    ...manualVisibility,
  });

  if (Buffer.byteLength(value, "utf8") > 128 * 1024) {
    throw new Error("Storefront visibility settings exceed Shopify's limit.");
  }
  const installationResponse = await admin.graphql(
    `#graphql
      query HiShaCurrentInstallation {
        currentAppInstallation {
          id
          metafield(namespace: "hisha", key: "visibility_settings") {
            value
          }
        }
      }
    `,
  );
  const installationBody =
    (await installationResponse.json()) as InstallationResponse;
  const installation = installationBody.data?.currentAppInstallation;

  if (!installation) {
    throw new Error(
      graphQlErrors(installationBody.errors) ||
        "Shopify app installation could not be loaded.",
    );
  }

  if (installation.metafield?.value === value) return;

  const updateResponse = await admin.graphql(
    `#graphql
      mutation HiShaSaveStorefrontSettings($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            namespace: SETTINGS_NAMESPACE,
            key: SETTINGS_KEY,
            type: "json",
            value,
            ownerId: installation.id,
          },
        ],
      },
    },
  );
  const updateBody = (await updateResponse.json()) as MetafieldsSetResponse;
  const userErrors = updateBody.data?.metafieldsSet?.userErrors ?? [];

  if (updateBody.errors?.length || userErrors.length) {
    const messages = [
      graphQlErrors(updateBody.errors),
      ...userErrors.map(({ message }) => message),
    ].filter(Boolean);

    throw new Error(messages.join(", ") || "Storefront settings sync failed.");
  }
}

export async function syncStorefrontSettings(
  admin: AdminApiContext,
  settings: PersistedVisibilitySettings,
  billingAccess: ShopBillingAccess,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      syncStorefrontSettingsInternal(admin, settings, billingAccess),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Storefront settings sync timed out."));
        }, STOREFRONT_SYNC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
