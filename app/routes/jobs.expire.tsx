import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "react-router";

import { prisma } from "../db.server";
import { isAuthorizedJobRequest } from "../lib/jobAuth.server";
import {
  expireInactiveCustomers,
  expireRedemptionsAndRestorePoints,
} from "../services/expiryJob.server";
import { JobLock } from "../services/jobLock.server";

const JOB_NAME = "expire";

async function run(request: Request): Promise<Response> {
  // Spec allows GET|POST; keep both for manual invocation + cron POST.
  if (request.method !== "GET" && request.method !== "POST") {
    return json(
      { ok: false, error: "method_not_allowed" },
      { status: 405, headers: { "Cache-Control": "no-store" } }
    );
  }

  const auth = await isAuthorizedJobRequest(request, JOB_NAME);
  if (!auth.ok) {
    return json(
      { ok: false, error: auth.error },
      { status: auth.status ?? 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Ensure idempotency & avoid overlaps
  const lock = new JobLock(prisma, JOB_NAME);

  const acquired = await lock.tryAcquire();
  if (!acquired) {
    return json(
      { ok: false, error: "job_already_running" },
      { status: 409, headers: { "Cache-Control": "no-store" } }
    );
  }

  const startedAt = new Date();

  try {
    const [inactiveResult, redemptionResult] = await Promise.all([
      expireInactiveCustomers(prisma),
      expireRedemptionsAndRestorePoints(prisma),
    ]);

    const finishedAt = new Date();

    await lock.release({
      ok: true,
      startedAt,
      finishedAt,
      inactiveCustomers: inactiveResult,
      redemptions: redemptionResult,
    });

    return json(
      {
        ok: true,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        inactiveCustomers: inactiveResult,
        redemptions: redemptionResult,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("jobs.expire error:", err);

    const finishedAt = new Date();
    await lock.release({
      ok: false,
      startedAt,
      finishedAt,
      error: (err as Error)?.message ?? String(err),
    });

    return json(
      { ok: false, error: "server_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}
