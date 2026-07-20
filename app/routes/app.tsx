import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import prisma from "../db.server";
import { getShopBillingAccess } from "../models/shop-entitlement.server";
import { syncStorefrontSettings } from "../models/shop-settings.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);
  const pathname = new URL(request.url).pathname.replace(/\/$/, "");
  const isWelcomeRoute = pathname === "/app/welcome";
  const billingAccess = await getShopBillingAccess({
    admin,
    shop: session.shop,
    forceRefresh: isWelcomeRoute,
  });
  const settings = await prisma.shopSettings.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  let themeSyncError = false;

  try {
    await syncStorefrontSettings(admin, settings, billingAccess);
  } catch (error) {
    themeSyncError = true;
    console.error("Unable to sync the storefront entitlement", error);
  }

  if (
    (billingAccess.state === "unsubscribed" ||
      (billingAccess.state === "verification_stale" &&
        !billingAccess.entitled)) &&
    !isWelcomeRoute &&
    billingAccess.selectorUrl
  ) {
    return redirect(billingAccess.selectorUrl, { target: "_top" });
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    billingAccess,
    isWelcomeRoute,
    themeSyncError,
    hideSoldOutVariants: settings.hideSoldOutVariants,
    hideFullySoldOutProducts: settings.hideFullySoldOutProducts,
  };
};

export default function App() {
  const loaderData = useLoaderData<typeof loader>();
  const { billingAccess, isWelcomeRoute } = loaderData;
  const verificationBlocked =
    billingAccess.state === "unavailable" && !isWelcomeRoute;

  return (
    <AppProvider embedded apiKey={loaderData.apiKey}>
      <s-app-nav>
        <s-link href="/app">Settings</s-link>
        <s-link href="/app/manual-visibility">Manual visibility</s-link>
      </s-app-nav>
      {verificationBlocked ? (
        <s-page heading="HiSha: Hide Out of Stock">
          <s-banner
            tone="critical"
            heading="Subscription could not be verified"
          >
            <s-paragraph>
              Storefront features are disabled until Shopify billing can be
              verified. Try opening the app again or contact app support.
            </s-paragraph>
          </s-banner>
        </s-page>
      ) : (
        <Outlet
          context={{
            apiKey: loaderData.apiKey,
            billingAccess,
            themeSyncError: loaderData.themeSyncError,
            hideSoldOutVariants: loaderData.hideSoldOutVariants,
            hideFullySoldOutProducts: loaderData.hideFullySoldOutProducts,
          }}
        />
      )}
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
