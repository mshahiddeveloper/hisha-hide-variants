# Deploy HiSha On Your Own Server

This deployment runs the HiSha web app, PostgreSQL database, and HTTPS proxy on one Ubuntu server. It does not require Render, Neon, or another app-hosting provider.

## Server requirements

- Ubuntu 22.04 or 24.04 VPS with a public IPv4 address
- At least 2 GB RAM, 2 CPU cores, and 20 GB disk
- Ports 80 and 443 open in the server firewall and hosting-provider firewall
- DNS A record: `app.codexinc.com` to the server IPv4 address

## Install Docker

Run these commands on the server as a sudo-enabled user:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Sign out and back in after the final command.

## Download the private repository

Configure a GitHub deploy key or a fine-grained GitHub token with read-only access to `mshahiddeveloper/hisha-hide-variants`. Do not put that token in this repository.

```bash
git clone https://github.com/mshahiddeveloper/hisha-hide-variants.git
cd hisha-hide-variants
```

## Create the production environment file

```bash
cp .env.production.example .env.production
chmod 600 .env.production
openssl rand -hex 32
```

Use a separate generated hexadecimal value for `POSTGRES_PASSWORD` and `HISHA_RECONCILIATION_SECRET`. Set `DATABASE_URL` to the same database password:

```text
DATABASE_URL=postgresql://hisha:THE_SAME_POSTGRES_PASSWORD@postgres:5432/hisha?schema=public
```

Set the Shopify and Partner API values only in `.env.production`. Do not commit this file or send it in chat.

## Start HiSha

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up --build -d
docker compose --env-file .env.production -f docker-compose.production.yml ps
curl -I https://app.codexinc.com/healthz
```

The health endpoint must return HTTP 200 before connecting the app in Shopify.

## Update HiSha

```bash
git pull --ff-only
docker compose --env-file .env.production -f docker-compose.production.yml up --build -d
```

## Backup

Create a daily server backup that includes the Docker volume `hisha-hide-variants_hisha_postgres_data`. Test restoring a backup before submitting the Shopify App Store listing.
