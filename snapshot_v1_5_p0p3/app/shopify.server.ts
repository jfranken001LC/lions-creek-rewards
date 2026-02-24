import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { DeliveryMethod } from "@shopify/shopify-api";
import prisma from "./db.server";

/**
 * Shopify App Server (React Router SSR)
 *
 * v1.4 requirement alignment:
 * - Explicit webhook subscription declarations so `registerWebhooks()` reliably registers topics
 * - Webhook callbackUrl must match `app/routes/webhooks.tsx` and `shopify.web.toml` `webhooks_path`
 */
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  webhooks: {
    // Core loyalty lifecycle
    ORDERS_PAID: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks" },
    REFUNDS_CREATE: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks" },
    ORDERS_CANCELLED: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks" },

    // Shopify-required privacy topics (GDPR)
    CUSTOMERS_DATA_REQUEST: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks" },
    CUSTOMERS_REDACT: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks" },
    SHOP_REDACT: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks" },

    // Operational hygiene
    APP_UNINSTALLED: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks" },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;

export const apiVersion = ApiVersion.July25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
