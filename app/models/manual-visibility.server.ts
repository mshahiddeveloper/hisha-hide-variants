import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import {
  MAX_MANUAL_OVERRIDES_PER_TYPE,
  type ManualVisibilityItem,
} from "../manual-visibility";

export const MANUAL_RESOURCE_TYPES = {
  product: "PRODUCT",
  variant: "VARIANT",
} as const;

export const MANUAL_VISIBILITY_ACTIONS = {
  hide: "HIDE",
  show: "SHOW",
} as const;

type ManualVisibilityAction =
  (typeof MANUAL_VISIBILITY_ACTIONS)[keyof typeof MANUAL_VISIBILITY_ACTIONS];

export type ManualVisibilitySelection = {
  hiddenProducts: ManualVisibilityItem[];
  shownProducts: ManualVisibilityItem[];
  hiddenVariants: ManualVisibilityItem[];
  shownVariants: ManualVisibilityItem[];
};

export type StorefrontManualVisibility = {
  manualHiddenProductIds: string[];
  manualShownProductIds: string[];
  manualHiddenVariantIds: string[];
  manualShownVariantIds: string[];
};

type ValidatedNode =
  | {
      __typename: "Product";
      id: string;
      legacyResourceId: string;
      title: string;
    }
  | {
      __typename: "ProductVariant";
      id: string;
      legacyResourceId: string;
      title: string;
      displayName: string;
      product: { id: string; title: string };
    };

type NodesResponse = {
  data?: { nodes?: Array<ValidatedNode | null> };
  errors?: Array<{ message: string }>;
};

export class ManualVisibilityValidationError extends Error {}

const productGidPattern = /^gid:\/\/shopify\/Product\/(\d+)$/;
const variantGidPattern = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/;

function uniqueIds(value: unknown, pattern: RegExp, fieldName: string) {
  if (!Array.isArray(value)) {
    throw new ManualVisibilityValidationError(`${fieldName} must be a list.`);
  }

  const ids = [...new Set(value)];

  if (
    ids.length > MAX_MANUAL_OVERRIDES_PER_TYPE ||
    ids.some((id) => typeof id !== "string" || !pattern.test(id))
  ) {
    throw new ManualVisibilityValidationError(
      `${fieldName} contains an invalid selection.`,
    );
  }

  return ids as string[];
}

function rejectConflicts(
  hiddenIds: string[],
  shownIds: string[],
  label: string,
) {
  const shown = new Set(shownIds);

  if (hiddenIds.some((id) => shown.has(id))) {
    throw new ManualVisibilityValidationError(
      `A ${label} cannot be set to both hide and always show.`,
    );
  }
}

function graphQlErrors(errors?: Array<{ message: string }>) {
  return errors?.map(({ message }) => message).join(", ");
}

export function parseManualVisibilitySubmission(formData: FormData) {
  let hiddenProductIds: unknown;
  let shownProductIds: unknown;
  let hiddenVariantIds: unknown;
  let shownVariantIds: unknown;

  try {
    hiddenProductIds = JSON.parse(
      String(formData.get("hiddenProductIds") ?? "[]"),
    );
    shownProductIds = JSON.parse(
      String(formData.get("shownProductIds") ?? "[]"),
    );
    hiddenVariantIds = JSON.parse(
      String(formData.get("hiddenVariantIds") ?? "[]"),
    );
    shownVariantIds = JSON.parse(
      String(formData.get("shownVariantIds") ?? "[]"),
    );
  } catch {
    throw new ManualVisibilityValidationError(
      "The selected products or variants could not be read.",
    );
  }

  const selection = {
    hiddenProductIds: uniqueIds(
      hiddenProductIds,
      productGidPattern,
      "Products to hide",
    ),
    shownProductIds: uniqueIds(
      shownProductIds,
      productGidPattern,
      "Products to show",
    ),
    hiddenVariantIds: uniqueIds(
      hiddenVariantIds,
      variantGidPattern,
      "Variants to hide",
    ),
    shownVariantIds: uniqueIds(
      shownVariantIds,
      variantGidPattern,
      "Variants to show",
    ),
  };

  rejectConflicts(
    selection.hiddenProductIds,
    selection.shownProductIds,
    "product",
  );
  rejectConflicts(
    selection.hiddenVariantIds,
    selection.shownVariantIds,
    "variant",
  );

  return selection;
}

