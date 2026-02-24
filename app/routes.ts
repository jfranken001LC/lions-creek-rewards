import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

export default [
  // Public
  index("routes/_index/route.tsx"),
  route("auth/*", "routes/auth.$.tsx"),
  route("auth/login", "routes/auth.login/route.tsx"),

  // Shopify webhooks (admin)
  route("webhooks", "routes/webhooks.tsx"),

  // Customer-account UI extension endpoints
  route("api/customer/loyalty", "routes/api.customer.loyalty.tsx"),
  route("api/customer/redeem", "routes/api.customer.redeem.tsx"),

  // Signed app-proxy JSON endpoint (optional)
  route("loyalty.json", "routes/loyalty.json.tsx"),

  // Legacy/demo page (optional)
  route("loyalty", "routes/loyalty.tsx"),

  // Static pages
  route("privacy", "routes/privacy.tsx"),
  route("support", "routes/support.tsx"),
  route("terms", "routes/terms.tsx"),

  // Scheduled jobs
  route("jobs/expire", "routes/jobs.expire.tsx"),

  // Embedded admin UI
  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
    route("customers", "routes/app.customers.tsx"),
    route("redemptions", "routes/app.redemptions.tsx"),
    route("reports", "routes/app.reports.tsx"),
    route("settings", "routes/app.settings.tsx"),
    route("webhooks", "routes/app.webhooks.tsx"),
  ]),
] satisfies RouteConfig;
