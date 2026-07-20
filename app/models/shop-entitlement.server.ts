import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import {
  BillingConfigurationError,
  buildPlanSelectionUrl,
  fetchActiveSubscription,
  getBillingRuntime,
  PartnerApiError,
} from "../services/shopify-app-pricing.server";

const BILLING_CACHE_TTL_MS = 5 * 60 * 1_000;
const BILLING_STALE_FALLBACK_MS = 24 * 60 * 60 * 1_000;
export const STOREFRONT_ENTITLEMENT_LEASE_MS = 30 * 60 * 1_000;

type BillingAccessBase = {
  selectorUrl: string | null;
  billingPeriod: string | null;
  trialEndsAt: string | null;
  currentPeriodEndsAt: string | null;
  cancelAtEndOfCycle: boolean;
  entitlementValidUntil: string | null;
};

export type ShopBillingAccess =
  | (BillingAccessBase & {
      state: "subscribed";
      entitled: true;
      missingConfig: [];
      errorKind: null;
    })
  | (BillingAccessBase & {
      state: "unsubscribed";
      entitled: false;
      missingConfig: [];
      errorKind: null;
    })
  | (BillingAccessBase & {
      state: "development_bypass";
      entitled: true;
      missingConfig: string[];
      errorKind: null;
    })
  | (BillingAccessBase & {
      state: "verification_stale";
      entitled: boolean;
      missingConfig: [];
      errorKind: string;
    })
  | (BillingAccessBase & {
      state: "unavailable";
      entitled: false;
      missingConfig: string[];
      errorKind: string;
    });

type ShopIdentityResponse = {
  data?: { shop?: { id?: string } | null };
  errors?: Array<{ message: string }>;
};

const emptyBillingDetails = {
  billingPeriod: null,
  trialEndsAt: null,
  currentPeriodEndsAt: null,
  cancelAtEndOfCycle: false,
  entitlementValidUntil: null,
} as const;

function storefrontLeaseEndsAt(checkedAt: Date | null, entitled: boolean) {
  if (!checkedAt || !entitled) return null;

  return new Date(
    checkedAt.getTime() + STOREFRONT_ENTITLEMENT_LEASE_MS,
  ).toISOString();
}

function unavailableAccess(
  errorKind: string,
  missingConfig: string[] = [],
  selectorUrl: string | null = null,
): ShopBillingAccess {
  return {
    state: "unavailable",
    entitled: false,
    missingConfig,
    errorKind,
    selectorUrl,
    ...emptyBillingDetails,
  };
}

async function loadShopGid(admin: AdminApiContext) {
  const response = await admin.graphql(
    `#graphql
      query HiShaBillingShopIdentity {
        shop {
          id
        }
      }
    `,
  );
  const body = (await response.json()) as ShopIdentityResponse;
  const shopGid = body.data?.shop?.id;

  if (!shopGid) {
    const details = body.errors?.map(({ message }) => message).join(", ");
    throw new Error(details || "Shopify did not return the shop ID.");
  }

  return shopGid;
}

function accessFromRecord(
  record: {
    entitled: boolean;
    billingPeriod: string | null;
    trialEndsAt: Date | null;
    currentPeriodEndsAt: Date | null;
    cancelAtEndOfCycle: boolean;
    checkedAt: Date | null;
  },
  selectorUrl: string,
): ShopBillingAccess {
  return {
    state: record.entitled ? "subscribed" : "unsubscribed",
    entitled: record.entitled,
    selectorUrl,
    billingPeriod: record.billingPeriod,
    trialEndsAt: record.trialEndsAt?.toISOString() ?? null,
    currentPeriodEndsAt: record.currentPeriodEndsAt?.toISOString() ?? null,
    cancelAtEndOfCycle: record.cancelAtEndOfCycle,
    entitlementValidUntil: storefrontLeaseEndsAt(
      record.checkedAt,
      record.entitled,
    ),
    missingConfig: [],
    errorKind: null,
  } as ShopBillingAccess;
}