async function validateShopResources(
  admin: AdminApiContext,
  productIds: string[],
  variantIds: string[],
) {
  const requestedIds = [...productIds, ...variantIds];

  if (requestedIds.length === 0) return [];

  const nodes = await queryShopResources(admin, requestedIds);

  if (nodes.includes(null)) {
    throw new ManualVisibilityValidationError(
      "One or more selections do not belong to this shop or no longer exist.",
    );
  }

  const products = new Set(productIds);
  const variants = new Set(variantIds);

  for (const node of nodes) {
    if (!node) continue;

    if (
      (products.has(node.id) && node.__typename !== "Product") ||
      (variants.has(node.id) && node.__typename !== "ProductVariant") ||
      !/^\d+$/.test(String(node.legacyResourceId))
    ) {
      throw new ManualVisibilityValidationError(
        "A selected Shopify resource has the wrong type.",
      );
    }
  }

  return nodes as ValidatedNode[];
}

async function queryShopResources(
  admin: AdminApiContext,
  requestedIds: string[],
) {
  if (requestedIds.length === 0) return [];

  const response = await admin.graphql(
    `#graphql
      query HiShaValidateManualVisibility($ids: [ID!]!) {
        nodes(ids: $ids) {
          __typename
          ... on Product {
            id
            legacyResourceId
            title
          }
          ... on ProductVariant {
            id
            legacyResourceId
            title
            displayName
            product {
              id
              title
            }
          }
        }
      }
    `,
    { variables: { ids: requestedIds } },
  );
  const body = (await response.json()) as NodesResponse;

  if (body.errors?.length) {
    throw new Error(
      graphQlErrors(body.errors) || "Shopify resources could not be verified.",
    );
  }

  const nodes = body.data?.nodes;

  if (!nodes || nodes.length !== requestedIds.length) {
    throw new Error(
      "Shopify returned an invalid resource validation response.",
    );
  }

  return nodes;
}

export async function replaceManualVisibilityOverrides({
  admin,
  shop,
  hiddenProductIds,
  shownProductIds,
  hiddenVariantIds,
  shownVariantIds,
}: {
  admin: AdminApiContext;
  shop: string;
  hiddenProductIds: string[];
  shownProductIds: string[];
  hiddenVariantIds: string[];
  shownVariantIds: string[];
}) {
  const productActions = new Map<string, ManualVisibilityAction>([
    ...hiddenProductIds.map(
      (id) => [id, MANUAL_VISIBILITY_ACTIONS.hide] as const,
    ),
    ...shownProductIds.map(
      (id) => [id, MANUAL_VISIBILITY_ACTIONS.show] as const,
    ),
  ]);
  const variantActions = new Map<string, ManualVisibilityAction>([
    ...hiddenVariantIds.map(
      (id) => [id, MANUAL_VISIBILITY_ACTIONS.hide] as const,
    ),
    ...shownVariantIds.map(
      (id) => [id, MANUAL_VISIBILITY_ACTIONS.show] as const,
    ),
  ]);
  const nodes = await validateShopResources(
    admin,
    [...productActions.keys()],
    [...variantActions.keys()],
  );
  const rows = nodes.map((node) => {
    if (node.__typename === "Product") {
      return {
        shop,
        resourceType: MANUAL_RESOURCE_TYPES.product,
        visibilityAction: productActions.get(node.id)!,
        resourceGid: node.id,
        legacyResourceId: String(node.legacyResourceId),
        parentProductGid: null,
        displayName: node.title,
        productTitle: null,
      };
    }

    return {
      shop,
      resourceType: MANUAL_RESOURCE_TYPES.variant,
      visibilityAction: variantActions.get(node.id)!,
      resourceGid: node.id,
      legacyResourceId: String(node.legacyResourceId),
      parentProductGid: node.product.id,
      displayName: node.title,
      productTitle: node.product.title,
    };
  });

  await prisma.$transaction(async (transaction) => {
    await transaction.manualVisibilityOverride.deleteMany({ where: { shop } });

    if (rows.length > 0) {
      await transaction.manualVisibilityOverride.createMany({ data: rows });
    }
  });

  return listManualVisibilityOverrides(shop);
}

