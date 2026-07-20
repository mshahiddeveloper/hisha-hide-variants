import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";

import { reconcileStorefrontEntitlements } from "../models/entitlement-reconciliation.server";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 100;

function isAuthorized(request: Request) {
  const expected = process.env.HISHA_RECONCILIATION_SECRET?.trim();
  const authorization = request.headers.get("authorization");
  const received = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (!expected || !received) return false;

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);

  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function batchSize(request: Request) {
  const value = Number(new URL(request.url).searchParams.get("limit"));

  if (!Number.isInteger(value) || value < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(value, MAX_BATCH_SIZE);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  if (!process.env.HISHA_RECONCILIATION_SECRET?.trim()) {
    console.error("HISHA_RECONCILIATION_SECRET is not configured.");
    return new Response("Reconciliation is unavailable", { status: 503 });
  }

  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const summary = await reconcileStorefrontEntitlements(batchSize(request));
    return Response.json(summary);
  } catch (error) {
    console.error("Storefront entitlement reconciliation failed", error);
    return new Response("Reconciliation failed", { status: 500 });
  }
};
