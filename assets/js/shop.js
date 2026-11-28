/* Wix Headless storefront.
 *
 * Loads the product from Wix Stores and renders it into the page's existing
 * components. Adds to the Wix cart, then hands off to Wix's hosted checkout.
 *
 * CATALOG VERSIONS. Wix Stores has two, and a site uses one or the other.
 * There is no way to know which from the client ID alone, and Wix's own
 * guidance is: "Your plugin should try both APIs and use whichever one works."
 * So fetchProduct() tries V3, falls back to V1, and normalise() flattens
 * whichever came back into one internal shape. The cart line item differs too:
 *   V1 -> options: { options: { "Size": "EU 41-42", ... } }
 *   V3 -> options: { variantId: "<id>" }
 *
 * FAILURE BEHAVIOUR. If anything goes wrong — no client ID, network, Wix
 * errors, unexpected shapes — the page keeps the static content that is
 * already in the HTML and shows a short message. It must never leave a buy
 * button that looks live and isn't.
 */

const CFG = window.WIX_CONFIG || {};
const TOKENS_KEY = "blaxland_wix_tokens";

const state = { client: null, version: null, product: null, selection: {}, qty: 2, total: null };

/* Ad tracking (assets/js/tracking.js). Safe if that file didn't load. */
function track(name, extra) {
  const t = window.blxTrack;
  if (!t || typeof t[name] !== "function") return;
  try {
    t[name]({
      currency: CFG.currency || "AUD",
      contentId: state.product?.id || CFG.productId,
      contentName: state.product?.name || "BLAXLAND AIR",
      ...extra,
    });
  } catch (err) {
    console.warn("[blaxland] tracking:", err);
  }
}

/* ---------- welcome discount (Omnisend signup -> Wix coupon) ----------
 * The signup itself lives in Omnisend. All this does is remember, on this
 * browser, that the visitor signed up (and the email they used), so that at
 * checkout the Wix coupon goes on for them and their email is already filled
 * in. Nothing here grants a discount Wix doesn't already offer to anyone with
 * the code — the code is shown openly in the popup and the email. */

const WELCOME = CFG.welcome || null;
const WELCOME_KEY = "blaxland_welcome";

function readWelcome() {
  try {
    return JSON.parse(localStorage.getItem(WELCOME_KEY) || "null");
  } catch {
    return null;
  }
}

function saveWelcome(data) {
  try {
    const prev = readWelcome() || {};
    localStorage.setItem(
      WELCOME_KEY,
      JSON.stringify({ ...prev, ...data, at: Date.now() })
    );
  } catch {
    /* private mode etc. — the code can still be typed at checkout */
  }
}

const welcomeActive = () => Boolean(WELCOME?.coupon && readWelcome()?.code);

function captureWelcomeFromUrl() {
  // The welcome email links back with ?code=BLX15LND, so someone who signed up
  // on their phone and comes back on a laptop still gets it applied.
  if (!WELCOME?.coupon) return;
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (code && code.toUpperCase() === WELCOME.coupon.toUpperCase()) {
    saveWelcome({ code: true });
  }
}

function listenForSignup() {
  if (!WELCOME?.coupon) return;
  window.addEventListener("omnisendForms", (e) => {
    const d = e?.detail || {};
    const type = d.type || d.eventName;
    if (type !== "submit") return;
    if (WELCOME.omnisendFormId && d.form?.id && d.form.id !== WELCOME.omnisendFormId) return;
    const email = d.formValues?.emailField;
    saveWelcome({
      code: true,
      email: typeof email === "string" && email.includes("@") ? email.trim() : undefined,
    });
  });
}

/* ---------- helpers ---------- */

const el = (sel, root = document) => root.querySelector(sel);

function money(v) {
  // Display only. This NEVER does arithmetic on a price — no multiplying,
  // no dividing, no per-unit figures, no totals. Wix is the only thing
  // allowed to decide what a number is; this just prints the one it sent.
  //
  // Preference order:
  //   1. a string Wix already formatted  -> print verbatim
  //   2. an amount + currency from Wix   -> format with Intl, Wix's currency
  //   3. anything else                   -> print nothing
  // A missing price is correct behaviour. Inventing "A$" around a bare number
  // would be guessing at a currency, and a wrong currency is worse than none.
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v !== "object") return null;

  const preformatted =
    v.formattedAmount || v.formattedPrice || v.formatted?.price ||
    v.formatted?.amount || v.formattedConvertedAmount;
  if (preformatted) return preformatted;

  const amount = v.amount ?? v.price ?? v.value;
  // Catalog V3 returns amounts with no currency code, so fall back to the
  // label configured in wix-config.js. If that is unset, print nothing rather
  // than put a guessed symbol in front of a real number.
  const currency = v.currency || v.currencyCode || CFG.currency;
  if (amount == null || !currency) return null;

  try {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency,
    }).format(Number(amount));
  } catch {
    return null;
  }
}

function checkoutUrls() {
  // Production values live in wix-config.js. On the preview host, point back
  // at the preview so checkout is testable before DNS moves.
  const onPreview =
    location.hostname.endsWith("github.io") || location.hostname === "localhost";
  if (!onPreview) return { postFlow: CFG.urls.postFlow, thankYou: CFG.urls.thankYou };

  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  return { postFlow: base, thankYou: base + "thank-you/" };
}

