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

const state = { client: null, version: null, product: null, selection: {}, qty: 1 };

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

/* ---------- rendering: the buy block ---------- */

// Lift choices arrive from Wix labelled in mm ("15mm"). Customers think in
// inches, so the card leads with inches and keeps mm underneath — Wix's
// checkout still shows its own label, and the two must visibly agree.
const LIFT_INFO = {
  15: { name: "Everyday", fit: "Sneakers & low-tops", bar: "0.9rem" },
  25: { name: "Step up", fit: "Boots & high-tops", bar: "1.6rem" },
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

function sizeLabel(label) {
  const clean = String(label || "").replace(/-/g, "–");
  return /^eu\b/i.test(clean) ? clean : `EU ${clean}`;
}

const isLiftOption = (o) => /lift|height/i.test(o.name);

function optionHtml(o, i) {
  const name = `opt-${i}`;
  const attrs = (c) =>
    `type="radio" name="${name}" value="${text(c.value)}" data-option="${text(
      o.name
    )}" data-option-id="${text(o.id || "")}" data-label="${text(c.label)}"`;

  if (isLiftOption(o)) {
    const cards = o.choices
      .map((c) => {
        const mm = liftMm(c.label);
        const info = (mm && LIFT_INFO[mm]) || {};
        const big = mm ? inches(mm) : text(c.label);
        return `
        <label class="choice">
          <input ${attrs(c)}>
          <span class="choice-face">
            <span class="lift-bar-wrap" aria-hidden="true"><span class="lift-bar" style="--h:${
              info.bar || "1rem"
            }"></span></span>
            <span class="lift-in">${big}</span>
            ${mm ? `<span class="lift-mm">${mm}mm lift</span>` : ""}
            ${info.name ? `<span class="lift-name">${info.name}</span>` : ""}
            ${info.fit ? `<span class="lift-fit">${info.fit}</span>` : ""}
          </span>
        </label>`;
      })
      .join("");
    return `
      <fieldset class="choice-group">
        <legend>${text(o.name)}</legend>
        <div class="choice-row">${cards}</div>
      </fieldset>`;
  }

  const isSize = /size/i.test(o.name);
  const pills = o.choices
    .map(
      (c) => `
        <label class="choice pill">
          <input ${attrs(c)}>
          <span class="choice-face">${text(isSize ? sizeLabel(c.label) : c.label)}</span>
        </label>`
    )
    .join("");
  return `
      <fieldset class="choice-group">
        <legend>${text(o.name)}</legend>
        <div class="pill-row">${pills}</div>
        ${
          isSize
            ? '<p class="choice-help">Between sizes? Take the larger band and trim to fit.</p>'
            : ""
        }
      </fieldset>`;
}

function pairsHtml() {
  // Wix sells one product, priced per pair. These are quantities, not packs
  // with their own prices — so no per-pack price is shown or implied here.
  const rows = [
    { n: 1, label: "1 pair", note: "Shipping calculated at checkout" },
    { n: 2, label: "2 pairs", tag: "Free shipping", note: "" },
    { n: 3, label: "3 pairs", tag: "Free shipping", note: "" },
  ];
  return `
    <fieldset class="choice-group">
      <legend>Pairs</legend>
      <div class="pair-list">
        ${rows
          .map(
            (r) => `
          <label class="choice pair">
            <input type="radio" name="qty" value="${r.n}"${
              r.n === state.qty ? " checked" : ""
            }>
            <span class="choice-face">
              <span class="pair-name">${r.label}${
                r.tag ? `<span class="pair-tag">${r.tag}</span>` : ""
              }</span>
              ${r.note ? `<span class="pair-note">${r.note}</span>` : ""}
            </span>
          </label>`
          )
          .join("")}
      </div>
    </fieldset>`;
}

function renderGallery(prod) {
  const box = el("#buy-gallery");
  if (!box || !prod.images.length) return;
  const imgs = prod.images.slice(0, 6);
  box.innerHTML = `
    <div class="buy-main"><img id="buy-main-img" src="${text(imgs[0])}" alt="${text(
      prod.name
    )}" width="900" height="900"></div>
    ${
      imgs.length > 1
        ? `<div class="buy-thumbs">${imgs
            .map(
              (src, i) =>
                `<button type="button" class="buy-thumb" data-src="${text(
                  src
                )}" aria-label="Show photo ${i + 1}" aria-pressed="${
                  i === 0
                }"><img src="${text(src)}" alt="" loading="lazy" width="120" height="120"></button>`
            )
            .join("")}</div>`
        : ""
    }`;
  box.querySelectorAll(".buy-thumb").forEach((b) =>
    b.addEventListener("click", () => {
      el("#buy-main-img").src = b.dataset.src;
      box
        .querySelectorAll(".buy-thumb")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    })
  );
}

function updateSummary() {
  const node = el("#buy-summary");
  if (!node) return;
  const parts = [];
  for (const o of state.product.options) {
    const s = state.selection[o.name];
    if (!s) continue;
    const mm = isLiftOption(o) ? liftMm(s.label) : null;
    parts.push(
      mm ? `${inches(mm)} lift` : /size/i.test(o.name) ? sizeLabel(s.label) : s.label
    );
  }
  parts.push(state.qty === 1 ? "1 pair" : `${state.qty} pairs`);
  node.textContent = parts.join(" · ");
}

function renderProduct(prod) {
  const mount = el("#shop");
  if (!mount) return;

  renderGallery(prod);

  const nameNode = el("#buy-name");
  if (nameNode && prod.name) nameNode.textContent = prod.name;

  const priceNode = el("#shop-price");
  if (priceNode) priceNode.textContent = prod.price || "";
  const priceRow = el("#buy-price");
  if (priceRow) priceRow.hidden = !prod.price;

  mount.innerHTML = `
    <div class="buy-panel">
      ${prod.options.map(optionHtml).join("")}
      ${pairsHtml()}
      <div>
        <a class="btn btn-block" id="buy" role="button" href="#order">Add to cart</a>
        <p class="buy-summary" id="buy-summary"></p>
        <p class="fineprint" id="shop-msg" role="status" aria-live="polite"></p>
      </div>
    </div>`;

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
      el("#shop-msg").textContent = "";
      refreshPrice();
      updateSummary();
    })
  );

  mount.querySelectorAll('input[name="qty"]').forEach((input) =>
    input.addEventListener("change", () => {
      if (input.checked) state.qty = Number(input.value) || 1;
      updateSummary();
    })
  );

  el("#buy").addEventListener("click", onBuy);
  updateSummary();

  // Swap: live product in, static placeholder out.
  mount.hidden = false;
  const stat = el("#static-offers");
  if (stat) stat.hidden = true;
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

    const qty = Math.max(1, Math.min(3, state.qty || 1));

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

    const { checkoutId } =
      await state.client.currentCart.createCheckoutFromCurrentCart({
        channelType: state.ChannelType?.WEB || "WEB",
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
