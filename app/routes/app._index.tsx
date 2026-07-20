import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { data, useFetcher, useOutletContext } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { getShopBillingAccess } from "../models/shop-entitlement.server";
import type { AppOutletContext } from "../app-context";
import {
  syncStorefrontSettings,
  type PersistedVisibilitySettings,
} from "../models/shop-settings.server";
import { authenticate } from "../shopify.server";

const booleanFields = [
  "hideSoldOutVariants",
  "hideFullySoldOutProducts",
] as const;

function parseBoolean(
  formData: FormData,
  field: (typeof booleanFields)[number],
) {
  const value = formData.get(field);

  if (value === null) return false;
  if (value === "true") return true;

  throw new Error(`Invalid value for ${field}`);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", { status: 405 });
  }

  const { admin, session } = await authenticate.admin(request);
  const billingAccess = await getShopBillingAccess({
    admin,
    shop: session.shop,
  });

  if (!billingAccess.entitled) {
    return data(
      {
        ok: false as const,
        error:
          billingAccess.state === "unavailable"
            ? "The subscription could not be verified. Try again."
            : "An active Shopify app subscription is required.",
      },
      { status: billingAccess.state === "unavailable" ? 503 : 402 },
    );
  }

  let hideSoldOutVariants: boolean;
  let hideFullySoldOutProducts: boolean;

  try {
    const formData = await request.formData();
    hideSoldOutVariants = parseBoolean(formData, "hideSoldOutVariants");
    hideFullySoldOutProducts = parseBoolean(
      formData,
      "hideFullySoldOutProducts",
    );
  } catch (error) {
    console.error("Invalid shop settings submission", error);
    return data(
      { ok: false as const, error: "The submitted settings are invalid." },
      { status: 400 },
    );
  }

  let settings: PersistedVisibilitySettings;

  try {
    settings = await prisma.shopSettings.upsert({
      where: { shop: session.shop },
      update: { hideSoldOutVariants, hideFullySoldOutProducts },
      create: {
        shop: session.shop,
        hideSoldOutVariants,
        hideFullySoldOutProducts,
      },
    });
  } catch (error) {
    console.error("Unable to save shop settings", error);
    return data(
      { ok: false as const, error: "Settings could not be saved. Try again." },
      { status: 500 },
    );
  }

  try {
    await syncStorefrontSettings(admin, settings, billingAccess);
  } catch (error) {
    console.error("Unable to sync storefront settings", error);
    return { ok: true as const, syncPending: true as const };
  }

  return { ok: true as const, syncPending: false as const };
};

