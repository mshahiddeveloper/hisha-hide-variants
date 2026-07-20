const REQUIRED_BILLING_ENV = [
  "SHOPIFY_PARTNER_ORG_ID",
  "SHOPIFY_PARTNER_API_ACCESS_TOKEN",
  "SHOPIFY_APP_GID",
  "SHOPIFY_APP_HANDLE",
] as const;

const DEFAULT_PARTNER_API_VERSION = "2026-07";
const PARTNER_API_TIMEOUT_MS = 8_000;
const DEVELOPMENT_BYPASS_FLAG = "SHOPIFY_BILLING_DEV_BYPASS";
const DEVELOPMENT_STORE_ALLOWLIST = "SHOPIFY_BILLING_DEV_STORES";

export type ActiveSubscription = {
  billingPeriod: string;
  cancelAtEndOfCycle: boolean;
  trialEndsAt: string | null;
  currentBillingCycle: {
    startTime: string;
    endTime: string;
  } | null;
  items: Array<{
    handle: string;
    description: string;
    price: {
      active: boolean;
      currency: string;
    };
  }>;
};

type PartnerBillingConfig = {
  organizationId: string;
  accessToken: string;
  appGid: string;
  appHandle: string;
  apiVersion: string;
};

export type BillingRuntime =
  | { mode: "configured"; config: PartnerBillingConfig }
  | { mode: "development_bypass"; missing: string[] };

export type PartnerApiErrorKind =
  "timeout" | "network" | "http" | "graphql" | "invalid_response";

export class BillingConfigurationError extends Error {
  readonly missing: string[];

  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = "BillingConfigurationError";
    this.missing = missing;
  }
}

export class PartnerApiError extends Error {
  readonly kind: PartnerApiErrorKind;
  readonly status?: number;

  constructor(kind: PartnerApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "PartnerApiError";
    this.kind = kind;
    this.status = status;
  }
}

function normalizedShopDomain(value: string) {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalized)
    ? normalized
    : null;
}

function developmentBypassEnabled(shop: string) {
  if (process.env[DEVELOPMENT_BYPASS_FLAG]?.trim().toLowerCase() !== "true") {
    return false;
  }

  const requestedShop = normalizedShopDomain(shop);
  const configuredStores =
    process.env[DEVELOPMENT_STORE_ALLOWLIST]?.split(",").map((value) =>
      normalizedShopDomain(value),
    ) ?? [];

  if (
    !requestedShop ||
    configuredStores.length === 0 ||
    configuredStores.some((value) => value === null)
  ) {
    throw new BillingConfigurationError(
      `${DEVELOPMENT_STORE_ALLOWLIST} must contain valid myshopify.com domains.`,
      [DEVELOPMENT_STORE_ALLOWLIST],
    );
  }

  if (!configuredStores.includes(requestedShop)) {
    throw new BillingConfigurationError(
      `Billing development bypass is not allowed for ${requestedShop}.`,
    );
  }

  return true;
}

function requireValidConfig(config: PartnerBillingConfig) {
  if (!/^[A-Za-z0-9_-]+$/.test(config.organizationId)) {
    throw new BillingConfigurationError(
      "SHOPIFY_PARTNER_ORG_ID has an invalid format.",
    );
  }

  if (!/^gid:\/\/shopify\/App\/\d+$/.test(config.appGid)) {
    throw new BillingConfigurationError(
      "SHOPIFY_APP_GID must use the gid://shopify/App/<id> format.",
    );
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.appHandle)) {
    throw new BillingConfigurationError(
      "SHOPIFY_APP_HANDLE must be a lowercase Shopify app handle.",
    );
  }

  if (!/^\d{4}-\d{2}$/.test(config.apiVersion)) {
    throw new BillingConfigurationError(
      "SHOPIFY_PARTNER_API_VERSION must use the YYYY-MM format.",
    );
  }
}

export function getBillingRuntime(shop: string): BillingRuntime {
  const missing = REQUIRED_BILLING_ENV.filter(
    (name) => !process.env[name]?.trim(),
  );

  if (missing.length) {
    if (process.env.NODE_ENV === "production") {
      throw new BillingConfigurationError(
        "Shopify App Pricing is not configured for production.",
        [...missing],
      );
    }

    if (developmentBypassEnabled(shop)) {
      return { mode: "development_bypass", missing: [...missing] };
    }

    throw new BillingConfigurationError(
      `Shopify App Pricing is not configured. Set ${DEVELOPMENT_BYPASS_FLAG}=true with an explicit ${DEVELOPMENT_STORE_ALLOWLIST} allowlist only for local development.`,
      [...missing],
    );
  }

  const config: PartnerBillingConfig = {
    organizationId: process.env.SHOPIFY_PARTNER_ORG_ID!.trim(),
    accessToken: process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN!.trim(),
    appGid: process.env.SHOPIFY_APP_GID!.trim(),
    appHandle: process.env.SHOPIFY_APP_HANDLE!.trim(),
    apiVersion:
      process.env.SHOPIFY_PARTNER_API_VERSION?.trim() ||
      DEFAULT_PARTNER_API_VERSION,
  };

  requireValidConfig(config);
  return { mode: "configured", config };
}

export function buildPlanSelectionUrl(shop: string, appHandle: string) {
  const normalizedShop = shop.trim().toLowerCase();
  const shopMatch = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/.exec(
    normalizedShop,
  );

  if (!shopMatch) {
    throw new BillingConfigurationError(
      "A valid myshopify.com domain is required for the pricing URL.",
    );
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(appHandle)) {
    throw new BillingConfigurationError(
      "A valid Shopify app handle is required for the pricing URL.",
    );
  }

  return `https://admin.shopify.com/store/${shopMatch[1]}/charges/${appHandle}/pricing_plans`;
}

