import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";
import { verifyAppProxy } from "../lib/proxy.server";
import { computeCustomerLoyalty } from "../lib/loyalty.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const proxy = await verifyAppProxy(request);
  if (!proxy.ok) return data({ ok: false, error: proxy.error }, { status: 401 });
  if (!proxy.customerId) return data({ ok: false, error: "Missing customer" }, { status: 400 });

  const loyalty = await computeCustomerLoyalty({ shop: proxy.shop, customerId: proxy.customerId });
  return data({ ok: true, loyalty, ...loyalty });
}

export default function LoyaltyDebugPage() {
  const d = useLoaderData<typeof loader>();
  return <pre style={{ padding: 16, whiteSpace: "pre-wrap" }}>{JSON.stringify(d, null, 2)}</pre>;
}
