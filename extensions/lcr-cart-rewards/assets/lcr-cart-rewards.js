(() => {
  function qs(el, sel) {
    return el.querySelector(sel);
  }

  function normalizePath(p) {
    const s = String(p || "").trim();
    if (!s) return "";
    if (s.startsWith("http://") || s.startsWith("https://")) {
      try {
        const u = new URL(s);
        return u.pathname.replace(/\/$/, "");
      } catch {
        return s.replace(/\/$/, "");
      }
    }
    if (!s.startsWith("/")) return "/" + s.replace(/\/$/, "");
    return s.replace(/\/$/, "");
  }

  async function fetchJson(url, init) {
    const res = await fetch(url, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { ok: false, error: "Invalid JSON response", raw: text };
    }
    return { res, data };
  }

  function formatMoney(dollars) {
    const n = Number(dollars);
    if (!Number.isFinite(n)) return "$0.00";
    return `$${n.toFixed(2)}`;
  }

  function readCartSubtotalCents(root) {
    const raw = root.getAttribute("data-cart-subtotal-cents") || "";
    const n = parseInt(String(raw || ""), 10);
    return Number.isFinite(n) ? n : null;
  }

  async function fetchCartSubtotalCents() {
    try {
      // Shopify standard JSON endpoint (theme storefront)
      const { res, data } = await fetchJson("/cart.js", {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok || !data) return null;

      const cents = Number(data.items_subtotal_price ?? data.total_price);
      return Number.isFinite(cents) ? cents : null;
    } catch {
      return null;
    }
  }

  function centsToDollars(cents) {
    const n = Number(cents);
    if (!Number.isFinite(n)) return null;
    return n / 100;
  }

  function getMinOrderDollars(state) {
    const raw = state?.settings?.minOrderDollars ?? state?.settings?.redemptionMinOrder;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function computeProgressLine(balance, options) {
    const pts = Number(balance);
    if (!Number.isFinite(pts)) return null;

    const sorted = (Array.isArray(options) ? options : [])
      .filter((o) => o && Number.isFinite(Number(o.points)) && Number.isFinite(Number(o.valueDollars)))
      .slice()
      .sort((a, b) => Number(a.points) - Number(b.points));

    if (!sorted.length) return null;

    const first = sorted[0];
    const next = sorted.find((o) => Number(o.points) > pts) || null;

    if (pts < Number(first.points)) {
      const diff = Math.max(0, Number(first.points) - pts);
      return `You're ${diff} point${diff === 1 ? "" : "s"} away from ${formatMoney(first.valueDollars)} off.`;
    }

    if (next) {
      const diff = Math.max(0, Number(next.points) - pts);
      return `Next reward: ${diff} more point${diff === 1 ? "" : "s"} to unlock ${formatMoney(next.valueDollars)} off.`;
    }

    return `You're at the top reward tier.`;
  }

  function renderLoading(root, msg) {
    qs(root, "[data-lcr-status]").textContent = msg || "Loading rewards…";
    qs(root, "[data-lcr-body]").innerHTML = "";
  }

  function renderError(root, msg) {
    qs(root, "[data-lcr-status]").textContent = msg || "Unable to load rewards.";
    qs(root, "[data-lcr-body]").innerHTML = "";
  }

  function renderLoginPrompt(root) {
    qs(root, "[data-lcr-status]").textContent = "Log in to view and redeem rewards.";
    qs(root, "[data-lcr-body]").innerHTML = "";
  }

  function renderState(root, state, cartSubtotalCents) {
    const body = qs(root, "[data-lcr-body]");

    const balance = state?.points?.balance ?? 0;
    const options = Array.isArray(state?.redemptionOptions) ? state.redemptionOptions : [];

    const minOrderDollars = getMinOrderDollars(state);
    const subtotalDollars = cartSubtotalCents != null ? centsToDollars(cartSubtotalCents) : null;
    const subtotalOk =
      minOrderDollars <= 0 || subtotalDollars == null ? true : subtotalDollars + 1e-9 >= minOrderDollars;

    const progressLine = computeProgressLine(balance, options);

    const effectiveOptions = options.map((o) => ({
      ...o,
      effectiveCanRedeem: Boolean(o?.canRedeem) && subtotalOk,
    }));

    const redeemable = effectiveOptions.filter((o) => o && o.effectiveCanRedeem);

    const lines = [];

    lines.push(`<div class="lcr-row"><strong>Points balance:</strong> ${balance}</div>`);

    if (progressLine) {
      lines.push(`<div class="lcr-muted">${progressLine}</div>`);
    }

    if (minOrderDollars > 0 && subtotalDollars != null) {
      if (subtotalOk) {
        lines.push(
          `<div class="lcr-muted">Cart subtotal: ${formatMoney(subtotalDollars)} (minimum to redeem: ${formatMoney(
            minOrderDollars,
          )}).</div>`,
        );
      } else {
        const needed = Math.max(0, minOrderDollars - subtotalDollars);
        lines.push(
          `<div class="lcr-muted">Add ${formatMoney(needed)} more to redeem points (minimum: ${formatMoney(
            minOrderDollars,
          )}).</div>`,
        );
      }
    }

    if (state?.redemption?.code) {
      lines.push(
        `<div class="lcr-active">Active code: <strong>${state.redemption.code}</strong> (expires ${new Date(
          state.redemption.expiresAt,
        ).toLocaleString()})</div>`,
      );
      lines.push(`<div class="lcr-muted">Use this code at checkout before it expires.</div>`);
    }

    if (!options.length) {
      lines.push(`<div class="lcr-muted">No redemption options configured.</div>`);
      body.innerHTML = lines.join("");
      return;
    }

    lines.push(`<div class="lcr-options"><div class="lcr-muted">Redeem now:</div>`);

    const defaultPoints = redeemable.length ? Number(redeemable[0].points) : null;

    effectiveOptions.forEach((o) => {
      const disabled = o.effectiveCanRedeem ? "" : "disabled";
      const label = `${o.points} points → ${formatMoney(o.valueDollars)} off`;
      const checked =
        !state?.redemption && defaultPoints != null && Number(o.points) === defaultPoints && o.effectiveCanRedeem
          ? "checked"
          : "";

      lines.push(
        `<label class="lcr-option"><input type="radio" name="lcr-redeem" value="${o.points}" ${disabled} ${checked} /> ${label}</label>`,
      );
    });

    lines.push(`</div>`);

    const buttonDisabled = !redeemable.length || Boolean(state?.redemption);
    lines.push(
      `<button type="button" class="lcr-btn" data-lcr-redeem-btn ${buttonDisabled ? "disabled" : ""}>Redeem &amp; checkout</button>`,
    );

    if (state?.redemption) {
      lines.push(`<div class="lcr-muted lcr-hint">You already have an active code. Use it at checkout.</div>`);
    } else {
      lines.push(`<div class="lcr-muted lcr-hint">We’ll apply your code and redirect you to checkout.</div>`);
    }

    body.innerHTML = lines.join("");
  }

  async function initOne(root) {
    const proxyPath = normalizePath(root.getAttribute("data-proxy-path") || "");
    if (!proxyPath) {
      renderError(root, "Missing app proxy path. Configure the block settings.");
      return;
    }

    renderLoading(root, "Loading rewards…");

    const loyaltyUrl = `${proxyPath}/loyalty.json`;
    const { res, data } = await fetchJson(loyaltyUrl, { method: "GET", headers: { Accept: "application/json" } });

    if (res.status === 401 || res.status === 403) {
      renderLoginPrompt(root);
      return;
    }

    if (!data || data.ok !== true) {
      renderError(root, data?.error || "Unable to load rewards.");
      return;
    }

    let cartSubtotalCents = readCartSubtotalCents(root);
    renderState(root, data, cartSubtotalCents);

    const btn = qs(root, "[data-lcr-redeem-btn]");
    if (!btn || btn.hasAttribute("disabled")) return;

    btn.addEventListener("click", async () => {
      try {
        const selected = qs(root, "input[name='lcr-redeem']:checked");
        const points = selected ? Number(selected.value) : NaN;
        if (!Number.isFinite(points) || points <= 0) {
          alert("Please select a reward to redeem.");
          return;
        }

        // Validate cart subtotal at click-time (covers AJAX cart updates)
        const minOrderDollars = getMinOrderDollars(data);
        if (minOrderDollars > 0) {
          const freshCents = await fetchCartSubtotalCents();
          if (freshCents != null) cartSubtotalCents = freshCents;
          const freshDollars = cartSubtotalCents != null ? centsToDollars(cartSubtotalCents) : null;
          if (freshDollars != null && freshDollars + 1e-9 < minOrderDollars) {
            alert(`Minimum cart subtotal to redeem points is ${formatMoney(minOrderDollars)}.`);
            return;
          }
        }

        btn.setAttribute("disabled", "disabled");
        btn.textContent = "Creating code…";

        const idem =
          (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
          `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;

        const redeemUrl = `${proxyPath}/redeem.json`;

        const { data: issued } = await fetchJson(redeemUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ pointsToRedeem: points, idempotencyKey: idem }),
        });

        if (!issued || issued.ok !== true || !issued.code) {
          const msg = issued?.error || "Failed to redeem points.";
          alert(msg);
          btn.removeAttribute("disabled");
          btn.textContent = "Redeem & checkout";
          return;
        }

        // v1.8: apply by redirect to /discount/<CODE>?redirect=/checkout
        const code = encodeURIComponent(issued.code);
        window.location.href = `/discount/${code}?redirect=/checkout`;
      } catch (err) {
        console.error(err);
        alert("Unexpected error redeeming points.");
        btn.removeAttribute("disabled");
        btn.textContent = "Redeem & checkout";
      }
    });
  }

  function initAll() {
    document.querySelectorAll("[data-lcr-cart-rewards]").forEach((el) => {
      initOne(el);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
})();
