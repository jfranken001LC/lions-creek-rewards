(() => {
  function $(root, selector) {
    return root.querySelector(selector);
  }

  function normalizePath(input) {
    let value = String(input || "").trim();
    if (!value) return "";
    if (!value.startsWith("/")) value = `/${value}`;
    return value.replace(/\/$/, "");
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { ok: false, error: "Invalid JSON response", raw: text };
    }
    return { response, data };
  }

  function formatMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : "$0.00";
  }

  function readSubtotalCents(root) {
    const cents = parseInt(root.getAttribute("data-cart-subtotal-cents") || "", 10);
    return Number.isFinite(cents) ? cents : null;
  }

  async function fetchSubtotalCents() {
    try {
      const { response, data } = await fetchJson("/cart.js", {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok || !data) return null;
      const cents = Number(data.items_subtotal_price ?? data.total_price);
      return Number.isFinite(cents) ? cents : null;
    } catch {
      return null;
    }
  }

  function centsToDollars(cents) {
    const value = Number(cents);
    return Number.isFinite(value) ? value / 100 : null;
  }

  function getMinOrderDollars(state) {
    const value = Number(state?.settings?.minOrderDollars ?? state?.settings?.redemptionMinOrder);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function progressMessage(balance, options) {
    const numericBalance = Number(balance);
    if (!Number.isFinite(numericBalance)) return "";
    const normalized = (Array.isArray(options) ? options : [])
      .filter((option) => option && Number.isFinite(Number(option.points)) && Number.isFinite(Number(option.valueDollars)))
      .slice()
      .sort((a, b) => Number(a.points) - Number(b.points));

    if (!normalized.length) return "";

    const first = normalized[0];
    const next = normalized.find((option) => Number(option.points) > numericBalance);

    if (numericBalance < Number(first.points)) {
      const diff = Math.max(0, Number(first.points) - numericBalance);
      return `You're ${diff} point${diff === 1 ? "" : "s"} away from ${formatMoney(first.valueDollars)} off.`;
    }

    if (next) {
      const diff = Math.max(0, Number(next.points) - numericBalance);
      return `Next reward: ${diff} more point${diff === 1 ? "" : "s"} to unlock ${formatMoney(next.valueDollars)} off.`;
    }

    return "You're at the top reward tier.";
  }

  function metricProgressText(tier) {
    if (!tier?.nextTierName || tier?.remainingToNext == null) return "";
    const remaining = Number(tier.remainingToNext);
    if (!Number.isFinite(remaining)) return "";

    if (tier.remainingMetricType === "lifetimeEligibleSpend") {
      return `${formatMoney(remaining)} more lifetime eligible spend to reach ${tier.nextTierName}.`;
    }

    return `${remaining} more lifetime point${remaining === 1 ? "" : "s"} to reach ${tier.nextTierName}.`;
  }

  function setContent(root, statusText, bodyHtml) {
    $(root, "[data-lcr-status]").textContent = statusText || "";
    $(root, "[data-lcr-body]").innerHTML = bodyHtml || "";
  }

  function render(root, state, subtotalCents) {
    const balance = state?.points?.balance ?? 0;
    const tierName = state?.tier?.currentTierName || "";
    const tierProgress = metricProgressText(state?.tier);
    const options = Array.isArray(state?.redemptionOptions) ? state.redemptionOptions : [];
    const minOrderDollars = getMinOrderDollars(state);
    const subtotalDollars = subtotalCents != null ? centsToDollars(subtotalCents) : null;
    const subtotalEligible = minOrderDollars <= 0 || subtotalDollars == null ? true : subtotalDollars >= minOrderDollars;
    const pointsProgress = progressMessage(balance, options);
    const effectiveOptions = options.map((option) => ({ ...option, can: Boolean(option?.canRedeem) && subtotalEligible }));
    const redeemableOptions = effectiveOptions.filter((option) => option && option.can);

    let html = `<div class="lcr-row"><strong>Points balance:</strong> ${balance}</div>`;

    if (tierName) {
      html += `<div class="lcr-row"><strong>Tier:</strong> ${tierName}</div>`;
    }
    if (tierProgress) {
      html += `<div class="lcr-muted">${tierProgress}</div>`;
    }
    if (pointsProgress) {
      html += `<div class="lcr-muted">${pointsProgress}</div>`;
    }

    if (minOrderDollars > 0 && subtotalDollars != null) {
      if (subtotalEligible) {
        html += `<div class="lcr-muted">Cart subtotal: ${formatMoney(subtotalDollars)} (min: ${formatMoney(minOrderDollars)}).</div>`;
      } else {
        const needed = Math.max(0, minOrderDollars - subtotalDollars);
        html += `<div class="lcr-muted">Add ${formatMoney(needed)} more to redeem (min: ${formatMoney(minOrderDollars)}).</div>`;
      }
    }

    if (state?.redemption?.code) {
      html += `<div class="lcr-active">Active code: <strong>${state.redemption.code}</strong> (expires ${new Date(state.redemption.expiresAt).toLocaleString()})</div>`;
      html += `<div class="lcr-muted">Use this code at checkout before it expires.</div>`;
    }

    if (!effectiveOptions.length) {
      setContent(root, "", `${html}<div class="lcr-muted">No redemption options configured.</div>`);
      return;
    }

    html += `<div class="lcr-options"><div class="lcr-muted">Redeem now:</div>`;
    const defaultPoints = redeemableOptions.length ? Number(redeemableOptions[0].points) : null;

    for (const option of effectiveOptions) {
      const disabled = option.can ? "" : "disabled";
      const label = `${option.points} points → ${formatMoney(option.valueDollars)} off`;
      const checked = !state?.redemption && defaultPoints != null && Number(option.points) === defaultPoints && option.can ? "checked" : "";
      html += `<label class="lcr-option"><input type="radio" name="lcr-redeem" value="${option.points}" ${disabled} ${checked}/> ${label}</label>`;
    }

    html += `</div>`;
    const buttonDisabled = !redeemableOptions.length || Boolean(state?.redemption);
    html += `<button type="button" class="lcr-btn" data-lcr-redeem-btn ${buttonDisabled ? "disabled" : ""}>Redeem &amp; checkout</button>`;
    html += state?.redemption
      ? `<div class="lcr-muted lcr-hint">You already have an active code. Use it at checkout.</div>`
      : `<div class="lcr-muted lcr-hint">We’ll apply your code and redirect you to checkout.</div>`;

    setContent(root, "", html);
  }

  async function initOne(root) {
    const proxyPath = normalizePath(root.getAttribute("data-proxy-path") || "");
    if (!proxyPath) {
      setContent(root, "Missing app proxy path. Configure the block settings.", "");
      return;
    }

    setContent(root, "Loading rewards…", "");

    const loyaltyUrl = `${proxyPath}/loyalty.json`;
    const { response, data } = await fetchJson(loyaltyUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (response.status === 401 || response.status === 403) {
      setContent(root, "Log in to view and redeem rewards.", "");
      return;
    }

    if (!data || data.ok !== true) {
      setContent(root, data?.error || "Unable to load rewards.", "");
      return;
    }

    let subtotalCents = readSubtotalCents(root);
    render(root, data, subtotalCents);

    const button = $(root, "[data-lcr-redeem-btn]");
    if (!button || button.hasAttribute("disabled")) return;

    button.addEventListener("click", async () => {
      try {
        const selected = $(root, "input[name='lcr-redeem']:checked");
        const pointsToRedeem = selected ? Number(selected.value) : NaN;
        if (!Number.isFinite(pointsToRedeem) || pointsToRedeem <= 0) {
          alert("Please select a reward to redeem.");
          return;
        }

        const minOrderDollars = getMinOrderDollars(data);
        if (minOrderDollars > 0) {
          const freshSubtotal = await fetchSubtotalCents();
          if (freshSubtotal != null) subtotalCents = freshSubtotal;
          const subtotalDollars = subtotalCents != null ? centsToDollars(subtotalCents) : null;
          if (subtotalDollars != null && subtotalDollars < minOrderDollars) {
            alert(`Minimum cart subtotal to redeem points is ${formatMoney(minOrderDollars)}.`);
            return;
          }
        }

        button.setAttribute("disabled", "disabled");
        button.textContent = "Creating code…";

        const idempotencyKey =
          (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
          `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;

        const redeemUrl = `${proxyPath}/redeem.json`;
        const { data: issued } = await fetchJson(redeemUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ pointsToRedeem, idempotencyKey }),
        });

        if (!issued || issued.ok !== true || !issued.code) {
          alert(issued?.error || "Failed to redeem points.");
          button.removeAttribute("disabled");
          button.textContent = "Redeem & checkout";
          return;
        }

        window.location.href = `/discount/${encodeURIComponent(issued.code)}?redirect=/checkout`;
      } catch (error) {
        console.error(error);
        alert("Unexpected error redeeming points.");
        button.removeAttribute("disabled");
        button.textContent = "Redeem & checkout";
      }
    });
  }

  function initAll() {
    document.querySelectorAll("[data-lcr-cart-rewards]").forEach((root) => initOne(root));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
})();
