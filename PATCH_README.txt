Lions Creek Rewards – Patch Pack (spec alignment)

This zip contains full-file replacements and a few new deployment templates.

Changed / added
- app/shopify.server.ts
  - Adds explicit webhook declarations so registerWebhooks() reliably subscribes to topics.
- app/routes/webhooks.tsx
  - Handles app/uninstalled topic with shop-scoped cleanup.
- scripts/prisma-apply.mjs (NEW)
  - Cross-platform Prisma apply helper (migrate deploy if migrations exist, else db push).
- package.json
  - setup now runs prisma-apply; adds prisma:apply and prisma:generate helpers.
- shopify.web.toml
  - Uses prisma-apply for deterministic local dev.
- scripts/Server_Git_Code_Deploy.sh
  - Uses conditional migrate deploy vs db push per v1.4 runbook.
- .eslintrc.cjs
  - Replaced invalid contents with a real ESLint config.

Deployment templates (optional)
- deploy/nginx/lions-creek-rewards.conf
- deploy/systemd/*.service, *.timer

How to apply
1) Unzip at repo root.
2) Overwrite files when prompted.
3) Run:
   npm install
   npm run setup
   npm run build

Local dev
- shopify app dev

Server deploy
- scripts/Server_Git_Code_Deploy.sh
