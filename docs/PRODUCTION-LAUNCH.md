# HiSha Production Launch

## Required decisions

Before release, provide a permanent HTTPS app URL, a managed PostgreSQL
`DATABASE_URL`, and public URLs for privacy policy, terms, support, and the
developer website. Do not use a temporary Shopify CLI tunnel in production.

Use a domain that does not contain the word `Shopify`.

## Production database

Local development continues to use `prisma/schema.prisma` and SQLite.
Production Docker deployments use `prisma/postgres/schema.prisma` and its
separate initial migration. Supply the PostgreSQL `DATABASE_URL` only through
the hosting provider secret manager. The container runs the production Prisma
migration before starting the React Router server.

## Hosting environment

Set these values in the hosting provider. Do not commit them to this repository
or create a production `.env` file.

| Variable                           | Required value                                 |
| ---------------------------------- | ---------------------------------------------- |
| `NODE_ENV`                         | `production`                                   |
| `PORT`                             | Hosting provider port, normally `3000`         |
| `DATABASE_URL`                     | Managed PostgreSQL connection string           |
| `SHOPIFY_API_KEY`                  | App client ID from Shopify Dev Dashboard       |
| `SHOPIFY_API_SECRET`               | App client secret from Shopify Dev Dashboard   |
| `SHOPIFY_APP_URL`                  | Permanent HTTPS URL, without a trailing slash  |
| `SCOPES`                           | `read_products,read_inventory`                 |
| `SHOPIFY_PARTNER_ORG_ID`           | Partner organization ID                        |
| `SHOPIFY_PARTNER_API_ACCESS_TOKEN` | Partner API token with only Manage apps access |
| `SHOPIFY_APP_GID`                  | `gid://shopify/App/<numeric app id>`           |
| `SHOPIFY_APP_HANDLE`               | Hosted App Pricing handle                      |
| `HISHA_RECONCILIATION_SECRET`      | Strong random secret for the scheduled task    |

Never set `SHOPIFY_BILLING_DEV_BYPASS` or `SHOPIFY_BILLING_DEV_STORES` in
production.

Deploy with the repository Dockerfile. The host health check path is:

```text
https://YOUR_APP_DOMAIN/healthz
```

It must return HTTP 200 and `ok`.

## Shopify configuration release

After the host is live, replace both placeholder URLs in `shopify.app.toml`:

```toml
application_url = "https://YOUR_APP_DOMAIN"

[auth]
redirect_urls = [ "https://YOUR_APP_DOMAIN/auth/callback" ]
```

Then release configuration and the theme app extension:

```powershell
Set-Location D:\ShopifyApps\hisha-hide-variants
& D:\DevTools\npm-global\shopify.cmd app deploy --no-color
```

Do not run this command until the production URL and OAuth callback are live.

## Scheduled billing reconciliation

Configure the host scheduler to run every five minutes, without overlapping
executions:

```text
POST https://YOUR_APP_DOMAIN/tasks/reconcile-entitlements?limit=100
Authorization: Bearer <HISHA_RECONCILIATION_SECRET>
```

This refreshes subscription access and the storefront entitlement lease for
installed shops.

## Partner Dashboard and App Store

1. In the Shopify Dev Dashboard, set the production app URL, OAuth redirect,
   API contact, emergency contact, and compliance webhooks.
2. In Distribution > Shopify App Store listing > Pricing, create one public
   monthly plan: `US$15.99`, three-day free trial, welcome link `/app/welcome`.
   Add the plan display name and feature descriptions in English.
3. Upload `app-store-assets/icon/hisha-app-icon-1200.png`.
4. Add the App Store listing copy from `app-store-assets/README.md`, plus the
   privacy, terms, support, and developer website URLs.
5. Upload feature media and screenshots. Do not include development console,
   browser chrome, personal data, prices, reviews, or Shopify trademarks in
   the media.
6. Create a $0 private test plan and test installation, billing approval,
   app embed activation, autosave, manual Hide/Always show rules, uninstall,
   and the billing reconciliation job on a development store.
7. Complete Shopify automated checks and submit the production app for review.
   Give the reviewer direct setup instructions and a working demo store.
8. Once Shopify approves the listing, select fully visible App Store
   visibility to be indexed in search results.
