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

export async function isAuthorizedJobRequest(
  request: Request,
  jobName: string
): Promise<JobAuthResult> {
  const configured = (process.env.JOB_TOKEN ?? "").trim();

  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, status: 500, error: `JOB_TOKEN_NOT_SET (${jobName})` };
    }
    return { ok: true };
  }

  const hdr = request.headers;
  const xJobToken = (hdr.get("x-job-token") ?? hdr.get("X-Job-Token") ?? "").trim();

  const auth = (hdr.get("authorization") ?? hdr.get("Authorization") ?? "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice("bearer ".length).trim()
    : "";

  const presented = xJobToken || bearer;

  if (!presented) return { ok: false, status: 401, error: "missing_job_token" };
  if (!timingSafeEqual(presented, configured)) return { ok: false, status: 403, error: "invalid_job_token" };

  return { ok: true };
}

export async function assertJobAuth(request: Request, jobName: string) {
  const res = await isAuthorizedJobRequest(request, jobName);
  if (!res.ok) throw new Response(res.error, { status: res.status });
}

export function isJobTokenValid(presented: string) {
  const configured = (process.env.JOB_TOKEN ?? "").trim();
  if (!configured) return process.env.NODE_ENV !== "production";
  return timingSafeEqual(presented.trim(), configured);
}
