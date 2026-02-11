import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
return new Response("Already ran", { status: 200 });
}


const shops = await db.shopSettings.findMany({ select: { shop: true, pointsExpireDays: true, codeTtlDays: true } });


let expiredBalances = 0;
let expiredCodes = 0;


for (const s of shops) {
const shop = s.shop;
const pointsExpireDays = Number(s.pointsExpireDays ?? 365) || 365;
const codeTtlDays = Number(s.codeTtlDays ?? 30) || 30;


const expireBefore = new Date(Date.now() - pointsExpireDays * 24 * 60 * 60 * 1000);
const codeExpireBefore = new Date(Date.now() - codeTtlDays * 24 * 60 * 60 * 1000);


// 1) Inactivity expiry — balance goes to 0, ledger EXPIRE
const staleBalances = await db.customerPointsBalance.findMany({
where: { shop, lastActivityAt: { lt: expireBefore }, balance: { gt: 0 } },
});


for (const b of staleBalances) {
const toExpire = clampInt(Number(b.balance ?? 0) || 0, 0, 10_000_000);
if (toExpire <= 0) continue;


await db.$transaction(async (tx) => {
await tx.pointsLedger.create({
data: {
shop,
customerId: b.customerId,
type: "EXPIRE",
delta: -toExpire,
source: "INACTIVITY",
sourceId: String(expireBefore.toISOString().slice(0, 10)),
description: `Expired due to inactivity (${pointsExpireDays} days).`,
createdAt: new Date(),
},
});


await tx.customerPointsBalance.update({
where: { shop_customerId: { shop, customerId: b.customerId } },
data: { balance: 0 },
});
});


expiredBalances += 1;
}


// 2) Code TTL expiry — delete discount nodes + mark redemption EXPIRED
const staleCodes = await db.redemption.findMany({
where: {
shop,
status: { in: ["ISSUED", "APPLIED"] },
createdAt: { lt: codeExpireBefore },
},
});


for (const r of staleCodes) {
if (r.discountNodeId) {
try {
await archiveDiscountNode(shop, r.discountNodeId);
} catch {
// keep going; still mark local expiry
}
}


await db.redemption.update({
where: { id: r.id },
data: {
status: "EXPIRED",
expiredAt: new Date(),
},
});


expiredCodes += 1;
}
}


return new Response(JSON.stringify({ ok: true, expiredBalances, expiredCodes }), {
status: 200,
headers: { "Content-Type": "application/json" },
});
};