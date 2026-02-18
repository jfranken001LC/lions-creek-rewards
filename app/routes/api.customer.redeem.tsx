// app/routes/api.customer.redeem.tsx
// Customer Account API: redeem points for a discount code.
//
// POST body: { points: number, idemKey?: string }

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import shopify from "../shopify.server";
import { issueRedemptionCode } from "../lib/redemption.server";
import { validateRedeemPoints } from "../lib/loyalty.server";
import { getShopSettings } from "../lib/shopSettings.server";
import { customerAccountPreflight, withCustomerAccountCors } from "../lib/customerAccountCors.server";

function asInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return customerAccountPreflight();
  }
  return new Response("Method Not Allowed", { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return withCustomerAccountCors(new Response("Method Not Allowed", { status: 405 }));
  }

  let session: any;
  let admin: any;

  try {
    ({ session, admin } = await shopify.authenticate.public.customerAccount(request));
  } catch {
    return withCustomerAccountCors(
      new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      })
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return withCustomerAccountCors(
      new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      })
    );
  }

  const points = asInt(body?.points);
  if (points == null || points <= 0) {
    return withCustomerAccountCors(
      new Response(JSON.stringify({ ok: false, error: "points must be a positive integer" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      })
    );
  }

  const shop = session.shop;
  const customerId = session.customer.id;
  const settings = await getShopSettings(shop);

  const validation = validateRedeemPoints(settings, points);
  if (!validation.ok) {
    return withCustomerAccountCors(
      new Response(JSON.stringify({ ok: false, error: validation.error }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      })
    );
  }

  try {
    const result = await issueRedemptionCode({
      shop,
      admin,
      customerId,
      pointsRequested: points,
      idemKey: typeof body?.idemKey === "string" ? body.idemKey : undefined,
    });

    return withCustomerAccountCors(
      new Response(JSON.stringify({ ok: true, redemption: result }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      })
    );
  } catch (e: any) {
    const message = typeof e?.message === "string" ? e.message : "Redeem failed";
    return withCustomerAccountCors(
      new Response(JSON.stringify({ ok: false, error: message }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      })
    );
  }
}
