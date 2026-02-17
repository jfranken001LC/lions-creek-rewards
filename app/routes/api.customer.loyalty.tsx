import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "react-router";

import { authenticate } from "../shopify.server";
import { withCustomerAccountCors } from "../lib/customerAccountCors.server";
import { getCustomerIdFromJWTSub } from "../lib/jwtSub.server";
import { getCurrentCustomerLoyalty } from "../services/loyalty.server";

type LoyaltySnapshotResponse =
  | {
      ok: true;
      customerId: string;
      customerName?: string | null;
      pointsBalance: number;
      tier?: string | null;
      lastEarnedAt?: string | null;
      lastEarnedSource?: string | null;
    }
  | { ok: false; error: string };

async function handle(request: Request): Promise<Response> {
  // CORS preflight (Customer Account UI extension fetches can trigger it)
  if (request.method === "OPTIONS") {
    return withCustomerAccountCors(new Response(null, { status: 204 }));
  }

  // Allow both GET and POST (requirements say POST; earlier UI code used GET)
  if (request.method !== "GET" && request.method !== "POST") {
    return withCustomerAccountCors(
      json<LoyaltySnapshotResponse>(
        { ok: false, error: "method_not_allowed" },
        { status: 405, headers: { "Cache-Control": "no-store" } }
      )
    );
  }

  try {
    const { sessionToken } = await authenticate.public.customerAccount(request);
    const customerId = getCustomerIdFromJWTSub(sessionToken?.sub);

    if (!customerId) {
      return withCustomerAccountCors(
        json<LoyaltySnapshotResponse>(
          { ok: false, error: "unauthorized" },
          { status: 401, headers: { "Cache-Control": "no-store" } }
        )
      );
    }

    const loyalty = await getCurrentCustomerLoyalty(customerId);

    return withCustomerAccountCors(
      json<LoyaltySnapshotResponse>(
        {
          ok: true,
          customerId,
          customerName: loyalty.customerName ?? null,
          pointsBalance: loyalty.pointsBalance,
          tier: loyalty.tier ?? null,
          lastEarnedAt: loyalty.lastEarnedAt ?? null,
          lastEarnedSource: loyalty.lastEarnedSource ?? null,
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    );
  } catch (err) {
    console.error("api.customer.loyalty error:", err);
    return withCustomerAccountCors(
      json<LoyaltySnapshotResponse>(
        { ok: false, error: "server_error" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      )
    );
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handle(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handle(request);
}
