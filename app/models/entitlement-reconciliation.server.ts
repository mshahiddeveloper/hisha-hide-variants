import prisma from "../db.server";
import { getShopBillingAccess } from "./shop-entitlement.server";
import { syncStorefrontSettings } from "./shop-settings.server";
import { unauthenticated } from "../shopify.server";

const PARTNER_API_INTERVAL_MS = 300;
const RECONCILIATION_STATE_ID = "storefront-entitlements";

export type EntitlementReconciliationSummary = {
  processed: number;
  entitled: number;
  disabled: number;
  failed: number;
};

function pause(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function reconcileStorefrontEntitlements(
  limit: number,
): Promise<EntitlementReconciliationSummary> {
  const state = await prisma.entitlementReconciliationState.upsert({
    where: { id: RECONCILIATION_STATE_ID },
    update: {},
    create: { id: RECONCILIATION_STATE_ID },
  });
  let shops = await prisma.shopSettings.findMany({
    where: state.cursor ? { shop: { gt: state.cursor } } : undefined,
    select: { shop: true },
    orderBy: { shop: "asc" },
    take: limit,
  });

  if (shops.length === 0 && state.cursor) {
    shops = await prisma.shopSettings.findMany({
      select: { shop: true },
      orderBy: { shop: "asc" },
      take: limit,
    });
  }
  const summary: EntitlementReconciliationSummary = {
    processed: 0,
    entitled: 0,
    disabled: 0,
    failed: 0,
  };

  for (const [index, { shop }] of shops.entries()) {
    try {
      const settings = await prisma.shopSettings.findUnique({
        where: { shop },
      });

      if (!settings) continue;

      const { admin } = await unauthenticated.admin(shop);
      const billingAccess = await getShopBillingAccess({
        admin,
        shop,
        forceRefresh: true,
      });

      await syncStorefrontSettings(admin, settings, billingAccess);
      summary.processed += 1;

      if (billingAccess.entitled) summary.entitled += 1;
      else summary.disabled += 1;
    } catch (error) {
      summary.failed += 1;
      console.error("Unable to reconcile a storefront entitlement", error);
    }

    if (index < shops.length - 1) {
      await pause(PARTNER_API_INTERVAL_MS);
    }
  }

  await prisma.entitlementReconciliationState.update({
    where: { id: RECONCILIATION_STATE_ID },
    data: { cursor: shops.length === limit ? shops.at(-1)?.shop : null },
  });

  return summary;
}
