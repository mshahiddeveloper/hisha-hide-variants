import type { ActionFunctionArgs } from "react-router";
import { deleteShopData } from "../models/shop-data.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      // HiSha does not collect or store customer data.
      return new Response();
    case "SHOP_REDACT":
      await deleteShopData(shop);

      return new Response();
    default:
      console.warn(`Received unsupported compliance webhook topic ${topic}`);
      return new Response("Unsupported webhook topic", { status: 400 });
  }
};
