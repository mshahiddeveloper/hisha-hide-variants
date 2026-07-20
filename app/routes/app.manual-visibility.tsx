import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  data,
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import {
  MAX_MANUAL_OVERRIDES_PER_TYPE,
  type ManualVisibilityItem,
} from "../manual-visibility";
import { getShopBillingAccess } from "../models/shop-entitlement.server";
import {
  listManualVisibilityOverrides,
  ManualVisibilityValidationError,
  parseManualVisibilitySubmission,
  pruneStaleManualVisibilityOverrides,
  replaceManualVisibilityOverrides,
} from "../models/manual-visibility.server";
import { syncStorefrontSettings } from "../models/shop-settings.server";
import { authenticate } from "../shopify.server";

type PickerItem = {
  resourceGid: string;
  parentProductGid: string | null;
  displayName: string;
  productTitle: string | null;
};

type VisibilityAction = "hide" | "show";

function toPickerItem(item: ManualVisibilityItem): PickerItem {
  return {
    resourceGid: item.resourceGid,
    parentProductGid: item.parentProductGid,
    displayName: item.displayName,
    productTitle: item.productTitle,
  };
}

function uniquePickerItems(items: PickerItem[]) {
  return [...new Map(items.map((item) => [item.resourceGid, item])).values()];
}

function itemIds(items: PickerItem[]) {
  return items.map(({ resourceGid }) => resourceGid);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  let staleCheckError = false;

  try {
    await pruneStaleManualVisibilityOverrides(admin, session.shop);
  } catch (error) {
    staleCheckError = true;
    console.error("Unable to check manual visibility selections", error);
  }

  const selection = await listManualVisibilityOverrides(session.shop);

  return {
    hiddenProducts: selection.hiddenProducts.map(toPickerItem),
    shownProducts: selection.shownProducts.map(toPickerItem),
    hiddenVariants: selection.hiddenVariants.map(toPickerItem),
    shownVariants: selection.shownVariants.map(toPickerItem),
    staleCheckError,
  };
};

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

  let selection: ReturnType<typeof parseManualVisibilitySubmission>;

  try {
    selection = parseManualVisibilitySubmission(await request.formData());
    await replaceManualVisibilityOverrides({
      admin,
      shop: session.shop,
      ...selection,
    });
  } catch (error) {
    console.error("Unable to save manual visibility overrides", error);

    if (error instanceof ManualVisibilityValidationError) {
      return data(
        { ok: false as const, error: error.message },
        { status: 400 },
      );
    }

    return data(
      {
        ok: false as const,
        error: "Manual visibility selections could not be saved. Try again.",
      },
      { status: 500 },
    );
  }

  const savedRuleCount =
    selection.hiddenProductIds.length +
    selection.shownProductIds.length +
    selection.hiddenVariantIds.length +
    selection.shownVariantIds.length;

  try {
    const settings = await prisma.shopSettings.upsert({
      where: { shop: session.shop },
      update: {},
      create: { shop: session.shop },
    });
    await syncStorefrontSettings(admin, settings, billingAccess);
  } catch (error) {
    console.error("Unable to sync manual visibility overrides", error);
    return { ok: true as const, syncPending: true as const, savedRuleCount };
  }

  return { ok: true as const, syncPending: false as const, savedRuleCount };
};

