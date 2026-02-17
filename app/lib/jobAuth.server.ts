// app/lib/jobAuth.server.ts
import crypto from "crypto";

export type JobAuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

function timingSafeEqual(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

/**
 * Authorize a scheduled job request using a shared token.
 *
 * Accepted headers:
 *  - X-Job-Token: <token>
 *  - Authorization: Bearer <token>
 *
 * Behavior:
 *  - If JOB_TOKEN is set: require a matching token.
 *  - If JOB_TOKEN is not set:
 *      - allow in non-production (dev convenience)
 *      - reject in production (safe default)
 */
export async function isAuthorizedJobRequest(
  request: Request,
  jobName: string
): Promise<JobAuthResult> {
  const configured = (process.env.JOB_TOKEN ?? "").trim();

  // Safe default: production requires JOB_TOKEN
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      return {
        ok: false,
        status: 500,
        error: `JOB_TOKEN_NOT_SET (${jobName})`,
      };
    }
    return { ok: true };
  }

  const hdr = request.headers;
  const xJobToken = (hdr.get("x-job-token") ?? hdr.get("X-Job-Token") ?? "").trim();

  const auth = (hdr.get("authorization") ?? hdr.get("Authorization") ?? "").trim();
  const bearer =
    auth.toLowerCase().startsWith("bearer ") ? auth.slice("bearer ".length).trim() : "";

  const presented = xJobToken || bearer;

  if (!presented) {
    return { ok: false, status: 401, error: "missing_job_token" };
  }

  if (!timingSafeEqual(presented, configured)) {
    return { ok: false, status: 403, error: "invalid_job_token" };
  }

  return { ok: true };
}