export async function listManualVisibilityOverrides(
  shop: string,
): Promise<ManualVisibilitySelection> {
  const rows = await prisma.manualVisibilityOverride.findMany({
    where: { shop },
    orderBy: [{ productTitle: "asc" }, { displayName: "asc" }],
    select: {
      resourceType: true,
      visibilityAction: true,
      resourceGid: true,
      legacyResourceId: true,
      parentProductGid: true,
      displayName: true,
      productTitle: true,
    },
  });
  const selection: ManualVisibilitySelection = {
    hiddenProducts: [],
    shownProducts: [],
    hiddenVariants: [],
    shownVariants: [],
  };

  for (const { resourceType, visibilityAction, ...item } of rows) {
    if (
      visibilityAction !== MANUAL_VISIBILITY_ACTIONS.hide &&
      visibilityAction !== MANUAL_VISIBILITY_ACTIONS.show
    ) {
      continue;
    }

    const visibilityItem: ManualVisibilityItem = { ...item, visibilityAction };

    if (resourceType === MANUAL_RESOURCE_TYPES.product) {
      if (visibilityAction === MANUAL_VISIBILITY_ACTIONS.hide) {
        selection.hiddenProducts.push(visibilityItem);
      } else {
        selection.shownProducts.push(visibilityItem);
      }
    }

    if (resourceType === MANUAL_RESOURCE_TYPES.variant) {
      if (visibilityAction === MANUAL_VISIBILITY_ACTIONS.hide) {
        selection.hiddenVariants.push(visibilityItem);
      } else {
        selection.shownVariants.push(visibilityItem);
      }
    }
  }

  return selection;
}

export async function getStorefrontManualVisibility(
  shop: string,
): Promise<StorefrontManualVisibility> {
  const rows = await prisma.manualVisibilityOverride.findMany({
    where: { shop },
    orderBy: { legacyResourceId: "asc" },
    select: {
      resourceType: true,
      visibilityAction: true,
      legacyResourceId: true,
    },
  });

  const idsFor = (
    resourceType: string,
    visibilityAction: ManualVisibilityAction,
  ) =>
    rows
      .filter(
        (row) =>
          row.resourceType === resourceType &&
          row.visibilityAction === visibilityAction,
      )
      .map(({ legacyResourceId }) => legacyResourceId);

  return {
    manualHiddenProductIds: idsFor(
      MANUAL_RESOURCE_TYPES.product,
      MANUAL_VISIBILITY_ACTIONS.hide,
    ),
    manualShownProductIds: idsFor(
      MANUAL_RESOURCE_TYPES.product,
      MANUAL_VISIBILITY_ACTIONS.show,
    ),
    manualHiddenVariantIds: idsFor(
      MANUAL_RESOURCE_TYPES.variant,
      MANUAL_VISIBILITY_ACTIONS.hide,
    ),
    manualShownVariantIds: idsFor(
      MANUAL_RESOURCE_TYPES.variant,
      MANUAL_VISIBILITY_ACTIONS.show,
    ),
  };
}

export async function pruneStaleManualVisibilityOverrides(
  admin: AdminApiContext,
  shop: string,
) {
  const rows = await prisma.manualVisibilityOverride.findMany({
    where: { shop },
    select: {
      id: true,
      resourceType: true,
      resourceGid: true,
    },
  });

  if (rows.length === 0) return 0;

  const nodes = await queryShopResources(
    admin,
    rows.map(({ resourceGid }) => resourceGid),
  );
  const nodesById = new Map(
    nodes.flatMap((node) => (node ? [[node.id, node] as const] : [])),
  );
  const staleRowIds = rows.flatMap((row) => {
    const node = nodesById.get(row.resourceGid);
    const expectedType =
      row.resourceType === MANUAL_RESOURCE_TYPES.product
        ? "Product"
        : row.resourceType === MANUAL_RESOURCE_TYPES.variant
          ? "ProductVariant"
          : null;

    return !node ||
      !expectedType ||
      node.__typename !== expectedType ||
      !/^\d+$/.test(String(node.legacyResourceId))
      ? [row.id]
      : [];
  });

  if (staleRowIds.length === 0) return 0;

  const result = await prisma.manualVisibilityOverride.deleteMany({
    where: { shop, id: { in: staleRowIds } },
  });

  return result.count;
}

export async function deleteManualVisibilityOverridesForProduct(
  shop: string,
  legacyProductId: string,
) {
  if (!/^\d+$/.test(legacyProductId)) {
    throw new ManualVisibilityValidationError("Invalid Shopify product ID.");
  }

  const productGid = `gid://shopify/Product/${legacyProductId}`;
  const result = await prisma.manualVisibilityOverride.deleteMany({
    where: {
      shop,
      OR: [{ resourceGid: productGid }, { parentProductGid: productGid }],
    },
  });

  return result.count;
}
