(() => {
  function $(root, selector) {
    return root.querySelector(selector);
  }

  function normalizePath(input) {
    let value = String(input || "").trim();
    if (!value) return "";
    if (!value.startsWith("/")) value = `/${value}`;
    return value.endsWith("/") ? value.slice(0, -1) : value;
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    try {
      return { response, data: text ? JSON.parse(text) : null };
    } catch {
      return { response, data: { ok: false, error: "Invalid JSON response", raw: text } };
    }
  }

  function formatMoney(value) {
    value = Number(value);
    return Number.isFinite(value) ? `$${value.toFixed(2)}` : "$0.00";
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
    cents = Number(cents);
    return Number.isFinite(cents) ? cents / 100 : null;
  }

  function getMinOrderDollars(state) {
    const settings = state?.settings;
    const value = Number(settings?.minOrderDollars ?? settings?.redemptionMinOrder);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function progressMessage(balance, options) {
    balance = Number(balance);
    if (!Number.isFinite(balance)) return "";

    const rewards = (Array.isArray(options) ? options : [])
      .filter((option) => Number.isFinite(Number(option?.points)) && Number.isFinite(Number(option?.valueDollars)))
      .sort((a, b) => Number(a.points) - Number(b.points));

    if (!rewards.length) return "";

    const first = rewards[0];
    const next = rewards.find((option) => Number(option.points) > balance);

    if (balance < Number(first.points)) {
      const diff = Math.max(0, Number(first.points) - balance);
      return `You're ${diff} point${diff === 1 ? "" : "s"} away from ${formatMoney(first.valueDollars)} off.`;
    }

    if (!next) return "You're at the top reward tier.";

    const diff = Math.max(0, Number(next.points) - balance);
    return `Next reward: ${diff} more point${diff === 1 ? "" : "s"} to unlock ${formatMoney(next.valueDollars)} off.`;
  }

  function metricProgressText(tier) {
    if (!tier?.nextTierName || tier?.remainingToNext == null) return "";
    const remaining = Number(tier.remainingToNext);
    if (!Number.isFinite(remaining)) return "";
    return tier.remainingMetricType === "lifetimeEligibleSpend"
      ? `${formatMoney(remaining)} more lifetime eligible spend to reach ${tier.nextTierName}.`
      : `${remaining} more lifetime point${remaining === 1 ? "" : "s"} to reach ${tier.nextTierName}.`;
  }

  function setContent(root, statusText, bodyHtml) {
    $(root, "[data-lcr-status]").textContent = statusText || "";
    $(root, "[data-lcr-body]").innerHTML = bodyHtml || "";
  }

  function setStatus(root, message) {
    $(root, "[data-lcr-status]").textContent = message || "";
  }

  function render(root, state, subtotalCents) {
    const balance = state?.points?.balance ?? 0;
    const options = Array.isArray(state?.redemptionOptions) ? state.redemptionOptions : [];
    const minOrderDollars = getMinOrderDollars(state);
    const subtotalDollars = subtotalCents == null ? null : centsToDollars(subtotalCents);
    const subtotalEligible = subtotalDollars == null || subtotalDollars >= minOrderDollars;
    const tierName = state?.tier?.currentTierName;
    const tierProgress = metricProgressText(state?.tier);
    const pointsProgress = progressMessage(balance, options);
    const effectiveOptions = options.map((option) => ({
      ...option,
      can: Boolean(option?.canRedeem) && subtotalEligible,
    }));
    const redeemableOptions = effectiveOptions.filter((option) => option?.can);

    let html = `<div class="lcr-row"><strong>Points balance:</strong> ${balance}</div>`;

    if (tierName) html += `<div class="lcr-row"><strong>Tier:</strong> ${tierName}</div>`;
    if (tierProgress) html += `<div class="lcr-muted">${tierProgress}</div>`;
    if (pointsProgress) html += `<div class="lcr-muted">${pointsProgress}</div>`;

    if (minOrderDollars > 0 && subtotalDollars != null) {
      html += subtotalEligible
        ? `<div class="lcr-muted">Cart subtotal: ${formatMoney(subtotalDollars)} (min: ${formatMoney(minOrderDollars)}).</div>`
        : `<div class="lcr-muted">Add ${formatMoney(minOrderDollars - subtotalDollars)} more to redeem (min: ${formatMoney(minOrderDollars)}).</div>`;
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
    const defaultPoints = redeemableOptions[0] ? Number(redeemableOptions[0].points) : null;

    for (const option of effectiveOptions) {
      const label = `${option.points} points → ${formatMoney(option.valueDollars)} off`;
      const checked = !state?.redemption && Number(option.points) === defaultPoints && option.can ? "checked" : "";
      html += `<label class="lcr-option"><input type="radio" name="lcr-redeem" value="${option.points}" ${option.can ? "" : "disabled"} ${checked}/> ${label}</label>`;
    }

    const hasActiveCode = Boolean(state?.redemption);
    html += `</div><button type="button" class="lcr-btn" data-lcr-redeem-btn ${!redeemableOptions.length || hasActiveCode ? "disabled" : ""}>Redeem &amp; checkout</button>`;
    html += hasActiveCode
      ? `<div class="lcr-muted lcr-hint">You already have an active code. Use it at checkout.</div>`
      : `<div class="lcr-muted lcr-hint">We’ll apply your code and redirect you to checkout.</div>`;

    setContent(root, "", html);
  }

  async function initOne(root) {
    const proxyPath = normalizePath(root.getAttribute("data-proxy-path"));
    if (!proxyPath) {
      setContent(root, "Missing app proxy path. Configure the block settings.", "");
      return;
    }

    setContent(root, "Loading rewards…", "");

    const { response, data } = await fetchJson(`${proxyPath}/loyalty.json`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (response.status === 401 || response.status === 403) {
      setContent(root, "Log in to view and redeem rewards.", "");
      return;
    }

    if (data?.ok !== true) {
      setContent(root, data?.error || "Unable to load rewards.", "");
      return;
    }

    let subtotalCents = readSubtotalCents(root);
    render(root, data, subtotalCents);

    const button = $(root, "[data-lcr-redeem-btn]");
    if (!button || button.disabled) return;

    button.addEventListener("click", async () => {
      try {
        const selected = $(root, "input[name='lcr-redeem']:checked");
        const pointsToRedeem = Number(selected?.value);
        if (!Number.isFinite(pointsToRedeem) || pointsToRedeem <= 0) {
          setStatus(root, "Choose a reward before continuing.");
          return;
        }

        const minOrderDollars = getMinOrderDollars(data);
        if (minOrderDollars > 0) {
          const freshSubtotal = await fetchSubtotalCents();
          if (freshSubtotal != null) subtotalCents = freshSubtotal;
          const subtotalDollars = subtotalCents == null ? null : centsToDollars(subtotalCents);
          if (subtotalDollars != null && subtotalDollars < minOrderDollars) {
            setStatus(root, `Minimum cart subtotal to redeem points is ${formatMoney(minOrderDollars)}.`);
            return;
          }
        }

        setStatus(root, "Creating your reward code…");
        button.disabled = true;
        button.textContent = "Creating code…";

        const idempotencyKey =
          (typeof crypto !== "undefined" && crypto.randomUUID?.()) ||
          `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;

        const { data: issued } = await fetchJson(`${proxyPath}/redeem.json`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ pointsToRedeem, idempotencyKey }),
        });

        if (issued?.ok !== true || !issued.code) {
          setStatus(root, issued?.error || "We could not redeem that reward right now.");
          button.disabled = false;
          button.textContent = "Redeem & checkout";
          return;
        }

        window.location.href = `/discount/${encodeURIComponent(issued.code)}?redirect=/checkout`;
      } catch (error) {
        console.error(error);
        setStatus(root, "Unexpected error redeeming points.");
        button.disabled = false;
        button.textContent = "Redeem & checkout";
      }
    });
  }

  function initAll() {
    document.querySelectorAll("[data-lcr-cart-rewards]").forEach(initOne);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
})();