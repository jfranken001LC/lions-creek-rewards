// app/shopify.server.ts
import { shopifyApp } from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

export const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  appUrl: process.env.SHOPIFY_APP_URL!,
  scopes: (process.env.SCOPES || process.env.SHOPIFY_SCOPES || "").split(",").filter(Boolean),
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: "app",
  future: {
    // Keep aligned with your codebase’s usage.
    removeRest: true,
    unstable_newEmbeddedAuthStrategy: true,
  },
});

export default shopify;

export const apiVersion = shopify.api.config.apiVersion;

export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
export const unauthenticated = shopify.unauthenticated;