function imageUrl(src) {
  // Wix returns either a plain https URL or a wix:image://v1/<fileId>/... URI.
  if (!src) return null;
  const raw = typeof src === "string" ? src : src.url || src.src || src.image;
  if (!raw) return null;
  if (typeof raw === "object") return imageUrl(raw);
  if (raw.startsWith("http")) return raw;
  const m = raw.match(/^wix:image:\/\/v1\/([^/#]+)/);
  return m ? `https://static.wixstatic.com/media/${m[1]}` : null;
}

function text(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

/* ---------- SDK ---------- */

async function makeClient() {
  if (!CFG.clientId || CFG.clientId === "PASTE_CLIENT_ID") {
    throw new Error(
      "No Wix client ID set. Put a real one in assets/js/wix-config.js."
    );
  }

  const [core, stores, ecom, redirectsMod] = await Promise.all([
    import(/* @vite-ignore */ CFG.sdk.core),
    import(/* @vite-ignore */ CFG.sdk.stores),
    import(/* @vite-ignore */ CFG.sdk.ecom),
    import(/* @vite-ignore */ CFG.sdk.redirects),
  ]);

  // Visitor tokens last 4 hours. Reusing an expired one produces an opaque
  // API failure that looks exactly like a code bug, so discard anything older
  // than 3 hours and let the SDK mint a fresh one.
  let tokens = null;
  try {
    const saved = JSON.parse(localStorage.getItem(TOKENS_KEY) || "null");
    if (saved && saved.savedAt && Date.now() - saved.savedAt < 3 * 60 * 60 * 1000) {
      tokens = saved.tokens;
    } else if (saved) {
      localStorage.removeItem(TOKENS_KEY);
      console.info("[blaxland] discarded stale Wix visitor tokens");
    }
  } catch {
    tokens = null;
  }

  const modules = { currentCart: ecom.currentCart, redirects: redirectsMod.redirects };
  // Only register the catalog modules the installed SDK actually exposes.
  if (stores.productsV3) modules.productsV3 = stores.productsV3;
  if (stores.products) modules.products = stores.products;

  const client = core.createClient({
    modules,
    auth: core.OAuthStrategy({ clientId: CFG.clientId, tokens }),
  });

  if (!tokens?.accessToken?.value) {
    const fresh = await client.auth.generateVisitorTokens();
    localStorage.setItem(
      TOKENS_KEY,
      JSON.stringify({ tokens: fresh, savedAt: Date.now() })
    );
  }

  state.ChannelType = ecom.currentCart?.ChannelType;
  return client;
}

/* ---------- catalog: try V3, fall back to V1 ---------- */

async function fetchProduct(client) {
  const errors = [];

  if (client.productsV3?.getProduct) {
    try {
      const r = await client.productsV3.getProduct(CFG.productId);
      const p = r?.product || r;
      if (p && (p._id || p.id)) return { version: "v3", product: p };
    } catch (e) {
      errors.push(`V3: ${e.message || e}`);
    }
  }

  if (client.products?.getProduct) {
    try {
      const r = await client.products.getProduct(CFG.productId);
      const p = r?.product || r;
      if (p && p._id) return { version: "v1", product: p };
    } catch (e) {
      errors.push(`V1: ${e.message || e}`);
    }
  }

  throw new Error(`Could not load the product. ${errors.join(" | ")}`);
}

/* ---------- normalise the two shapes into one ---------- */

function normalise(version, p) {
  const out = {
    id: p._id || p.id,
    name: p.name || "",
    description: p.plainDescription || p.description || "",
    price: null,
    images: [],
    options: [],
  };

  if (version === "v1") {
    out.price =
      money(p.priceData?.formatted?.price ? p.priceData.formatted : p.priceData) ||
      money(p.price);
    const main = p.media?.mainMedia;
    const items = p.media?.items || [];
    out.images = [main, ...items].map(imageUrl).filter(Boolean);
    out.options = (p.productOptions || []).map((o) => ({
      name: o.name,
      choices: (o.choices || []).map((c) => ({
        label: c.description || c.value,
        value: c.value,
      })),
    }));
  } else {
    // V3 moved prices into ranges and options into choicesSettings.
    const pr =
      p.actualPriceRange?.minValue ||
      p.compareAtPriceRange?.minValue ||
      p.priceRange?.minValue ||
      p.actualPrice ||
      p.price;
    out.price = money(pr);
    const main = p.media?.main || p.media?.mainMedia;
    const items = p.media?.itemsInfo?.items || p.media?.items || [];
    out.images = [main, ...items].map(imageUrl).filter(Boolean);
    // V3 matches variants by optionId + choiceId, never by name, so both IDs
    // have to survive normalisation.
    // The SDK uses Wix's `_id` convention where the raw REST API returns
    // `id`. Reading only `id` yields undefined, every optionId comparison in
    // matchVariant then fails, and NO variant ever resolves — which is
    // exactly how this broke. Accept both.
    out.options = (p.options || []).map((o) => ({
      id: o._id || o.id,
      name: o.name,
      choices: (o.choicesSettings?.choices || o.choices || []).map((c) => ({
        id: c.choiceId,
        label: c.name || c.key || c.choiceId,
        value: c.choiceId || c.name,
      })),
    }));
    out.variants = p.variantsInfo?.variants || [];
  }

  // Drop any option that has no choices — an empty <select> helps nobody.
  out.options = out.options.filter((o) => o.name && o.choices.length);
  return out;
}

/* ---------- the product flow: one decision per step ----------
 * Lift -> Size -> Pairs -> Checkout. Each step is its own panel; moving
 * between them slides in the direction of travel. The address bar holds the
 * step (#lift, #size, #pairs, #checkout) via site.js's router, so the back
 * gesture walks back a step. Price appears on the last step only. */

const STEPS = ["lift", "size", "pairs", "checkout"];
const NEXT_LABEL = ["Next: size", "Next: pairs", "Review order"];
const flow = { step: 0, liftOpt: null, sizeOpt: null, otherOpts: [] };

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Lift choices arrive from Wix labelled in mm ("15mm"). Customers think in
// inches, so the card leads with inches and keeps mm underneath.
const LIFT_INFO = {
  15: { name: "Daily", fit: "Sneakers & low-tops", bar: "0.9rem" },
  25: { name: "Air", fit: "Boots & high-tops", bar: "1.6rem" },
  35: { name: "Max", fit: "Roomy boots & high-tops", bar: "2.4rem" },
};

function liftMm(label) {
  const m = String(label || "").match(/(\d+(?:\.\d+)?)\s*mm/i);
  return m ? Number(m[1]) : null;
}

function inches(mm) {
  // Unit conversion of a physical length, not a price — 25.4mm to the inch.
  return `${(mm / 25.4).toFixed(1)}"`;
}

// Wix holds sizes as EU bands ("41-42"). Australians know their AU size, so
// the page shows AU men's sizes. AU men's = UK sizing; bands are made
// continuous so every whole and half size from 2.5 to 10 lands in exactly one
// band, rounding up (the insole trims down, it can't stretch). Brands' charts
// differ by up to half a size — check against the sample's length.
const EU_TO_AU = {
  "35-36": "2.5–3.5",
  "37-38": "4–5.5",
  "39-40": "6–6.5",
  "41-42": "7–8.5",
  "43-44": "9–10",
};

function sizeLabel(label) {
  // Shown as the bare AU range ("7–8.5"); the step's heading says they are
  // Australian men's sizes, so each button doesn't need to.
  const raw = String(label || "").trim();
  if (/\bau\b/i.test(raw)) return raw.replace(/\bau\b\s*/i, "").replace(/-/g, "–");
  const key = raw.replace(/^eu\s*/i, "").replace(/[–—]/g, "-").replace(/\s+/g, "");
  if (EU_TO_AU[key]) return EU_TO_AU[key];
  return `EU ${raw.replace(/-/g, "–")}`;
}

const isLiftOption = (o) => /lift|height/i.test(o.name);
const isSizeOption = (o) => /size/i.test(o.name);

function choiceInput(o, c, group) {
  return `type="radio" name="${group}" value="${text(c.value)}" data-option="${text(
    o.name
  )}" data-option-id="${text(o.id || "")}" data-label="${text(c.label)}"`;
}

/* --- height preview (optional) ---
 * "How tall are you?" turns the lift into a number they can picture. Shown
 * as three labelled steps so nothing is double-counted: barefoot, in their
 * shoes (a typical sneaker adds about an inch), then with the lift on top,
 * marked "up to" because the lift is insole thickness and some of it is
 * absorbed by the foot and the shoe. */
const SHOE_ALLOWANCE_IN = 1.0;

function fmtHeight(totalIn) {
  const halves = Math.round(totalIn * 2);
  const ft = Math.floor(halves / 24);
  const rem = halves / 2 - ft * 12;
  const whole = Math.floor(rem);
  return `${ft}'${whole}${rem - whole >= 0.5 ? "½" : ""}"`;
}

// Two scroll wheels, like a phone's time picker: feet 4–6, inches 0–11.
// They open on 5'9" but the result stays hidden until the visitor actually
// moves one, so it remains optional and never shows a height they didn't give.
const WHEELS = {
  ft: { values: [4, 5, 6], start: 5, unit: "ft", label: "Feet" },
  in: { values: Array.from({ length: 12 }, (_, n) => n), start: 9, unit: "in", label: "Inches" },
};
const height = { ft: WHEELS.ft.start, in: WHEELS.in.start, touched: false, quietUntil: 0 };

function wheelHtml(key) {
  const w = WHEELS[key];
  return `
    <div class="wheel-col" id="wheel-${key}" data-wheel="${key}" role="listbox"
         aria-label="${w.label}" tabindex="0">
      <div class="wheel-pad" aria-hidden="true"></div>
      ${w.values
        .map(
          (v) =>
            `<div class="wheel-item" role="option" id="wheel-${key}-${v}" data-v="${v}" aria-selected="false">${v} ${w.unit}</div>`
        )
        .join("")}
      <div class="wheel-pad" aria-hidden="true"></div>
    </div>`;
}

function heightHtml() {
  return `
    <div class="height-calc">
      <p class="height-q">How tall are you? <span>Optional — scroll to see your new height.</span></p>
      <div class="wheel">
        ${wheelHtml("ft")}
        ${wheelHtml("in")}
        <div class="wheel-band" aria-hidden="true"></div>
      </div>
      <div class="height-result" id="height-result" aria-live="polite" hidden></div>
      <p class="fineprint height-note" id="height-note" hidden>
        "In your shoes" allows about 1" for a typical sneaker. The lift is the
        insole's thickness at the heel and some is absorbed by your foot and
        shoe, so treat the last figure as the most you'll gain.
      </p>
    </div>`;
}

function markWheel(col, value) {
  col.querySelectorAll(".wheel-item").forEach((it) => {
    const on = Number(it.dataset.v) === value;
    it.classList.toggle("is-on", on);
    it.setAttribute("aria-selected", String(on));
    if (on) col.setAttribute("aria-activedescendant", it.id);
  });
}

function itemHeight(col) {
  return col.querySelector(".wheel-item")?.offsetHeight || 48;
}

function scrollWheelTo(col, value, smooth) {
  const w = WHEELS[col.dataset.wheel];
  const i = w.values.indexOf(value);
  if (i < 0) return;
  col.scrollTo({ top: i * itemHeight(col), behavior: smooth ? "smooth" : "auto" });
}

function positionWheels() {
  // Needs layout, so only once the lift step is on screen. Scroll events in
  // the next moment are our own positioning, not the visitor's.
  height.quietUntil = performance.now() + 300;
  document.querySelectorAll(".wheel-col").forEach((col) => {
    const key = col.dataset.wheel;
    scrollWheelTo(col, height[key], false);
    markWheel(col, height[key]);
  });
}

function initWheels() {
  document.querySelectorAll(".wheel-col").forEach((col) => {
    const key = col.dataset.wheel;
    const w = WHEELS[key];
    let t = null;
    col.addEventListener("scroll", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const i = Math.round(col.scrollTop / itemHeight(col));
        const v = w.values[Math.max(0, Math.min(w.values.length - 1, i))];
        markWheel(col, v);
        if (performance.now() < height.quietUntil) return; // our own positioning
        height[key] = v;
        height.touched = true;
        updateHeight();
      }, 90);
    });
    col.addEventListener("click", (e) => {
      const it = e.target.closest(".wheel-item");
      if (it) scrollWheelTo(col, Number(it.dataset.v), true);
    });
    col.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const i = w.values.indexOf(height[key]) + (e.key === "ArrowDown" ? 1 : -1);
      const v = w.values[Math.max(0, Math.min(w.values.length - 1, i))];
      scrollWheelTo(col, v, true);
    });
  });
  positionWheels();
}

