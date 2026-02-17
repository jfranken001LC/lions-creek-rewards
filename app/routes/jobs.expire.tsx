import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "../lib/prisma.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";

  const expected = process.env.JOB_TOKEN ?? "";
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();

  const result = await prisma.pointsEvent.updateMany({
    where: {
      type: "EARN",
      expiresAt: { not: null, lte: now },
      expiredAt: null,
    },
    data: {
      expiredAt: now,
    },
  });

  return Response.json({
    ok: true,
    expiredEvents: result.count,
    ranAt: now.toISOString(),
  });
}
