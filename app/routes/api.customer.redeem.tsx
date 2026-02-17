import type { ActionFunctionArgs } from "react-router";
import { prisma } from "../lib/prisma.server";
import { verifyAppProxy } from "../lib/proxy.server";
import { applyRedemption } from "../lib/redemption.server";

export async function action({ request }: ActionFunctionArgs) {
  const proxy = await verifyAppProxy(request);

  const customerId = proxy.customerId;
  if (!customerId) {
    return Response.json({ ok: false, error: "Missing customer" }, { status: 400 });
  }

  const shop = proxy.shop;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const rewardType = (body as any).rewardType;
  const rewardValue = (body as any).rewardValue;

  if (!rewardType || !rewardValue) {
    return Response.json(
      { ok: false, error: "Missing rewardType/rewardValue" },
      { status: 400 },
    );
  }

  const result = await applyRedemption({
    shop,
    customerId,
    rewardType,
    rewardValue,
  });

  return Response.json({ ok: true, result });
}
