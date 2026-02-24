import { type LoaderFunctionArgs } from "react-router";
import { authenticate, registerWebhooks } from "../shopify.server";

/**
 * Shopify auth entrypoint.
 *
 * We register webhooks here so they are reliably created/updated whenever
 * a shop installs/re-auths the app.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Best-effort: don't block auth on transient failures.
  try {
    await registerWebhooks({ session });
  } catch (e) {
    console.error("Webhook registration failed during auth:", e);
  }

  return null;
};