function updateHeight() {
  const out = el("#height-result");
  const note = el("#height-note");
  if (!out) return;
  if (!height.touched) {
    out.hidden = true;
    note.hidden = true;
    return;
  }
  const sel = flow.liftOpt && state.selection[flow.liftOpt.name];
  const mm = sel ? liftMm(sel.label) : null;
  const barefoot = height.ft * 12 + height.in;
  const shod = barefoot + SHOE_ALLOWANCE_IN;
  const info = mm ? LIFT_INFO[mm] : null;
  out.innerHTML = `
    <div><span>Barefoot</span><strong>${fmtHeight(barefoot)}</strong></div>
    <div><span>In your shoes</span><strong>${fmtHeight(shod)}</strong></div>
    <div class="is-lift"><span>${
      mm ? `With ${text(info?.name || inches(mm))} (${inches(mm)})` : "Pick a lift"
    }</span><strong>${mm ? `up to ${fmtHeight(shod + mm / 25.4)}` : "—"}</strong></div>`;
  out.hidden = false;
  note.hidden = false;
}

/* --- step markup --- */

function stepLift(prod) {
  const o = flow.liftOpt;
  const img = prod.images[0];
  const cards = o.choices
    .map((c) => {
      const mm = liftMm(c.label);
      const info = (mm && LIFT_INFO[mm]) || {};
      return `
        <label class="choice">
          <input ${choiceInput(o, c, "lift")}>
          <span class="choice-face">
            <span class="lift-bar-wrap" aria-hidden="true"><span class="lift-bar" style="--h:${
              info.bar || "1rem"
            }"></span></span>
            <span class="lift-in">${mm ? inches(mm) : text(c.label)}</span>
            ${info.name ? `<span class="lift-name">${info.name}</span>` : ""}
            ${info.fit ? `<span class="lift-fit">${info.fit}</span>` : ""}
          </span>
        </label>`;
    })
    .join("");
  return `
    <div class="flow-step" data-step="0">
      ${
        img
          ? `<div class="flow-photo"><img src="${text(img)}" alt="${text(
              prod.name
            )}" width="900" height="900"></div>`
          : ""
      }
      <h3 class="flow-title" tabindex="-1" data-flow-focus>Choose your lift.</h3>
      <fieldset class="choice-group">
        <legend class="sr-only">${text(o.name)}</legend>
        <div class="choice-row">${cards}</div>
      </fieldset>
      ${heightHtml()}
    </div>`;
}

function pillsFor(o, group, labelFn) {
  return o.choices
    .map(
      (c) => `
        <label class="choice pill">
          <input ${choiceInput(o, c, group)}>
          <span class="choice-face">${text(labelFn ? labelFn(c.label) : c.label)}</span>
        </label>`
    )
    .join("");
}

function stepSize() {
  const o = flow.sizeOpt;
  const others = flow.otherOpts
    .map(
      (x, i) => `
      <fieldset class="choice-group">
        <legend>${text(x.name)}</legend>
        <div class="pill-row">${pillsFor(x, `opt-${i}`)}</div>
      </fieldset>`
    )
    .join("");
  return `
    <div class="flow-step" data-step="1" hidden>
      <h3 class="flow-title" tabindex="-1">What size shoe do you wear?</h3>
      ${
        o
          ? `<fieldset class="choice-group">
        <legend>Australian men's sizes</legend>
        <div class="size-row">${pillsFor(o, "size", sizeLabel)}</div>
        <p class="choice-help">Between sizes? Take the larger one and trim to fit.</p>
      </fieldset>`
          : ""
      }
      ${others}
    </div>`;
}

// Small aeroplane = free shipping (orders of 2+). Labelled for screen readers.
const PLANE_SVG = `<svg class="pair-ship" width="18" height="18" viewBox="0 0 24 24" role="img" aria-label="Free shipping"><title>Free shipping</title><path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z" transform="rotate(90 12 12)"/></svg>`;

