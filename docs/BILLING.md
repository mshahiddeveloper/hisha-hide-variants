# Shopify App Pricing

HiSha uses Shopify App Pricing for public distribution. Pricing is configured
in the Partner Dashboard, not in application source code.

## Plan setup

Create one public monthly plan with these settings:

- Monthly charge: US$15.99.
- Free trial duration: 3 days.
- Welcome link: `/app/welcome`.
- Description: disclose `3-day free trial, then US$15.99/month`.

The merchant approves the recurring subscription before the trial starts.
Shopify handles the trial and starts recurring billing after it ends.

For development, use a private test plan authorized for the development store,
or an owned development store where Shopify doesn't create a real charge.

## Server configuration

Configure these values in the hosting provider's server-side secret manager:

| Variable                           | Purpose                                                     | Secret |
| ---------------------------------- | ----------------------------------------------------------- | ------ |
| `SHOPIFY_PARTNER_ORG_ID`           | Partner organization ID from the Dashboard URL              | No     |
| `SHOPIFY_PARTNER_API_ACCESS_TOKEN` | Partner API client token with only `Manage apps` permission | Yes    |
| `SHOPIFY_APP_GID`                  | App ID in `gid://shopify/App/<id>` format                   | No     |
| `SHOPIFY_APP_HANDLE`               | Stable App Home handle used by Shopify's hosted pricing URL | No     |
| `SHOPIFY_PARTNER_API_VERSION`      | Optional pinned Partner API version; defaults to `2026-07`  | No     |
| `SHOPIFY_BILLING_DEV_BYPASS`       | Set to `true` only for explicit local billing bypass        | No     |
| `SHOPIFY_BILLING_DEV_STORES`       | Comma-separated allowlist of development store domains      | No     |
| `HISHA_RECONCILIATION_SECRET`      | Secret that authorizes the production reconciliation job    | Yes    |

Never expose the Partner API token to browser code, store it in Prisma, print it
to logs, or commit it. This repository intentionally doesn't include an `.env`
example because project policy excludes all `.env` files.

## Runtime behavior

- A valid non-null Partner API `activeSubscription` grants access, including
  during a trial when `currentBillingCycle` is null.
- A confirmed null subscription redirects to Shopify's hosted plan selector.
- Configuration, timeout, network, HTTP, GraphQL, and malformed-response errors
  are distinct from an unsubscribed merchant and fail closed in production.
- After a successful verification, a temporary Partner API failure uses the
  last verified status for up to 24 hours and shows a warning in the admin.
  The storefront lease is never extended by that fallback, so storefront access
  still fails closed 30 minutes after its last successful verification.
- Missing billing values fail closed by default. Local bypass requires both
  `SHOPIFY_BILLING_DEV_BYPASS=true` and the authenticated shop in
  `SHOPIFY_BILLING_DEV_STORES`. Production ignores the bypass and always fails
  closed when billing configuration is incomplete.
- The `plan_handle` welcome parameter is never trusted for entitlement. The
  welcome route force-checks the Partner API before enabling the storefront.
- Storefront metafields carry a 30-minute `entitlementValidUntil` lease derived
  from the last successful Partner API check. Failed checks never extend it;
  the storefront must fail closed after it expires.

Shopify App Pricing doesn't send subscription-update webhooks. Before launch,
configure the hosting provider to POST every five minutes to:

```text
https://YOUR_PRODUCTION_APP_URL/tasks/reconcile-entitlements?limit=100
```

Send `Authorization: Bearer <HISHA_RECONCILIATION_SECRET>`. The endpoint uses
the stored offline Shopify session, verifies each plan through the Partner API,
and refreshes the app-data metafield. Batches rotate through all installed shops
and should not overlap. A canceled or frozen plan is disabled on the next run;
if the job fails entirely, the existing 30-minute storefront lease expires.

No additional merchant OAuth scopes are required. Keep the app scopes at
`read_products,read_inventory`.

For a local PowerShell session, opt in without writing an `.env` file:

```powershell
$env:SHOPIFY_BILLING_DEV_BYPASS = 'true'
$env:SHOPIFY_BILLING_DEV_STORES = 'your-development-store.myshopify.com'
```
