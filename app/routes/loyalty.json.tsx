import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "../lib/prisma.server";
import { verifyAppProxy } from "../lib/proxy.server";
import { computeCustomerLoyalty } from "../lib/loyalty.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const proxy = await verifyAppProxy(request);

  const customerId = proxy.customerId;
  if (!customerId) {
    return Response.json({ ok: false, error: "Missing customer" }, { status: 400 });
  }

  const shop = proxy.shop;
  const loyalty = await computeCustomerLoyalty({ shop, customerId });

  return Response.json({
    ok: true,
    customerId,
    shop,
    loyalty,
  });
}