function errorMessages(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value.flatMap((error) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return [error.message];
    }

    return [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDateTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function invalidSubscription(message: string): never {
  throw new PartnerApiError(
    "invalid_response",
    `Shopify Partner API returned invalid subscription data: ${message}`,
  );
}

export function parseActiveSubscription(
  value: unknown,
): ActiveSubscription | null {
  if (value === null) return null;
  if (!isRecord(value)) invalidSubscription("expected an object or null.");

  const billingPeriod = value.billingPeriod;
  const cancelAtEndOfCycle = value.cancelAtEndOfCycle;
  const trialEndsAt = value.trialEndsAt;
  const currentBillingCycle = value.currentBillingCycle;
  const items = value.items;

  if (typeof billingPeriod !== "string" || !billingPeriod.trim()) {
    invalidSubscription("billingPeriod is missing.");
  }
  if (typeof cancelAtEndOfCycle !== "boolean") {
    invalidSubscription("cancelAtEndOfCycle is missing.");
  }
  if (trialEndsAt !== null && !isValidDateTime(trialEndsAt)) {
    invalidSubscription("trialEndsAt is invalid.");
  }

  let parsedBillingCycle: ActiveSubscription["currentBillingCycle"] = null;

  if (currentBillingCycle !== null) {
    if (
      !isRecord(currentBillingCycle) ||
      !isValidDateTime(currentBillingCycle.startTime) ||
      !isValidDateTime(currentBillingCycle.endTime) ||
      Date.parse(currentBillingCycle.endTime) <=
        Date.parse(currentBillingCycle.startTime)
    ) {
      invalidSubscription("currentBillingCycle is invalid.");
    }

    parsedBillingCycle = {
      startTime: currentBillingCycle.startTime,
      endTime: currentBillingCycle.endTime,
    };
  }

  if (!Array.isArray(items) || items.length === 0) {
    invalidSubscription("at least one subscription item is required.");
  }

  const parsedItems = items.map((item, index) => {
    if (!isRecord(item) || !isRecord(item.price)) {
      invalidSubscription(`item ${index + 1} is invalid.`);
    }

    if (typeof item.handle !== "string" || !item.handle.trim()) {
      invalidSubscription(`item ${index + 1} has no handle.`);
    }
    if (typeof item.description !== "string") {
      invalidSubscription(`item ${index + 1} has no description.`);
    }
    if (
      typeof item.price.active !== "boolean" ||
      typeof item.price.currency !== "string" ||
      !item.price.currency.trim()
    ) {
      invalidSubscription(`item ${index + 1} has an invalid price.`);
    }

    return {
      handle: item.handle,
      description: item.description,
      price: {
        active: item.price.active,
        currency: item.price.currency,
      },
    };
  });

  if (!parsedItems.some(({ price }) => price.active)) {
    invalidSubscription("no active subscription price was returned.");
  }

  return {
    billingPeriod,
    cancelAtEndOfCycle,
    trialEndsAt,
    currentBillingCycle: parsedBillingCycle,
    items: parsedItems,
  };
}

export async function fetchActiveSubscription(
  config: PartnerBillingConfig,
  shopGid: string,
): Promise<ActiveSubscription | null> {
  if (!/^gid:\/\/shopify\/Shop\/\d+$/.test(shopGid)) {
    throw new PartnerApiError(
      "invalid_response",
      "Shopify returned an invalid shop ID for billing verification.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PARTNER_API_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(
      `https://partners.shopify.com/${config.organizationId}/api/${config.apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": config.accessToken,
        },
        body: JSON.stringify({
          query: `#graphql
            query HiShaActiveSubscription($appId: ID!, $shopId: ID!) {
              activeSubscription(appId: $appId, shopId: $shopId) {
                billingPeriod
                cancelAtEndOfCycle
                trialEndsAt
                currentBillingCycle {
                  startTime
                  endTime
                }
                items {
                  handle
                  description
                  price {
                    active
                    currency
                  }
                }
              }
            }
          `,
          variables: { appId: config.appGid, shopId: shopGid },
        }),
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new PartnerApiError(
        "timeout",
        "Shopify Partner API billing verification timed out.",
      );
    }

    throw new PartnerApiError(
      "network",
      `Shopify Partner API billing verification failed: ${error instanceof Error ? error.message : "network error"}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new PartnerApiError(
      "invalid_response",
      "Shopify Partner API returned an unreadable response.",
      response.status,
    );
  }

  if (!response.ok) {
    throw new PartnerApiError(
      "http",
      `Shopify Partner API returned HTTP ${response.status}.`,
      response.status,
    );
  }

  if (typeof payload !== "object" || payload === null) {
    throw new PartnerApiError(
      "invalid_response",
      "Shopify Partner API returned an invalid response.",
      response.status,
    );
  }

  const errors = "errors" in payload ? errorMessages(payload.errors) : [];

  if (errors.length) {
    throw new PartnerApiError(
      "graphql",
      `Shopify Partner API rejected billing verification: ${errors.join(", ")}`,
      response.status,
    );
  }

  if (!("data" in payload) || !isRecord(payload.data)) {
    throw new PartnerApiError(
      "invalid_response",
      "Shopify Partner API response did not include billing data.",
      response.status,
    );
  }

  if (!("activeSubscription" in payload.data)) {
    throw new PartnerApiError(
      "invalid_response",
      "Shopify Partner API response omitted activeSubscription.",
      response.status,
    );
  }

  return parseActiveSubscription(payload.data.activeSubscription);
}