/* --- bundle prices (display) ---
 * From CFG.bundles, which mirrors the Wix automatic discounts and shipping
 * rate. Per-pair figures are labelled as such and never presented as the
 * amount payable; the review step shows Wix's own total. */
const BUNDLES = CFG.bundles || null;

function aud(n) {
  const v = Math.round(n * 100) / 100;
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

function packPrice(n) {
  return BUNDLES?.packs?.[n] ?? null;
}

// Same aeroplane, silent: the words "Free shipping" sit right beside it.
const PLANE_ICON = PLANE_SVG.replace(
  'role="img" aria-label="Free shipping"><title>Free shipping</title>',
  'aria-hidden="true">'
);

function stepPairs() {
  // Main offer is the 2-pack (selected by default, strongest emphasis). The
  // 5-pack is the value anchor, kept last so $115 isn't the first price seen.
  const single = BUNDLES?.single;
  const delivered1 = single ? single.price + single.shipping : null;
  const two = packPrice(2);
  const rows = [
    { n: 1, label: "1 pair", note: "One pair to try" },
    { n: 2, label: "2 pairs", tag: "Recommended", main: true, note: "One for your everyday shoes. One for going out." },
    { n: 3, label: "3 pairs", note: "Sneakers, boots and work shoes" },
    { n: 5, label: "5 pairs", tag: "Best value", note: "One in every pair you own" },
  ];
  const priceHtml = (r) => {
    const total = packPrice(r.n);
    if (total == null) return "";
    if (r.n === 1 && single) {
      return `<span class="pair-price"><strong>${aud(single.price)}</strong><span>+ ${aud(
        single.shipping
      )} shipping</span></span>`;
    }
    return `<span class="pair-price"><strong>${aud(total)}</strong><span>${aud(
      total / r.n
    )} per pair</span></span>`;
  };
  const shipHtml = (r) =>
    r.n >= 2
      ? `<span class="pair-free">${PLANE_ICON}Free shipping</span>`
      : delivered1
      ? `<span class="pair-free is-paid">${aud(delivered1)} delivered</span>`
      : "";
  const pitch =
    delivered1 && two
      ? `<p class="pairs-pitch">One pair is <strong>${aud(delivered1)}</strong> delivered. Get two for just <strong>${aud(
          two - delivered1
        )}</strong> more.</p>`
      : "";
  return `
    <div class="flow-step" data-step="2" hidden>
      <h3 class="flow-title" tabindex="-1">How many pairs?</h3>
      ${pitch}
      <fieldset class="choice-group">
        <legend class="sr-only">Pairs</legend>
        <div class="pair-list">
          ${rows
            .map(
              (r) => `
            <label class="choice pair${r.main ? " is-main" : ""}">
              <input type="radio" name="qty" value="${r.n}"${r.n === state.qty ? " checked" : ""}>
              <span class="choice-face">
                ${
                  r.tag
                    ? `<span class="pair-tag">${r.tag}${
                        r.n === 5 && packPrice(5) ? ` — ${aud(packPrice(5) / 5)}/pair` : ""
                      }</span>`
                    : ""
                }
                <span class="pair-top">
                  <span class="pair-name">${r.label}</span>
                  ${priceHtml(r)}
                </span>
                <span class="pair-bottom">
                  <span class="pair-note">${r.note}</span>
                  ${shipHtml(r)}
                </span>
              </span>
            </label>`
            )
            .join("")}
        </div>
      </fieldset>
      <p class="choice-help">Every pair in a pack comes in the lift and size you picked.</p>
    </div>`;
}

function stepReview() {
  return `
    <div class="flow-step" data-step="3" hidden>
      <h3 class="flow-title" tabindex="-1">Your order.</h3>
      <dl class="review">
        <div><dt>Lift</dt><dd id="rv-lift"></dd><button type="button" class="flow-change" data-go="#lift">Change</button></div>
        <div><dt>Size</dt><dd id="rv-size"></dd><button type="button" class="flow-change" data-go="#size">Change</button></div>
        <div><dt>Pairs</dt><dd id="rv-pairs"></dd><button type="button" class="flow-change" data-go="#pairs">Change</button></div>
      </dl>
      <div class="quote" id="quote" aria-live="polite">
        <div class="quote-row"><span id="q-items-label">Pairs</span><span id="q-items">—</span></div>
        <div class="quote-row" id="q-disc-row" hidden><span>Welcome discount</span><span id="q-disc"></span></div>
        <div class="quote-row"><span>Shipping</span><span id="q-ship">—</span></div>
        <div class="quote-row is-total"><span>Total (AUD)</span><span id="q-total">—</span></div>
        <p class="fineprint quote-note" id="q-note">Calculating your total…</p>
      </div>
      <ul class="buy-assure">
        <li><svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2"></path></svg><span><strong>Arrives in 5–12 business days</strong>, with tracking emailed when it ships</span></li>
        <li><svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2"></path></svg>Secure checkout</li>
        <li><svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2"></path></svg><span>Questions? <a href="mailto:support@blaxland.co">support@blaxland.co</a></span></li>
      </ul>
      <p class="fineprint">
        All prices in Australian dollars, confirmed at checkout with any
        shipping. We ship within Australia only. Lift is the insole's thickness
        at the heel, not a measurement of how much taller you will stand —
        see the <a href="faq.html">FAQ</a>.
      </p>
    </div>`;
}

/* --- step logic --- */

function stepDone(i) {
  if (i === 0) return Boolean(flow.liftOpt && state.selection[flow.liftOpt.name]);
  if (i === 1) {
    const need = [flow.sizeOpt, ...flow.otherOpts].filter(Boolean);
    return need.every((o) => state.selection[o.name]);
  }
  if (i === 2) return [1, 2, 3, 5].includes(state.qty);
  return true;
}

function furthestAllowed() {
  for (let i = 0; i < 3; i++) if (!stepDone(i)) return i;
  return 3;
}

function updateActions() {
  const next = el("#flow-next");
  const buy = el("#buy");
  if (!next || !buy) return;
  const last = flow.step === 3;
  next.hidden = last;
  buy.hidden = !last;
  if (!last) {
    next.textContent = NEXT_LABEL[flow.step];
    next.disabled = !stepDone(flow.step);
  }
  const msg = el("#shop-msg");
  if (msg && !last) msg.textContent = "";
}

function updateProgress() {
  const count = el("#flow-count");
  if (count) count.textContent = `Step ${flow.step + 1} of 4`;
  document.querySelectorAll("#flow-progress li").forEach((li, i) => {
    li.classList.toggle("is-done", i < flow.step);
    li.classList.toggle("is-current", i === flow.step);
  });
}

function updateReview() {
  const sel = state.selection;
  const lift = flow.liftOpt && sel[flow.liftOpt.name];
  const size = flow.sizeOpt && sel[flow.sizeOpt.name];
  const mm = lift ? liftMm(lift.label) : null;
  const info = mm ? LIFT_INFO[mm] : null;
  const set = (id, v) => {
    const n = el(id);
    if (n) n.textContent = v;
  };
  set("#rv-lift", lift ? `${info?.name ? info.name + " · " : ""}${mm ? inches(mm) : lift.label}` : "—");
  set("#rv-size", size ? sizeLabel(size.label) : "—");
  set("#rv-pairs", state.qty === 1 ? "1 pair" : `${state.qty} pairs`);
  quoteOrder();
}

/* --- the total, from Wix ---
 * The review step builds the real cart (same as Checkout does) and asks Wix
 * to price it for delivery in Australia, so the total on screen is the one
 * Wix will charge: bundle price, any welcome coupon, and shipping. */
let quoteSeq = 0;

function wixMoney(v) {
  if (!v) return null;
  return v.formattedAmount || money({ amount: v.amount });
}

async function quoteOrder() {
  const seq = ++quoteSeq;
  const set = (id, v) => {
    const n = el(id);
    if (n) n.textContent = v;
  };
  set("#q-items-label", state.qty === 1 ? "1 pair" : `${state.qty} pairs`);
  ["#q-items", "#q-ship", "#q-total"].forEach((id) => set(id, "…"));
  set("#q-note", "Calculating your total…");
  const discRow = el("#q-disc-row");
  try {
    await prepareCart();
    const t = await state.client.currentCart.estimateCurrentCartTotals({
      shippingAddress: { country: "AU" },
    });
    if (seq !== quoteSeq) return; // a newer choice is already being priced
    const p = t.priceSummary || {};
    const disc = Number(p.discount?.amount || 0);
    const ship = Number(p.shipping?.amount || 0);
    set("#q-items", wixMoney(p.subtotal) || "—");
    if (discRow) discRow.hidden = !(disc > 0);
    if (disc > 0) set("#q-disc", `−${wixMoney(p.discount)}`);
    set("#q-ship", ship > 0 ? wixMoney(p.shipping) : "Free");
    set("#q-total", wixMoney(p.total) || "—");
    state.total = Number(p.total?.amount) || null;
    set("#q-note", "Calculated by our checkout for delivery within Australia.");
  } catch (err) {
    if (seq !== quoteSeq) return;
    console.warn("[blaxland] could not price the order:", err);
    ["#q-items", "#q-ship", "#q-total"].forEach((id) => set(id, "—"));
    if (discRow) discRow.hidden = true;
    set("#q-note", err?.message?.includes("stock") ? err.message : "Your total will show at checkout, before you pay.");
  }
}

function showStep(target, animate) {
  const steps = [...document.querySelectorAll("#shop .flow-step")];
  if (!steps.length) return;
  const from = flow.step;
  const cur = steps[from];
  const next = steps[target];
  flow.step = target;
  if (target === 0 && !height.touched) requestAnimationFrame(positionWheels);
  updateProgress();
  updateActions();
  if (target === 3) updateReview();
  // Product screen is open. tracking.js sends this once per page load.
  track("viewContent", { value: BUNDLES?.single?.price, qty: 1 });

  const body = el("#flow-body");
  if (cur === next || !animate || prefersReducedMotion()) {
    steps.forEach((s, i) => (s.hidden = i !== target));
    if (body) body.scrollTop = 0;
    return;
  }

  // Slide in the direction of travel: forward moves left, back moves right.
  const dir = target > from ? 1 : -1;
  const ease = "cubic-bezier(.22,.61,.36,1)";
  steps.forEach((s, i) => {
    if (s !== cur && s !== next) s.hidden = true;
  });
  cur.animate(
    [
      { transform: "translateX(0)", opacity: 1 },
      { transform: `translateX(${-dir * 32}%)`, opacity: 0 },
    ],
    { duration: 220, easing: ease }
  ).onfinish = () => {
    cur.hidden = true;
    if (body) body.scrollTop = 0;
    next.hidden = false;
    next.animate(
      [
        { transform: `translateX(${dir * 32}%)`, opacity: 0 },
        { transform: "translateX(0)", opacity: 1 },
      ],
      { duration: 320, easing: ease }
    );
    next.querySelector(".flow-title")?.focus({ preventScroll: true });
  };
}

function handleRoute(hash, animate) {
  if (!el("#shop .flow-step")) return;
  const name = hash === "#order" ? "lift" : String(hash || "").slice(1);
  const want = STEPS.indexOf(name);
  if (want < 0) return; // home: site.js has closed the screen
  const allowed = Math.min(want, furthestAllowed());
  if (allowed !== want) window.blxNav?.replace(`#${STEPS[allowed]}`);
  showStep(allowed, animate);
}

function goNext() {
  if (!stepDone(flow.step) || flow.step >= 3) return;
  window.blxNav?.go(`#${STEPS[flow.step + 1]}`);
}

function goBack() {
  if (flow.step > 0) window.blxNav?.back(`#${STEPS[flow.step - 1]}`);
  else window.blxNav?.back();
}

function renderProduct(prod) {
  const mount = el("#shop");
  if (!mount) return;

  flow.liftOpt = prod.options.find(isLiftOption) || null;
  flow.sizeOpt = prod.options.find(isSizeOption) || null;
  flow.otherOpts = prod.options.filter((o) => o !== flow.liftOpt && o !== flow.sizeOpt);
  if (!flow.liftOpt) {
    // Without a lift option there is no first step to show.
    fallback("No Lift option on the Wix product.");
    return;
  }

  mount.innerHTML = stepLift(prod) + stepSize() + stepPairs() + stepReview();

  mount.querySelectorAll("input[data-option]").forEach((input) =>
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const name = input.dataset.option;
      state.selection[name] = {
        name,
        optionId: input.dataset.optionId,
        choiceId: input.value,
        label: input.dataset.label,
      };
      updateActions();
      updateHeight();
    })
  );
  mount.querySelectorAll('input[name="qty"]').forEach((input) =>
    input.addEventListener("change", () => {
      if (input.checked) state.qty = Number(input.value) || 1;
      updateActions();
    })
  );
  initWheels();
  mount.querySelectorAll(".flow-change").forEach((b) =>
    b.addEventListener("click", () => window.blxNav?.go(b.dataset.go))
  );

  el("#flow-next")?.addEventListener("click", goNext);
  el("#flow-back")?.addEventListener("click", goBack);
  el("#buy")?.addEventListener("click", onBuy);
  window.addEventListener("blx:route", (e) => handleRoute(e.detail?.hash, e.detail?.animate));

  // Live product in, static placeholder out.
  mount.hidden = false;
  const stat = el("#static-offers");
  if (stat) stat.hidden = true;

  flow.step = 0;
  updateProgress();
  updateActions();
  handleRoute(location.hash, false);
}

