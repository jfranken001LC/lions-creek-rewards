import { authenticate, unauthenticated } from "../shopify.server";

export { authenticate, unauthenticated };

/**
 * Ensures the request is authenticated as an Admin (embedded app) request.
 * Returns the session for convenience.
 */
export async function requireAdmin(request: Request) {
  const { session } = await authenticate.admin(request);
  return session;
}
