import type { ShopBillingAccess } from "./models/shop-entitlement.server";

export type AppOutletContext = {
  apiKey: string;
  billingAccess: ShopBillingAccess;
  themeSyncError: boolean;
  hideSoldOutVariants: boolean;
  hideFullySoldOutProducts: boolean;
};
