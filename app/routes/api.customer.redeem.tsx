import type { ActionFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopSettings } from "../lib/shopSettings.server";
import { issueRedemptionCode } from "../lib/redemption.server";
import { customerAccountPreflight, withCustomerAccountCors } from "../lib/customerAccountCors.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method.toUpperCase() === "OPTIONS") {
    return customerAccountPreflight();
  }

  if (request.method.toUpperCase() !== "POST") {
    return withCustomerAccountCors(new Response("Method Not Allowed", { status: 405 }));
  }

  try {
    const { sessionToken, customerAccount, shop, admin } = await authenticate.public.customerAccount(request);

    const customerId = String(customerAccount.id);
    const settings = await getShopSettings(shop);

    const body = await request.json().catch(() => ({}));
    const pointsRequested = Number(body?.points ?? 0);
    const forceNew = Boolean(body?.forceNew);

    if (!Number.isInteger(pointsRequested) || pointsRequested <= 0) {
      return withCustomerAccountCors(
        json({ ok: false, error: "Invalid points amount." }, { status: 400 })
      );
    }

    if (!settings.redemptionSteps.includes(pointsRequested)) {
      return withCustomerAccountCors(
        json(
          {
            ok: false,
            error: `Invalid redemption step. Allowed: ${settings.redemptionSteps.join(", ")}`
          },
          { status: 400 }
        )
      );
    }

    const result = await issueRedemptionCode({
      shop,
      admin,
      customerId,
      pointsRequested,
      idemKey: forceNew ? null : undefined
    });

    return withCustomerAccountCors(
      json({
        ok: true,
        code: result.code,
        expiresAt: result.expiresAt,
        points: result.points,
        valueDollars: result.valueDollars,
        redemptionId: result.redemptionId
      })
    );
  } catch (e: any) {
    return withCustomerAccountCors(
      json({ ok: false, error: String(e?.message ?? e ?? "Redeem failed") }, { status: 400 })
    );
  }
};