function showLoading() {
  // Hide the static fallback BEFORE fetching, not after, so a stale message
  // never flashes over a working store.
  const mount = el("#shop");
  const stat = el("#static-offers");
  if (stat) stat.hidden = true;
  if (mount) {
    mount.hidden = false;
    mount.innerHTML = `<p class="fineprint" style="margin:0">Loading…</p>`;
  }
  // The back arrow must work even before the product arrives.
  el("#flow-back")?.addEventListener("click", () => {
    if (!el("#shop .flow-step")) window.blxNav?.back();
  });
}

function fallback(message) {
  // Put the static cards back — they are the honest default state.
  const mount = el("#shop");
  const stat = el("#static-offers");
  if (mount) {
    mount.hidden = true;
    mount.innerHTML = "";
  }
  if (stat) stat.hidden = false;
  const actions = el("#flow-actions");
  if (actions) actions.hidden = true;

  // Customers see the normal
  // page with its honest "Opening soon" buttons; the real reason goes to the
  // console, where Harry can read it and a customer never has to.
  console.warn("[blaxland] Wix storefront unavailable:", message);

  // Shown everywhere while we are still bringing this online. There are no
  // customers yet, and a visible reason is worth far more right now than a
  // tidy page that hides why the store isn't loading. Restrict this to the
  // preview host again once the first real order has gone through.
  const note = el("#shop-fallback");
  if (note) {
    note.hidden = false;
    note.textContent = `Store not loading: ${message}`;
  }
}