function staleAccessFromRecord(
  record: {
    entitled: boolean;
    billingPeriod: string | null;
    trialEndsAt: Date | null;
    currentPeriodEndsAt: Date | null;
    cancelAtEndOfCycle: boolean;
    checkedAt: Date | null;
  },
  selectorUrl: string,
  errorKind: string,
): ShopBillingAccess {
  return {
    state: "verification_stale",
    entitled: record.entitled,
    selectorUrl,
    billingPeriod: record.billingPeriod,
    trialEndsAt: record.trialEndsAt?.toISOString() ?? null,
    currentPeriodEndsAt: record.currentPeriodEndsAt?.toISOString() ?? null,
    cancelAtEndOfCycle: record.cancelAtEndOfCycle,
    entitlementValidUntil: storefrontLeaseEndsAt(
      record.checkedAt,
      record.entitled,
    ),
    missingConfig: [],
    errorKind,
  };
}

export async function getShopBillingAccess({
  admin,
  shop,
  forceRefresh = false,
}: {
  admin: AdminApiContext;
  shop: string;
  forceRefresh?: boolean;
}): Promise<ShopBillingAccess> {
  let runtime: ReturnType<typeof getBillingRuntime>;

  try {
    runtime = getBillingRuntime(shop);
  } catch (error) {
    const missing =
      error instanceof BillingConfigurationError ? error.missing : [];
    console.error("Shopify App Pricing configuration is invalid", error);
    return unavailableAccess("configuration", missing);
  }

  if (runtime.mode === "development_bypass") {
    return {
      state: "development_bypass",
      entitled: true,
      missingConfig: runtime.missing,
      errorKind: null,
      selectorUrl: null,
      ...emptyBillingDetails,
      entitlementValidUntil: new Date(
        Date.now() + STOREFRONT_ENTITLEMENT_LEASE_MS,
      ).toISOString(),
    };
  }

  const selectorUrl = buildPlanSelectionUrl(shop, runtime.config.appHandle);
  let cached;

  try {
    cached = await prisma.shopEntitlement.findUnique({ where: { shop } });
  } catch (error) {
    console.error("Unable to read the cached Shopify billing state", error);
    return unavailableAccess("database", [], selectorUrl);
  }

  if (
    !forceRefresh &&
    cached?.checkedAt &&
    Date.now() - cached.checkedAt.getTime() < BILLING_CACHE_TTL_MS
  ) {
    return accessFromRecord(cached, selectorUrl);
  }

  try {
    const shopGid = cached?.shopGid || (await loadShopGid(admin));
    const subscription = await fetchActiveSubscription(runtime.config, shopGid);
    const now = new Date();
    const record = await prisma.shopEntitlement.upsert({
      where: { shop },
      update: {
        shopGid,
        entitled: subscription !== null,
        billingPeriod: subscription?.billingPeriod ?? null,
        trialEndsAt: subscription?.trialEndsAt
          ? new Date(subscription.trialEndsAt)
          : null,
        currentPeriodEndsAt: subscription?.currentBillingCycle?.endTime
          ? new Date(subscription.currentBillingCycle.endTime)
          : null,
        cancelAtEndOfCycle: subscription?.cancelAtEndOfCycle ?? false,
        checkedAt: now,
      },
      create: {
        shop,
        shopGid,
        entitled: subscription !== null,
        billingPeriod: subscription?.billingPeriod ?? null,
        trialEndsAt: subscription?.trialEndsAt
          ? new Date(subscription.trialEndsAt)
          : null,
        currentPeriodEndsAt: subscription?.currentBillingCycle?.endTime
          ? new Date(subscription.currentBillingCycle.endTime)
          : null,
        cancelAtEndOfCycle: subscription?.cancelAtEndOfCycle ?? false,
        checkedAt: now,
      },
    });

    return accessFromRecord(record, selectorUrl);
  } catch (error) {
    const errorKind =
      error instanceof PartnerApiError
        ? error.kind
        : error instanceof BillingConfigurationError
          ? "configuration"
          : "verification";
    console.error("Unable to verify the Shopify App Pricing contract", error);

    if (
      cached?.checkedAt &&
      Date.now() - cached.checkedAt.getTime() < BILLING_STALE_FALLBACK_MS
    ) {
      return staleAccessFromRecord(cached, selectorUrl, errorKind);
    }

    return unavailableAccess(errorKind, [], selectorUrl);
  }
}
