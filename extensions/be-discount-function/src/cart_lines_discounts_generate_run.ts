import type {
  CartLinesDiscountsGenerateRunInput,
  CartLinesDiscountsGenerateRunResult,
} from "../generated/api";

type Config = {
  triggerBE: number;
  amountPerTrigger: number;
  maxDiscount: number;          // 0 = no cap
  showConfigInMessage: boolean; // true => include trigger/amt/cap in message
};

const DEFAULT_CONFIG: Config = {
  triggerBE: 6,
  amountPerTrigger: 10,
  maxDiscount: 0,
  showConfigInMessage: false,
};

const MESSAGE_PREFIX = "Basket Booster discount";

function toNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeParseJson(value: unknown): any | null {
  if (value == null) return null;
  if (typeof value === "object") return value; // already JSON (jsonValue)
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function normalizeConfig(raw: any | null): Config {
  const triggerBE = Math.max(1, Math.floor(toNumber(raw?.triggerBE) ?? DEFAULT_CONFIG.triggerBE));
  const amountPerTrigger = Math.max(0, toNumber(raw?.amountPerTrigger) ?? DEFAULT_CONFIG.amountPerTrigger);
  const maxDiscount = Math.max(0, toNumber(raw?.maxDiscount) ?? DEFAULT_CONFIG.maxDiscount);

  const showConfigInMessage =
    typeof raw?.showConfigInMessage === "boolean"
      ? raw.showConfigInMessage
      : DEFAULT_CONFIG.showConfigInMessage;

  return { triggerBE, amountPerTrigger, maxDiscount, showConfigInMessage };
}

function readLineBE(line: CartLinesDiscountsGenerateRunInput["cart"]["lines"][number]): number {
  if (line.merchandise.__typename !== "ProductVariant") return 0;

  // Preferred: loyalty.bottle_equivalent
  const variantPreferred = toNumber(line.merchandise.beMetafield?.value);
  if (variantPreferred != null) return Math.max(0, variantPreferred);

  // Legacy: custom.loyalty_bottle_equivalent
  const variantLegacy = toNumber(line.merchandise.legacyBeMetafield?.value);
  if (variantLegacy != null) return Math.max(0, variantLegacy);

  const productPreferred = toNumber(line.merchandise.product?.beMetafield?.value);
  if (productPreferred != null) return Math.max(0, productPreferred);

  const productLegacy = toNumber(line.merchandise.product?.legacyBeMetafield?.value);
  if (productLegacy != null) return Math.max(0, productLegacy);

  return 0;
}

export function run(input: CartLinesDiscountsGenerateRunInput): CartLinesDiscountsGenerateRunResult {
  // IMPORTANT: Automatic discount config is stored in custom/function-configuration
  const metafield = input.discount?.metafield ?? null;

  const rawConfig =
    safeParseJson((metafield as any)?.jsonValue) ??
    safeParseJson((metafield as any)?.value);

  const cfg = normalizeConfig(rawConfig);

  if (cfg.amountPerTrigger <= 0) return { operations: [] };

  // Sum total BE
  let totalBE = 0;
  for (const line of input.cart.lines) {
    const be = readLineBE(line);
    if (be <= 0) continue;
    totalBE += be * line.quantity;
  }

  const triggers = Math.floor(totalBE / cfg.triggerBE);
  if (triggers <= 0) return { operations: [] };

  const subtotal = toNumber(input.cart.cost.subtotalAmount.amount) ?? 0;
  if (subtotal <= 0) return { operations: [] };

  const rawDiscount = triggers * cfg.amountPerTrigger;

  // Never exceed subtotal
  let discountAmount = Math.min(subtotal, rawDiscount);

  // Optional cap
  if (cfg.maxDiscount > 0) {
    discountAmount = Math.min(discountAmount, cfg.maxDiscount);
  }

  if (discountAmount <= 0) return { operations: [] };

  // NEW: message toggle
  const message = cfg.showConfigInMessage
    ? `${MESSAGE_PREFIX} (trigger=${cfg.triggerBE}, amt=${cfg.amountPerTrigger}, cap=${cfg.maxDiscount})`
    : MESSAGE_PREFIX;

  return {
    operations: [
      {
        orderDiscountsAdd: {
          selectionStrategy: "FIRST",
          candidates: [
            {
              message,
              targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
              value: {
                fixedAmount: {
                  amount: discountAmount.toFixed(2),
                },
              },
            },
          ],
        },
      },
    ],
  };
}