/* ---------- cart + checkout ---------- */

function matchVariant(prod, selection) {
  // V3 only. Verified against the live store: a variant's choices look like
  //   { optionChoiceIds: { optionId, choiceId } }
  // There are no names in there at all, so matching must be on IDs.
  if (!prod.variants?.length) return null;
  const want = Object.values(selection);
  return (
    prod.variants.find((v) =>
      want.every((sel) =>
        (v.choices || []).some(
          (c) =>
            c.optionChoiceIds?.optionId === sel.optionId &&
            c.optionChoiceIds?.choiceId === sel.choiceId
        )
      )
    ) || null
  );
}

function variantPrice(variant) {
  return money(variant?.price?.actualPrice || variant?.price);
}

function refreshPrice() {
  // Once every option is chosen, show that exact variant's price straight from
  // Wix. Still no arithmetic — this reads a different field, it doesn't derive
  // a number from another one.
  const node = el("#shop-price");
  if (!node || state.version !== "v3") return;
  const chosen = Object.keys(state.selection).length;
  if (chosen < state.product.options.length) {
    node.textContent = state.product.price || "";
    return;
  }
  const v = matchVariant(state.product, state.selection);
  node.textContent = (v && variantPrice(v)) || state.product.price || "";
}

/* Put exactly what's chosen on the page into the visitor's Wix cart:
 * empty it, add the variant at the chosen quantity, apply the welcome coupon
 * if they signed up. Used by both the review step's total and Checkout. */