export default function Index() {
  const initialSettings = useOutletContext<AppOutletContext>();
  const settingsFetcher = useFetcher<typeof action>();
  const actionData = settingsFetcher.data;
  const shopify = useAppBridge();
  const [hideSoldOutVariants, setHideSoldOutVariants] = useState(
    initialSettings.hideSoldOutVariants,
  );
  const [hideFullySoldOutProducts, setHideFullySoldOutProducts] = useState(
    initialSettings.hideFullySoldOutProducts,
  );
  const isSaving = settingsFetcher.state !== "idle";
  const themeEditorUrl = `shopify:admin/themes/current/editor?context=apps&template=product&activateAppId=${initialSettings.apiKey}/app-embed`;
  const trialEndsAt = initialSettings.billingAccess.trialEndsAt
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
        new Date(initialSettings.billingAccess.trialEndsAt),
      )
    : null;

  useEffect(() => {
    if (actionData?.ok) {
      shopify.toast.show(
        actionData.syncPending
          ? "Settings saved; theme sync will retry"
          : "Settings saved",
      );
    }
  }, [actionData, shopify]);

  const saveVisibilitySettings = (
    nextHideSoldOutVariants: boolean,
    nextHideFullySoldOutProducts: boolean,
  ) => {
    setHideSoldOutVariants(nextHideSoldOutVariants);
    setHideFullySoldOutProducts(nextHideFullySoldOutProducts);

    const formData = new FormData();
    if (nextHideSoldOutVariants) {
      formData.set("hideSoldOutVariants", "true");
    }
    if (nextHideFullySoldOutProducts) {
      formData.set("hideFullySoldOutProducts", "true");
    }
    settingsFetcher.submit(formData, { method: "post" });
  };

  return (
    <s-page heading="HiSha: Hide Out of Stock">
      <s-stack direction="block" gap="base">
        {actionData && !actionData.ok ? (
          <s-banner tone="critical" heading="Could not save settings">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        ) : null}
        {initialSettings.themeSyncError ? (
          <s-banner tone="warning" heading="Theme settings need to sync">
            <s-paragraph>
              Change a visibility setting to retry storefront synchronization.
            </s-paragraph>
          </s-banner>
        ) : null}
        {actionData?.ok && actionData.syncPending ? (
          <s-banner tone="warning" heading="Settings saved">
            <s-paragraph>
              Storefront synchronization is pending and will retry when the app
              is opened again.
            </s-paragraph>
          </s-banner>
        ) : null}

        {initialSettings.billingAccess.state === "development_bypass" ? (
          <s-banner tone="warning" heading="Development access is active">
            <s-paragraph>
              This allowlisted development store is using the explicit local
              billing bypass. Production always fails closed.
            </s-paragraph>
          </s-banner>
        ) : null}

        {initialSettings.billingAccess.state === "verification_stale" ? (
          <s-banner tone="warning" heading="Plan verification is delayed">
            <s-paragraph>
              Shopify billing is temporarily unavailable. HiSha is using the
              last verified plan status and will check again automatically.
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Status">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone="success">Active</s-badge>
            <s-paragraph>
              HiSha is installed and ready for theme integration.
            </s-paragraph>
          </s-stack>
        </s-section>

        <s-section heading="Plan">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge
                tone={
                  initialSettings.billingAccess.state ===
                    "development_bypass" ||
                  initialSettings.billingAccess.state === "verification_stale"
                    ? "warning"
                    : "success"
                }
              >
                {initialSettings.billingAccess.state === "development_bypass"
                  ? "Development"
                  : initialSettings.billingAccess.state === "verification_stale"
                    ? "Verification delayed"
                    : trialEndsAt
                      ? "Free trial"
                      : "Active"}
              </s-badge>
              <s-paragraph>
                {trialEndsAt
                  ? `Trial ends ${trialEndsAt}. Shopify billing starts after the trial.`
                  : initialSettings.billingAccess.state === "verification_stale"
                    ? "Access is based on the last verified Shopify plan status."
                    : initialSettings.billingAccess.state ===
                        "development_bypass"
                      ? "Local access is enabled without a billing contract."
                      : "Your Shopify app subscription is active."}
              </s-paragraph>
            </s-stack>
            {initialSettings.billingAccess.cancelAtEndOfCycle ? (
              <s-paragraph tone="warning">
                This subscription is scheduled to cancel at the end of its
                current billing cycle.
              </s-paragraph>
            ) : null}
            {initialSettings.billingAccess.selectorUrl ? (
              <s-button
                href={initialSettings.billingAccess.selectorUrl}
                target="_top"
                variant="secondary"
              >
                Manage plan
              </s-button>
            ) : null}
          </s-stack>
        </s-section>

        <s-section heading="Storefront visibility">
          <s-stack direction="block" gap="base">
            <s-checkbox
              label="Hide sold-out variants"
              checked={hideSoldOutVariants}
              disabled={isSaving}
              onChange={(event) =>
                saveVisibilitySettings(
                  event.currentTarget.checked,
                  hideFullySoldOutProducts,
                )
              }
            />
            <s-checkbox
              label="Hide fully sold-out products"
              checked={hideFullySoldOutProducts}
              disabled={isSaving}
              onChange={(event) =>
                saveVisibilitySettings(
                  hideSoldOutVariants,
                  event.currentTarget.checked,
                )
              }
            />
            <s-paragraph>
              Fully sold-out products stay active in Shopify Admin and are
              hidden only on the storefront.
            </s-paragraph>
            <s-paragraph>Changes save automatically.</s-paragraph>
          </s-stack>
        </s-section>

        <s-section heading="Manual visibility">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Hide individual products or variants on the storefront, regardless
              of their inventory status. Shopify Admin product data stays
              unchanged.
            </s-paragraph>
            <s-button href="/app/manual-visibility" variant="secondary">
              Manage products and variants
            </s-button>
          </s-stack>
        </s-section>

        <s-section heading="Theme integration">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Enable the HiSha app embed in the active theme to load the
              storefront integration.
            </s-paragraph>
            <s-button href={themeEditorUrl} variant="secondary">
              Open theme editor
            </s-button>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
