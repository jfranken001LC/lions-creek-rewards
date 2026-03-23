# Lions Creek Rewards

Lions Creek Rewards is a public Shopify loyalty app for Shopify Basic and customer accounts.

It provides:

- points earning on paid orders
- refund and cancellation reversals
- customer account Rewards page and footer link
- cart redemption via App Proxy + theme app extension
- Thank you and Order Status rewards messaging
- named tiers with configurable thresholds and earn rates
- optional historical backfill from `/app/setup`
- scheduled expiry across all installed shops

## Runtime model

- **Local development (Windows 11 / PowerShell):** Shopify CLI manages preview and tunnelling
- **App web port in local dev:** `3010` from `shopify.web.toml`
- **Production (AWS Lightsail Ubuntu + nginx):** Node SSR on `PORT=3000`, reverse proxied by nginx
- **Persistence:** Prisma + SQLite

Do not tunnel directly to the app web port during development. Use `shopify app dev` so the CLI can serve the preview proxy and extension console correctly.

## Requirements

- Node.js `>= 20.19`
- npm
- Shopify CLI
- a development store for preview testing

## Local development on Windows 11 (PowerShell)

```powershell
cd <repo>

npm ci
npm run setup
shopify app dev --store <your-dev-store> --reset
```

### Local dev rules

- Let Shopify CLI manage the tunnel and preview URL.
- Do not point Cloudflare or ngrok directly at `localhost:3010`.
- Use `npm run setup` after schema changes; it applies Prisma schema correctly whether migrations exist or not.

## Core admin pages

- `/app/settings` - earn rules, exclusions, redemption steps, and tiers
- `/app/setup` - optional historical backfill configuration and one-shot rebuild
- `/app/customers`
- `/app/redemptions`
- `/app/reports`
- `/app/webhooks`
- `/app/support`

## Historical backfill

Use `/app/setup` when you want to rebuild balances and tier standing from past orders.

The setup flow lets the merchant:

- choose a historical start date
- save whether historical backfill is enabled for the shop
- run a one-shot retroactive rebuild from that start date through today
- review the latest stored run status and summary

If the chosen start date is older than Shopify's standard recent-order window, the app needs `read_all_orders` in addition to `read_orders`. After that scope change, re-authorize or reinstall the app before running the backfill.

## Production deployment on Lightsail + nginx

### 1) Prepare the server

- clone the repo to `/var/www/lions-creek-rewards`
- create `/etc/lions-creek-rewards/lions-creek-rewards.env` from `other/deploy_samples/env/lions-creek-rewards.env.example`
- ensure the data directory exists and is writable by the app service user

### 2) Install nginx config

Use:

- `deploy/nginx/lions-creek-rewards.conf`

This config proxies public traffic to `127.0.0.1:3000` and blocks `/jobs/` from public access.

### 3) Install systemd units

Use:

- `deploy/systemd/lions-creek-rewards.service`
- `deploy/systemd/lions-creek-rewards-expire.service`
- `deploy/systemd/lions-creek-rewards-expire.timer`

### 4) Deploy code

Use the helper script:

```bash
bash scripts/Server_Git_Code_Deploy.sh
```

The script:

- fetches the selected branch
- performs a clean install with `npm ci` when possible
- runs Prisma generate plus `migrate deploy` or `db push`, depending on what exists
- builds the SSR bundle
- restarts the systemd service

### 5) Enable the expiry scheduler

```bash
sudo systemctl enable --now lions-creek-rewards-expire.timer
sudo systemctl list-timers --all | grep lions-creek-rewards
```

The timer calls `GET /jobs/expire?all=1` locally with `x-job-token`, so expiry runs across all installed shops.

## Customer account navigation

The Rewards page supports direct linking. Merchants should add it to the customer account menu in Shopify admin.

A footer link extension is also included as a fallback so the page remains discoverable even if the merchant forgets to add the menu link.

## Clean source distribution

This repository should be distributed without:

- `.shopify/`
- `build/`
- extension `dist/` bundles
- local databases such as `prisma/dev.sqlite`
- editor-specific folders

Rebuild generated artifacts locally or on the server instead of shipping stale build output.