export default function ManualVisibilityPage() {
  const initialSelection = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [hiddenProducts, setHiddenProducts] = useState<PickerItem[]>(
    initialSelection.hiddenProducts,
  );
  const [shownProducts, setShownProducts] = useState<PickerItem[]>(
    initialSelection.shownProducts,
  );
  const [hiddenVariants, setHiddenVariants] = useState<PickerItem[]>(
    initialSelection.hiddenVariants,
  );
  const [shownVariants, setShownVariants] = useState<PickerItem[]>(
    initialSelection.shownVariants,
  );
  const isSaving = navigation.state === "submitting";

  useEffect(() => {
    if (actionData?.ok) {
      shopify.toast.show(
        actionData.syncPending
          ? "Rules saved; theme sync will retry"
          : "Manual visibility saved",
      );
    }
  }, [actionData, shopify]);

  const setProductRules = (action: VisibilityAction, items: PickerItem[]) => {
    const ids = new Set(itemIds(items));

    if (action === "hide") {
      setHiddenProducts(items);
      setShownProducts((current) =>
        current.filter((item) => !ids.has(item.resourceGid)),
      );
    } else {
      setShownProducts(items);
      setHiddenProducts((current) =>
        current.filter((item) => !ids.has(item.resourceGid)),
      );
    }
  };

  const setVariantRules = (action: VisibilityAction, items: PickerItem[]) => {
    const ids = new Set(itemIds(items));

    if (action === "hide") {
      setHiddenVariants(items);
      setShownVariants((current) =>
        current.filter((item) => !ids.has(item.resourceGid)),
      );
    } else {
      setShownVariants(items);
      setHiddenVariants((current) =>
        current.filter((item) => !ids.has(item.resourceGid)),
      );
    }
  };

  const selectProducts = async (action: VisibilityAction) => {
    const currentItems = action === "hide" ? hiddenProducts : shownProducts;
    const selected = await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: MAX_MANUAL_OVERRIDES_PER_TYPE,
      filter: {
        variants: false,
        draft: false,
        archived: false,
        hidden: false,
      },
      selectionIds: currentItems.map(({ resourceGid }) => ({
        id: resourceGid,
      })),
    });

    if (!selected) return;

    setProductRules(
      action,
      selected.flatMap((product) =>
        product.id
          ? [
              {
                resourceGid: product.id,
                parentProductGid: null,
                displayName: product.title ?? "Untitled product",
                productTitle: null,
              },
            ]
          : [],
      ),
    );
  };

  const selectVariants = async (action: VisibilityAction) => {
    const currentItems = action === "hide" ? hiddenVariants : shownVariants;
    const variantsByProduct = new Map<string, string[]>();

    for (const variant of currentItems) {
      if (!variant.parentProductGid) continue;

      const productVariants =
        variantsByProduct.get(variant.parentProductGid) ?? [];
      productVariants.push(variant.resourceGid);
      variantsByProduct.set(variant.parentProductGid, productVariants);
    }

    const selected = await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: MAX_MANUAL_OVERRIDES_PER_TYPE,
      filter: {
        variants: true,
        draft: false,
        archived: false,
        hidden: false,
      },
      selectionIds: [...variantsByProduct.entries()].map(
        ([productId, variantIds]) => ({
          id: productId,
          variants: variantIds.map((id) => ({ id })),
        }),
      ),
    });

    if (!selected) return;

    setVariantRules(
      action,
      uniquePickerItems(
        selected.flatMap((product) =>
          (product.variants ?? []).flatMap((variant) => {
            if (!variant.id || !product.id) return [];

            return [
              {
                resourceGid: variant.id,
                parentProductGid: product.id,
                displayName: variant.title ?? "Untitled variant",
                productTitle: product.title ?? "Untitled product",
              },
            ];
          }),
        ),
      ),
    );
  };

  const removeProductRule = (action: VisibilityAction, resourceGid: string) => {
    if (action === "hide") {
      setHiddenProducts((items) =>
        items.filter((item) => item.resourceGid !== resourceGid),
      );
    } else {
      setShownProducts((items) =>
        items.filter((item) => item.resourceGid !== resourceGid),
      );
    }
  };

  const removeVariantRule = (action: VisibilityAction, resourceGid: string) => {
    if (action === "hide") {
      setHiddenVariants((items) =>
        items.filter((item) => item.resourceGid !== resourceGid),
      );
    } else {
      setShownVariants((items) =>
        items.filter((item) => item.resourceGid !== resourceGid),
      );
    }
  };

  const renderProductRules = (
    action: VisibilityAction,
    items: PickerItem[],
  ) => (
    <s-stack direction="block" gap="base">
      <s-button
        type="button"
        variant="secondary"
        onClick={() => selectProducts(action)}
      >
        {action === "hide"
          ? "Select products to hide"
          : "Select products to always show"}
      </s-button>
      {items.length === 0 ? (
        <s-paragraph>No products selected.</s-paragraph>
      ) : (
        <s-stack direction="block" gap="small">
          {items.map((product) => (
            <s-stack
              key={product.resourceGid}
              direction="inline"
              gap="base"
              alignItems="center"
            >
              <s-paragraph>{product.displayName}</s-paragraph>
              <s-button
                type="button"
                variant="tertiary"
                onClick={() => removeProductRule(action, product.resourceGid)}
              >
                Remove
              </s-button>
            </s-stack>
          ))}
        </s-stack>
      )}
      <s-paragraph>{items.length} of 100 selected</s-paragraph>
    </s-stack>
  );

  const renderVariantRules = (
    action: VisibilityAction,
    items: PickerItem[],
  ) => (
    <s-stack direction="block" gap="base">
      <s-button
        type="button"
        variant="secondary"
        onClick={() => selectVariants(action)}
      >
        {action === "hide"
          ? "Choose variants to hide"
          : "Choose variants to always show"}
      </s-button>
      {items.length === 0 ? (
        <s-paragraph>No variants selected.</s-paragraph>
      ) : (
        <s-stack direction="block" gap="small">
          {items.map((variant) => (
            <s-stack
              key={variant.resourceGid}
              direction="inline"
              gap="base"
              alignItems="center"
            >
              <s-paragraph>
                {variant.productTitle
                  ? `${variant.productTitle} - ${variant.displayName}`
                  : variant.displayName}
              </s-paragraph>
              <s-button
                type="button"
                variant="tertiary"
                onClick={() => removeVariantRule(action, variant.resourceGid)}
              >
                Remove
              </s-button>
            </s-stack>
          ))}
        </s-stack>
      )}
      <s-paragraph>{items.length} of 100 selected</s-paragraph>
    </s-stack>
  );

  return (
    <s-page heading="Manual storefront visibility">
      <Form method="post">
        <input
          type="hidden"
          name="hiddenProductIds"
          value={JSON.stringify(itemIds(hiddenProducts))}
        />
        <input
          type="hidden"
          name="shownProductIds"
          value={JSON.stringify(itemIds(shownProducts))}
        />
        <input
          type="hidden"
          name="hiddenVariantIds"
          value={JSON.stringify(itemIds(hiddenVariants))}
        />
        <input
          type="hidden"
          name="shownVariantIds"
          value={JSON.stringify(itemIds(shownVariants))}
        />

        <s-stack direction="block" gap="base">
          {initialSelection.staleCheckError ? (
            <s-banner tone="warning" heading="Selections could not be checked">
              <s-paragraph>
                Existing selections are shown, but HiSha could not confirm
                whether every product and variant still exists. Save changes to
                check again.
              </s-paragraph>
            </s-banner>
          ) : null}
          {actionData && !actionData.ok ? (
            <s-banner tone="critical" heading="Could not save selections">
              <s-paragraph>{actionData.error}</s-paragraph>
            </s-banner>
          ) : null}
          {actionData?.ok && actionData.syncPending ? (
            <s-banner tone="warning" heading="Rules saved">
              <s-paragraph>
                {actionData.savedRuleCount} rule(s) were saved. Storefront
                synchronization is pending and will retry when the app is opened
                again.
              </s-paragraph>
            </s-banner>
          ) : null}
          {actionData?.ok && !actionData.syncPending ? (
            <s-banner tone="success" heading="Storefront rules saved">
              <s-paragraph>
                {actionData.savedRuleCount} rule(s) are now configured for the
                storefront.
              </s-paragraph>
            </s-banner>
          ) : null}

          <s-section heading="Hide selected products">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Hide these products on the storefront, regardless of inventory.
                They remain active in Shopify Admin.
              </s-paragraph>
              {renderProductRules("hide", hiddenProducts)}
            </s-stack>
          </s-section>

          <s-section heading="Always show selected products">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                These products remain visible even when the global fully
                sold-out product setting is enabled.
              </s-paragraph>
              {renderProductRules("show", shownProducts)}
            </s-stack>
          </s-section>

          <s-section heading="Hide selected variants">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Choose a product, expand it in Shopify&apos;s picker, and select
                only the variants that should be hidden.
              </s-paragraph>
              {renderVariantRules("hide", hiddenVariants)}
            </s-stack>
          </s-section>

          <s-section heading="Always show selected variants">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                These variants remain visible even when Hide sold-out variants
                is enabled. An Always show rule takes priority over a Hide rule.
              </s-paragraph>
              {renderVariantRules("show", shownVariants)}
            </s-stack>
          </s-section>

          <s-section heading="Storefront behavior">
            <s-paragraph>
              Manual rules change storefront presentation only. HiSha does not
              draft, archive, unpublish, or edit Shopify products.
            </s-paragraph>
          </s-section>

          <s-stack direction="inline" gap="base">
            <s-button href="/app" variant="secondary">
              Back to settings
            </s-button>
            <s-button
              type="submit"
              variant="primary"
              {...(isSaving ? { loading: true } : {})}
            >
              Save manual visibility
            </s-button>
          </s-stack>
          <s-button
            slot="primary-action"
            type="submit"
            variant="primary"
            {...(isSaving ? { loading: true } : {})}
          >
            Save manual visibility
          </s-button>
        </s-stack>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
