import type { HeadersFunction } from "react-router";
import { useOutletContext } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import type { AppOutletContext } from "../app-context";

function formatDate(value: string | null) {
  if (!value) return null;

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function Welcome() {
  const { billingAccess, themeSyncError: storefrontSyncError } =
    useOutletContext<AppOutletContext>();
  const trialEndsAt = formatDate(billingAccess.trialEndsAt);

  return (
    <s-page heading="Plan status">
      <s-stack direction="block" gap="base">
        {billingAccess.state === "subscribed" ? (
          <s-banner tone="success" heading="Plan confirmed">
            <s-paragraph>
              {trialEndsAt
                ? `Your free trial is active until ${trialEndsAt}.`
                : "Your Shopify subscription is active."}
            </s-paragraph>
          </s-banner>
        ) : null}

        {billingAccess.state === "development_bypass" ? (
          <s-banner tone="warning" heading="Development access">
            <s-paragraph>
              This allowlisted development store is using the explicit local
              billing bypass. Production always fails closed.
            </s-paragraph>
          </s-banner>
        ) : null}

        {billingAccess.state === "unsubscribed" ? (
          <s-banner tone="warning" heading="Choose a plan">
            <s-paragraph>
              Shopify has not confirmed an active app subscription yet.
            </s-paragraph>
          </s-banner>
        ) : null}

        {billingAccess.state === "verification_stale" ? (
          <s-banner tone="warning" heading="Plan verification is delayed">
            <s-paragraph>
              Shopify billing is temporarily unavailable. HiSha is using the
              last verified plan status until it can check again.
            </s-paragraph>
          </s-banner>
        ) : null}

        {billingAccess.state === "unavailable" ? (
          <s-banner tone="critical" heading="Plan verification unavailable">
            <s-paragraph>
              Shopify billing could not be verified. No paid features have been
              enabled; try again in a moment.
            </s-paragraph>
          </s-banner>
        ) : null}

        {storefrontSyncError && billingAccess.entitled ? (
          <s-banner tone="warning" heading="Theme sync is pending">
            <s-paragraph>
              Your plan is active, but storefront access still needs to sync.
              Open settings to retry.
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-stack direction="inline" gap="base">
          {billingAccess.entitled ? (
            <s-button href="/app" variant="primary">
              Continue to settings
            </s-button>
          ) : null}
          {!billingAccess.entitled && billingAccess.selectorUrl ? (
            <s-button
              href={billingAccess.selectorUrl}
              target="_top"
              variant="primary"
            >
              View plans
            </s-button>
          ) : null}
          {billingAccess.state === "unavailable" ||
          billingAccess.state === "verification_stale" ? (
            <s-button href="/app/welcome" variant="secondary">
              Retry
            </s-button>
          ) : null}
        </s-stack>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
