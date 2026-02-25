# Lions Creek Rewards — Local Dev + Deployment Runbook (v1.7+)

This runbook is the *repo-local* operational companion to the architecture/requirements docs.

## Canonical ports

- **SSR app server:** `PORT=3000` (Node/React Router SSR)
- **Vite dev UI:** `FRONTEND_PORT=8002` (default in `vite.config.ts`)

Your nginx reverse proxy and the systemd expiry job **must** point at the same SSR port (`3000`).

## Local development (Windows 11 + PowerShell)

### Prereqs

- Node.js `>= 20.19`
- Shopify CLI installed and logged in

### Clean install + first run

```powershell
cd <repo>

# deterministic install
npm ci

# prisma: generate + migrate-deploy (if migrations exist) OR db push (if not)
npm run setup

# start dev (CLI-managed tunnel)
shopify app dev --store <your-dev-store>
```

### **Rule: do not tunnel directly to the app port**

Do **not** run a custom tunnel (Cloudflare/ngrok/etc.) that points at `localhost:3000` during development.

Use **`shopify app dev`** so the CLI can:

- create the correct preview/tunnel URLs
- expose the Dev Console at the expected path
- wire the embedded app + extensions correctly

If you must bring your own tunnel, use Shopify’s “bring your own tunnel URL” workflow and ensure the **CLI** still owns the preview plumbing.

## Customer account navigation (mandated)

### What Shopify supports (the “real” menu link)

A full-page customer account extension (`customer-account.page.render`) is **linkable by default**.

In production, the merchant should add the Rewards page to the **Customer account menu** in Shopify admin (Customer Accounts extensibility). This is the canonical “menu navigation” path.

In production, do this once per store:

1) Shopify admin → **Checkout and accounts** (or **Settings → Customer accounts**, depending on admin UI)
2) Open the **Customer accounts editor / customization**
3) In the **Menu** editor, **Add link** → choose the app page for **“Lions Creek Rewards”**
4) Save/publish the customer accounts customization

(Full-page extensions are linkable by default unless you set `allow_direct_linking = false`.)

### Why there is also a footer link in this repo

Shopify full-page targets can’t coexist with other targets in the *same extension*, so the Rewards dashboard remains isolated as:

- `extensions/lcr-loyalty-dashboard` → `customer-account.page.render`

To reduce support friction (stores that forget to add the menu item), this repo includes a **separate** customer account UI extension that renders a persistent link:

- `extensions/lcr-loyalty-nav` → `customer-account.footer.render-after`

This footer link navigates to:

- `extension:lcr-loyalty-dashboard/`


## Production deployment (Lightsail Ubuntu + nginx)

### 1) nginx reverse proxy

Use the sample vhost:

- `deploy/nginx/lions-creek-rewards.conf`

Key requirement:

- `proxy_pass http://127.0.0.1:3000;`

### 2) systemd service

Use:

- `deploy/systemd/lions-creek-rewards.service`

### 3) daily expiry job (systemd timer)

Use:

- `deploy/systemd/lions-creek-rewards-expire.service`
- `deploy/systemd/lions-creek-rewards-expire.timer`

The expiry service calls:

- `http://127.0.0.1:3000/jobs/expire?...`

### 4) deploy script (git-based)

Server-side helper:

- `scripts/Server_Git_Code_Deploy.sh`

It enforces deterministic installs (`npm ci` when lockfile exists) and applies Prisma schema using:

- `prisma migrate deploy` when real migrations exist
- otherwise `prisma db push`
