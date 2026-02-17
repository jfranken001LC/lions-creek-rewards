// File: app/routes.ts

import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  // Root
  index("./routes/_index.tsx"),

  // Auth + Shopify callbacks
  route("auth/*", "./routes/auth.$.tsx"),

  // Incoming webhooks endpoint
  route("webhooks", "./routes/webhooks.tsx"),

  // Customer Accounts extension API (session-token authenticated)
  route("api/customer/loyalty", "./routes/api.customer.loyalty.tsx"),
  route("api/customer/redeem", "./routes/api.customer.redeem.tsx"),

  // Scheduled jobs
  route("jobs/expire", "./routes/jobs.expire.tsx"),

  // Optional public/app-proxy routes
  route("loyalty.json", "./routes/loyalty.json.tsx"),
  route("loyalty", "./routes/loyalty.tsx"),
  route("support", "./routes/support.tsx"),
  route("privacy", "./routes/privacy.tsx"),
  route("terms", "./routes/terms.tsx"),

  // Embedded Admin app
  route("app", "./routes/app.tsx", [
    index("./routes/app._index.tsx"),

    // Customers
    route("customers", "./routes/app.customers.tsx"),
    route("customers/:customerId", "./routes/app.customers.$customerId.tsx"),
    route(
      "customers/:customerId/transactions",
      "./routes/app.customers.$customerId.transactions.tsx",
    ),
    route(
      "customers/:customerId/adjust",
      "./routes/app.customers.$customerId.adjust.tsx",
    ),

    // Redemptions
    route("redemptions", "./routes/app.redemptions.tsx"),

    // Settings
    route("settings", "./routes/app.settings.tsx"),
    route("settings/program", "./routes/app.settings.program.tsx"),
    route("settings/rewards", "./routes/app.settings.rewards.tsx"),

    // Webhooks admin views
    route("webhooks", "./routes/app.webhooks.tsx"),
    route("webhooks/:webhookId", "./routes/app.webhooks.$webhookId.tsx"),
  ]),
] satisfies RouteConfig;