// Cart operations run one at a time. The review step prices the order while
// the visitor may already be pressing Checkout; both empty and refill the cart,
// and interleaved they could leave two copies in it.
let cartQueue = Promise.resolve();
function inCartQueue(fn) {
  const run = cartQueue.then(fn, fn);
  cartQueue = run.catch(() => {});
  return run;
}

function prepareCart() {
  return inCartQueue(fillCart);
}

async function fillCart() {
  const prod = state.product;
  let options;
  if (state.version === "v1") {
    // V1 takes a plain name -> chosen-value map.
    const map = {};
    for (const s of Object.values(state.selection)) map[s.name] = s.label;
    options = { options: map };
  } else {
    // V3 takes the resolved variant. Same `_id` / `id` caveat as above.
    const variant = matchVariant(prod, state.selection);
    const variantId = variant?._id || variant?.id;
    if (!variantId) throw new Error("That combination isn't available.");
    if (variant.inventoryStatus && variant.inventoryStatus.inStock === false) {
      throw new Error(
        "That option is out of stock in Wix — set its inventory in the Wix dashboard."
      );
    }
    options = { variantId };
  }

  // Only the pack sizes on the page: 1, 2, 3 or 5 pairs.
  const qty = [1, 2, 3, 5].includes(state.qty) ? state.qty : 1;

  // Start from an empty cart every time. Wix keeps a visitor's cart between
  // visits, so without this, coming back and pressing Add to cart again
  // would stack a second lot on top of the first (5 + 5 = 10 pairs) and drag
  // old picks into checkout. What they chose on this page is what they buy.
  try {
    await state.client.currentCart.deleteCurrentCart();
  } catch {
    /* no cart yet — expected on a first visit */
  }

  await state.client.currentCart.addToCurrentCart({
    lineItems: [
      {
        catalogReference: {
          appId: CFG.storesAppId,
          catalogItemId: prod.id,
          options,
        },
        quantity: qty,
      },
    ],
  });

  // Signed up for the welcome discount? Put the coupon on. If Wix refuses
  // it (coupon missing, already used by this customer), carry on without
  // it — a full-price checkout beats a failed one, and the code can still
  // be typed at checkout.
  if (welcomeActive()) {
    try {
      await state.client.currentCart.updateCurrentCart({
        couponCode: WELCOME.coupon,
      });
    } catch (err) {
      console.warn("[blaxland] welcome coupon not applied:", err?.details?.applicationError?.code || err);
    }
  }
}

