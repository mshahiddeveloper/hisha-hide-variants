import type { ActionFunctionArgs } from "react-router";

import { deleteManualVisibilityOverridesForProduct } from "../models/manual-visibility.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  const productId =
    typeof payload === "object" && payload !== null && "id" in payload
      ? String(payload.id ?? "")
      : "";

  if (!/^\d+$/.test(productId)) {
    console.error(`Received ${topic} with an invalid product ID for ${shop}`);
    return new Response("Invalid product ID", { status: 400 });
  }

  await deleteManualVisibilityOverridesForProduct(shop, productId);
  return new Response();
};
