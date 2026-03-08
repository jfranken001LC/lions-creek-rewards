import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";

import { acquireJobLock, releaseJobLock } from "../lib/jobLock.server";
import { assertJobAuth } from "../lib/jobAuth.server";
import { expireIssuedRedemptions, expireInactiveCustomers } from "../lib/loyaltyExpiry.server";

type PerShopResult = {
  shop: string;
  expiredRedemptions: number;
  expiredInactiveCustomers: number;
};

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    await assertJobAuth(request, "jobs.expire");
    const url = new URL(request.url);
    const runAll = url.searchParams.get("all") === "1";

    if (runAll) {
      const shops = await resolveAllInstalledShops();
      const allLock = await acquireJobLock("jobs.expire:all");
      if (!allLock.acquired) {
        return Response.json({ ok: false, error: allLock.error ?? "job_already_running" }, { status: 409 });
      }

      try {
        const now = new Date();
        const results: PerShopResult[] = [];

        for (const shop of shops) {
          const lock = await acquireJobLock(`jobs.expire:${shop}`);
          if (!lock.acquired) {
            results.push({ shop, expiredRedemptions: 0, expiredInactiveCustomers: 0 });
            continue;
          }

          try {
            const expiredRedemptions = await expireIssuedRedemptions({ shop, now });
            const expiredInactiveCustomers = await expireInactiveCustomers({ shop, now });
            results.push({ shop, expiredRedemptions, expiredInactiveCustomers });
          } finally {
            await releaseJobLock(lock);
          }
        }

        return Response.json(
          {
            ok: true,
            scope: "all",
            now: now.toISOString(),
            noShopsInstalled: shops.length === 0,
            shopsProcessed: shops.length,
            perShopResults: results,
          },
          { status: 200 },
        );
      } finally {
        await releaseJobLock(allLock);
      }
    }

    const shop = await resolveShopForJob(request);
    if (!shop) {
      return Response.json(
        { ok: true, scope: "single", noShopsInstalled: true, shopsProcessed: 0, perShopResults: [] },
        { status: 200 },
      );
    }

    const lock = await acquireJobLock(`jobs.expire:${shop}`);
    if (!lock.acquired) {
      return Response.json({ ok: false, error: lock.error ?? "job_already_running" }, { status: 409 });
    }

    try {
      const now = new Date();
      const expiredRedemptions = await expireIssuedRedemptions({ shop, now });
      const expiredInactiveCustomers = await expireInactiveCustomers({ shop, now });

      return Response.json(
        {
          ok: true,
          scope: "single",
          shop,
          now: now.toISOString(),
          expiredRedemptions,
          expiredInactiveCustomers,
        },
        { status: 200 },
      );
    } finally {
      await releaseJobLock(lock);
    }
  } catch (err: any) {
    if (err instanceof Response) return err;
    return Response.json({ ok: false, error: err?.message ?? "Unhandled error" }, { status: 500 });
  }
}

async function resolveAllInstalledShops(): Promise<string[]> {
  const rows = await db.session.findMany({
    distinct: ["shop"],
    select: { shop: true },
    orderBy: { shop: "asc" },
  });
  return rows.map((row) => row.shop).filter(Boolean);
}

async function resolveShopForJob(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  const qp = (url.searchParams.get("shop") ?? "").trim();
  if (qp) return qp;

  const any = await db.session.findFirst({
    select: { shop: true },
    orderBy: { shop: "asc" },
  });

  return any?.shop ?? null;
}
