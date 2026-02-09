import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useMemo, useState } from "preact/hooks";

/**
 * Configuration storage (Automatic discounts)
 * -----------------------------------------
 * Stored on the DiscountAutomaticNode metafield:
 *   namespace: "custom"
 *   key: "function-configuration"
 *   type: "json"
 *
 * Config schema:
 * {
 *   triggerBE: number,
 *   amountPerTrigger: number,
 *   maxDiscount: number,          // 0 = no cap
 *   showConfigInMessage: boolean  // whether to show trigger/amount/cap in the discount message
 * }
 */

const DEFAULT_CONFIG = {
  triggerBE: 6,
  amountPerTrigger: 10,
  maxDiscount: 0,
  showConfigInMessage: false,
};

const money = (n) => {
  const num = Number(n);
  if (!Number.isFinite(num)) return "$0.00";
  return `$${num.toFixed(2)}`;
};

const intOrDefault = (v, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : d;
};

const numOrDefault = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function safeParseJson(value) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const metafields = shopify.data?.metafields ?? [];

  // Config lives in custom/function-configuration for Automatic Discounts
  const cfgMetafield =
    metafields.find((m) => m?.namespace === "custom" && m?.key === "function-configuration") ??
    null;

  const initial = useMemo(() => {
    const parsed = safeParseJson(cfgMetafield?.value);

    const triggerBE = intOrDefault(parsed?.triggerBE, DEFAULT_CONFIG.triggerBE);
    const amountPerTrigger = Math.max(
      0,
      numOrDefault(parsed?.amountPerTrigger, DEFAULT_CONFIG.amountPerTrigger)
    );
    const maxDiscount = Math.max(
      0,
      numOrDefault(parsed?.maxDiscount, DEFAULT_CONFIG.maxDiscount)
    );

    // Boolean toggle (default false)
    const showConfigInMessage =
      typeof parsed?.showConfigInMessage === "boolean"
        ? parsed.showConfigInMessage
        : DEFAULT_CONFIG.showConfigInMessage;

    return { triggerBE, amountPerTrigger, maxDiscount, showConfigInMessage };
  }, [cfgMetafield?.value]);

  const [triggerBE, setTriggerBE] = useState(String(initial.triggerBE));
  const [amountPerTrigger, setAmountPerTrigger] = useState(String(initial.amountPerTrigger));
  const [maxDiscount, setMaxDiscount] = useState(String(initial.maxDiscount));
  const [showConfigInMessage, setShowConfigInMessage] = useState(
    Boolean(initial.showConfigInMessage)
  );

  function resetForm() {
    setTriggerBE(String(initial.triggerBE));
    setAmountPerTrigger(String(initial.amountPerTrigger));
    setMaxDiscount(String(initial.maxDiscount));
    setShowConfigInMessage(Boolean(initial.showConfigInMessage));
  }

  async function save() {
    const config = {
      triggerBE: intOrDefault(triggerBE, DEFAULT_CONFIG.triggerBE),
      amountPerTrigger: Math.max(
        0,
        numOrDefault(amountPerTrigger, DEFAULT_CONFIG.amountPerTrigger)
      ),
      maxDiscount: Math.max(0, numOrDefault(maxDiscount, DEFAULT_CONFIG.maxDiscount)),
      showConfigInMessage: Boolean(showConfigInMessage),
    };

    await shopify.applyMetafieldChange({
      type: "updateMetafield",
      namespace: "custom",
      key: "function-configuration",
      valueType: "json",
      value: JSON.stringify(config),
    });
  }

  const trigger = intOrDefault(triggerBE, DEFAULT_CONFIG.triggerBE);
  const amt = Math.max(0, numOrDefault(amountPerTrigger, DEFAULT_CONFIG.amountPerTrigger));
  const cap = Math.max(0, numOrDefault(maxDiscount, DEFAULT_CONFIG.maxDiscount));

  const previewRows = [1, 2, 3].map((k) => {
    const be = trigger * k;
    const raw = amt * k;
    const applied = cap > 0 ? Math.min(raw, cap) : raw;
    const capped = cap > 0 && applied < raw;
    return { be, raw, applied, capped };
  });

  const messagePreview = showConfigInMessage
    ? `Basket Booster discount (trigger=${trigger}, amt=${amt}, cap=${cap})`
    : "Basket Booster discount";

  return (
    <s-function-settings onSubmit={(e) => e.waitUntil(save())} onReset={resetForm}>
      <s-stack gap="base">
        <s-number-field
          label="Bottle equivalents needed to trigger"
          name="triggerBE"
          value={triggerBE}
          min="1"
          step="1"
          onChange={(e) => setTriggerBE(e.currentTarget.value)}
        />

        <s-number-field
          label="Discount amount per trigger (CAD)"
          name="amountPerTrigger"
          value={amountPerTrigger}
          min="0"
          step="0.01"
          onChange={(e) => setAmountPerTrigger(e.currentTarget.value)}
        />

        <s-number-field
          label="Maximum discount per order (CAD) — 0 means no cap"
          name="maxDiscount"
          value={maxDiscount}
          min="0"
          step="0.01"
          onChange={(e) => setMaxDiscount(e.currentTarget.value)}
        />

        {/* NEW: display config in checkout message */}
        <s-checkbox
          name="showConfigInMessage"
          label="Show trigger/amount/cap in the discount message at checkout"
          checked={showConfigInMessage}
          onChange={(e) => setShowConfigInMessage(Boolean(e.currentTarget.checked))}
        />


        <s-text tone="subdued">
          Message preview: <s-text emphasis="bold">{messagePreview}</s-text>
        </s-text>

        <s-stack gap="tight">
          <s-text emphasis="bold">Preview (scales per trigger)</s-text>

          {previewRows.map((r) => (
            <s-text key={r.be} tone="subdued">
              {r.be} BE → {money(r.applied)} off raw {money(r.raw)}
              {r.capped ? " (capped)" : ""}
            </s-text>
          ))}

          <s-text tone="subdued">
            Example: If Trigger is {trigger} BE and Amount is {money(amt)}, then every {trigger} BE earns{" "}
            {money(amt)} off. {cap > 0 ? `A cap of ${money(cap)} per order is applied.` : "No cap is applied."}
          </s-text>

          <s-text tone="subdued">
            Note: At checkout, the discount is also limited by the cart subtotal (it will never exceed the subtotal).
          </s-text>
        </s-stack>
      </s-stack>
    </s-function-settings>
  );
}