async function onBuy(e) {
  e.preventDefault();
  const btn = el("#buy");
  const msg = el("#shop-msg");
  const prod = state.product;

  const missing = prod.options
    .map((o) => o.name)
    .filter((n) => !state.selection[n]);
  if (missing.length) {
    msg.textContent = `Choose your ${missing
      .map((n) => n.toLowerCase())
      .join(" and ")} first.`;
    return;
  }

  btn.setAttribute("aria-disabled", "true");
  const original = btn.textContent;
  btn.textContent = "Working…";

  try {
    // Pre-fill the email they gave the popup, so checkout opens one field
    // shorter. Only ever the address typed on this browser.
    const email = readWelcome()?.email;
    const { checkoutId } = await inCartQueue(async () => {
      await fillCart();
      return state.client.currentCart.createCheckoutFromCurrentCart({
        channelType: state.ChannelType?.WEB || "WEB",
        ...(email ? { email } : {}),
      });
    });

    const urls = checkoutUrls();
    const redirect = await state.client.redirects.createRedirectSession({
      ecomCheckout: { checkoutId },
      callbacks: {
        // After a completed order.
        thankYouPageUrl: urls.thankYou,
        // If they abandon or the flow is interrupted.
        postFlowUrl: urls.postFlow,
      },
    });

    const url = redirect?.redirectSession?.fullUrl;
    if (!url) throw new Error("Wix did not return a checkout URL.");

    // Wix's own total when the review step got one, else the bundle price.
    const order = { value: state.total ?? packPrice(state.qty), qty: state.qty };
    track("addToCart", order);
    track("initiateCheckout", order);
    // Pass the URL through untouched — its query string carries state Wix
    // needs to render the hosted page, and the docs are explicit that it must
    // not be stripped, reordered or rewritten.
    window.location = url;
  } catch (err) {
    btn.removeAttribute("aria-disabled");
    btn.textContent = original;

    // Show the ACTUAL reason, not a generic apology. Every failure used to
    // render the same sentence, which made the error useless for diagnosis —
    // it could equally have been a stale token, an unavailable variant or a
    // rejected redirect, and there was no way to tell them apart.
    const detail =
      err?.details?.applicationError?.description ||
      err?.message ||
      String(err);

    msg.innerHTML =
      '<strong>Checkout failed.</strong> ' +
      text(detail) +
      '<br>Please try again, or email ' +
      '<a href="mailto:support@blaxland.co">support@blaxland.co</a>.';

    // Full object to the console for anything the message doesn't capture.
    console.error("[blaxland] checkout failed:", err);
    console.error("[blaxland] selection:", JSON.stringify(state.selection));
    console.error("[blaxland] catalog version:", state.version);
    if (err?.response) console.error("[blaxland] response:", err.response);
  }
}

/* ---------- boot ---------- */

(async function init() {
  // Before anything else, so a signup that happens while the store is still
  // loading is not missed.
  captureWelcomeFromUrl();
  listenForSignup();

  if (!el("#shop")) return;

  // Nothing configured yet: leave the page exactly as authored, say so in the
  // console, and don't hide anything.
  if (!CFG.clientId || CFG.clientId === "PASTE_CLIENT_ID") {
    fallback("No Wix client ID set in assets/js/wix-config.js.");
    return;
  }

  showLoading();
  try {
    state.client = await makeClient();
    const { version, product } = await fetchProduct(state.client);
    state.version = version;
    state.product = normalise(version, product);
    if (!state.product.id) throw new Error("Product came back without an ID.");
    renderProduct(state.product);
    console.info(`[blaxland] Wix Stores Catalog ${version.toUpperCase()}`);
  } catch (err) {
    fallback(err.message || String(err));
  }
})();
