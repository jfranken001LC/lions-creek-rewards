import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";

import { acquireJobLock, releaseJobLock } from "../lib/jobLock.server";
import { assertJobAuth } from "../lib/jobAuth.server";
import { expireIssuedRedemptions, expireInactiveCustomers } from "../lib/loyaltyExpiry.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    // Auth: JOB_TOKEN header or Bearer token (per app/lib/jobAuth.server.ts)
    await assertJobAuth(request, "jobs.expire");

    const shop = await resolveShopForJob(request);
    if (!shop) {
      return Response.json(
        { ok: false, error: "missing_shop", hint: "Provide ?shop=... or ensure at least one Session exists." },
        { status: 400 },
      );
    }

    const lock = await acquireJobLock("jobs.expire");
    if (!lock.acquired) {
      return Response.json({ ok: false, error: lock.error ?? "job_already_running" }, { status: 409 });
    }

    try {
      const now = new Date();

      const redemptions = await expireIssuedRedemptions({ shop, now });
      const inactive = await expireInactiveCustomers({ shop, now });

      return Response.json(
        {
          ok: true,
          shop,
          now: now.toISOString(),
          expiredRedemptions: redemptions,
          expiredInactiveCustomers: inactive,
        },
        { status: 200 },
      );
    } finally {
      await releaseJobLock(lock);
    }
  } catch (err: any) {
    // Preserve intentional auth failures thrown as Response by assertJobAuth()
    if (err instanceof Response) return err;

    return Response.json(
      { ok: false, error: err?.message ?? "Unhandled error" },
      { status: 500 },
    );
  }
}

async function resolveShopForJob(request: Request): Promise<string | null> {
  const url = new URL(request.url);

  // 1) Explicit query param is preferred
  const qp = (url.searchParams.get("shop") ?? "").trim();
  if (qp) return qp;

  // 2) Common environment fallback (optional)
  const envShop =
    (process.env.PRIMARY_SHOP ?? process.env.SHOPIFY_SHOP ?? process.env.SHOP ?? "").trim();
  if (envShop) return envShop;

  // 3) DB fallback: use any installed session
  const any = await db.session.findFirst({
    select: { shop: true },
    orderBy: { shop: "asc" },
  });

  return any?.shop ?? null;
}
