import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { acquireJobLock, releaseJobLock } from "../lib/jobLock.server";
import { assertJobSecretOrThrow } from "../lib/jobAuth.server";
import { expireIssuedRedemptions, expireInactiveCustomers } from "../lib/loyaltyExpiry.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    // 1) Require the job secret (for Lightsail cron / manual admin curl).
    assertJobSecretOrThrow(request);

    // 2) Resolve shop context (admin auth) so we can run cross-customer maintenance.
    const { session } = await authenticate.admin(request);
    const shop = session.shop;

    // 3) Acquire a lock to avoid overlapping job runs (important if cron overlaps / manual triggers).
    const lock = await acquireJobLock("jobs.expire");

    if (!lock.acquired) {
      return data(
        {
          ok: false,
          error: lock.error ?? "Job is already running.",
        },
        { status: 409 },
      );
    }

    try {
      const now = new Date();

      const redemptions = await expireIssuedRedemptions({ shop, now });
      const inactive = await expireInactiveCustomers({ shop, now });

      return json(
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
    return data(
      {
        ok: false,
        error: err?.message ?? "Unhandled error",
      },
      { status: 500 },
    );
  }
}
