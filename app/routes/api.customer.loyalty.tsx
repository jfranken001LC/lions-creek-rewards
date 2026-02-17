// File: app/routes/api.customer.loyalty.tsx

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { customerAccountCors } from "../lib/customerAccountCors.server";
import {
  getOrCreateCustomer,
  getCustomerLoyaltySummary,
} from "../models/customer.server";

async function handleCustomerLoyalty(request: Request): Promise<Response> {
  const method = request.method.toUpperCase();

  // Allow GET (extension fetch), POST (per requirements), and OPTIONS (CORS preflight)
  if (method !== "GET" && method !== "POST" && method !== "OPTIONS") {
    return Response.json(
      { ok: false, error: "Method not allowed" },
      { status: 405 },
    );
  }

  const { shop, customer } = await authenticate.customerAccount(request);

  await getOrCreateCustomer({
    shop,
    customerId: customer.id,
    email: customer?.emailAddress?.emailAddress ?? null,
    firstName: customer?.firstName ?? null,
    lastName: customer?.lastName ?? null,
  });

  const summary = await getCustomerLoyaltySummary({
    shop,
    customerId: customer.id,
  });

  return Response.json({
    ok: true,
    shop,
    customerId: customer.id,
    balances: summary.balances,
    recentLedger: summary.recentLedger,
    program: summary.program,
  });
}

// GET -> loader
export async function loader({ request }: LoaderFunctionArgs) {
  return customerAccountCors(request, () => handleCustomerLoyalty(request));
}

// POST/OPTIONS -> action
export async function action({ request }: ActionFunctionArgs) {
  return customerAccountCors(request, () => handleCustomerLoyalty(request));
}
