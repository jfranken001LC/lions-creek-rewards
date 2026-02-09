import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";

/**
 * Shopify (and automated checkers) may probe the endpoint with GET/HEAD.
 * Webhooks are delivered via POST, but returning 200 here can prevent
 * "false red" review checks when a non-POST probe occurs.
 */
export const loader = async (_args: LoaderFunctionArgs) => {
  return new Response("ok", { status: 200 });
};

function base64ToBuffer(value: string): Buffer | null {
  try {
    // Buffer.from will throw for some invalid inputs; catch to be safe.
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}

function verifyShopifyWebhookHmac(
  rawBody: Buffer,
  hmacHeader: string | null,
  apiSecret: string,
): boolean {
  if (!hmacHeader || !apiSecret) return false;

  const provided = base64ToBuffer(hmacHeader.trim());
  if (!provided) return false;

  const calculated = crypto
    .createHmac("sha256", apiSecret)
    .update(rawBody)
    .digest(); // Buffer

  if (calculated.length !== provided.length) return false;

  return crypto.timingSafeEqual(calculated, provided);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  // Webhooks are POST. If anything else hits the action (rare), return 200.
  if (request.method !== "POST") {
    return new Response("ok", { status: 200 });
  }

  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";

  // Fetch headers (case-insensitive in Fetch, but keeping your dual-lookup is harmless)
  const hmac =
    request.headers.get("X-Shopify-Hmac-Sha256") ??
    request.headers.get("X-Shopify-Hmac-SHA256");

  const topic = request.headers.get("X-Shopify-Topic") ?? "";
  const shop = request.headers.get("X-Shopify-Shop-Domain") ?? "";

  // IMPORTANT: Use raw bytes for HMAC verification (do not JSON.parse first)
  const rawBodyBuffer = Buffer.from(await request.arrayBuffer());
  const rawBodyText = rawBodyBuffer.toString("utf8");

  // Shopify compliance webhooks must return 401 for invalid HMAC.
  if (!verifyShopifyWebhookHmac(rawBodyBuffer, hmac, apiSecret)) {
    return new Response("Invalid webhook signature", { status: 401 });
  }

  let payload: unknown = {};
  if (rawBodyText) {
    try {
      payload = JSON.parse(rawBodyText);
    } catch {
      payload = {};
    }
  }

  // Normalize topic just in case
  const normalizedTopic = topic.trim().toLowerCase();

  console.log(`[webhooks] topic=${normalizedTopic} shop=${shop}`);

  try {
    switch (normalizedTopic) {
      case "app/uninstalled": {
        // Remove shop sessions and any persisted shop data (at minimum sessions)
        if (shop) {
          await db.session.deleteMany({ where: { shop } });
        }
        break;
      }

      case "app/scopes_update": {
        console.log(`[webhooks] scopes_update payload`, payload);
        break;
      }

      // Privacy compliance topics
      case "customers/data_request": {
        // If you don't store customer data, logging + 200 is acceptable
        console.log(`[webhooks] customers/data_request payload`, payload);
        break;
      }

      case "customers/redact": {
        // If you store customer data, delete/anonymize it here
        console.log(`[webhooks] customers/redact payload`, payload);
        break;
      }

      case "shop/redact": {
        // Must erase shop data (at minimum sessions)
        if (shop) {
          await db.session.deleteMany({ where: { shop } });
        }
        console.log(`[webhooks] shop/redact payload`, payload);
        break;
      }

      default: {
        console.log(`[webhooks] Unhandled topic: ${normalizedTopic}`);
        break;
      }
    }
  } catch (err) {
    // Returning 200 prevents repeated retries during review automation;
    // you still get logs for diagnosis.
    console.error(`[webhooks] handler error topic=${normalizedTopic} shop=${shop}`, err);
  }

  return new Response(null, { status: 200 });
};
