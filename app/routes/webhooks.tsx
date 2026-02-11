import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
counts: {
redemptionsDeleted: redaction.redemptionsDeleted,
balancesDeleted: redaction.balancesDeleted,
ledgerUpdated: redaction.ledgerUpdated,
snapshotsUpdated: redaction.snapshotsUpdated,
},
notes: "Customer ID is anonymized in ledgers/snapshots; balance and redemption artifacts are removed.",
}),
});


break;
}


case "shop/redact": {
await recordPrivacyEvent(shop, topic, payload);
await purgeShopData(shop);


await markWebhookOutcome({
eventId,
outcome: "PROCESSED",
code: "PRIVACY_SHOP_REDACTED",
message: safeJsonStringify({ kind: "PRIVACY_SHOP_REDACTED", shop }),
});


break;
}


case "app/uninstalled": {
await purgeShopData(shop);


await markWebhookOutcome({
eventId,
outcome: "PROCESSED",
code: "APP_UNINSTALLED_PURGED",
message: safeJsonStringify({ kind: "APP_UNINSTALLED_PURGED", shop }),
});


break;
}


case "app/scopes_update": {
await markWebhookOutcome({
eventId,
outcome: "PROCESSED",
code: "SCOPES_UPDATED_ACK",
message: safeJsonStringify({ kind: "SCOPES_UPDATED_ACK", shop }),
});


break;
}


default: {
await markWebhookOutcome({
eventId,
outcome: "SKIPPED",
code: "UNHANDLED_TOPIC",
message: safeJsonStringify({ shop, topic, webhookId, notes: "No handler implemented for this topic." }),
});
break;
}
}
} catch (e: any) {
await db.webhookError
.create({
data: {
shop,
topic,
webhookId,
error: String(e?.stack ?? e?.message ?? e),
},
})
.catch(() => null);


await markWebhookOutcome({
eventId,
outcome: "FAILED",
code: "EXCEPTION",
message: String(e?.message ?? e),
});
}


return new Response("ok", { status: 200 });
};