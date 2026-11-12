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

const state = { client: null, version: null, product: null, selection: {} };

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

  let tokens = null;
  try {
    tokens = JSON.parse(localStorage.getItem(TOKENS_KEY) || "null");
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
    localStorage.setItem(TOKENS_KEY, JSON.stringify(fresh));
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
    out.options = (p.options || []).map((o) => ({
      id: o.id,
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

/* ---------- rendering, using the page's existing classes ---------- */

function renderProduct(prod) {
  const mount = el("#shop");
  if (!mount) return;

  const img = prod.images[0];

  const optionsHtml = prod.options
    .map(
      (o) => `
      <label class="field">
        <span class="field-label">${text(o.name)}</span>
        <select data-option="${text(o.name)}" data-option-id="${text(o.id || "")}">
          <option value="">Choose ${text(o.name.toLowerCase())}</option>
          ${o.choices
            .map((c) => `<option value="${text(c.value)}">${text(c.label)}</option>`)
            .join("")}
        </select>
      </label>`
    )
    .join("");

  mount.innerHTML = `
    <div class="offer" data-featured>
      ${img ? `<img class="shop-img" src="${text(img)}" alt="${text(prod.name)}" loading="lazy" width="600" height="600">` : ""}
      <span class="offer-label">${text(prod.name)}</span>
      <span class="offer-price" id="shop-price">${text(prod.price || "")}</span>
      ${optionsHtml}
      <a class="btn btn-block" id="buy" role="button">Add to cart</a>
      <p class="fineprint" id="shop-msg" role="status" aria-live="polite"></p>
    </div>`;

  mount.querySelectorAll("select").forEach((s) =>
    s.addEventListener("change", () => {
      const name = s.dataset.option;
      if (!s.value) {
        delete state.selection[name];
      } else {
        state.selection[name] = {
          name,
          optionId: s.dataset.optionId,
          choiceId: s.value,
          label: s.selectedOptions[0]?.textContent || s.value,
        };
      }
      el("#shop-msg").textContent = "";
      refreshPrice();
    })
  );

  el("#buy").addEventListener("click", onBuy);

  // Swap: live product in, static placeholder cards out.
  mount.hidden = false;
  const stat = el("#static-offers");
  if (stat) stat.hidden = true;
}

function showLoading() {
  // Hide the static cards BEFORE fetching, not after. They carry hardcoded
  // prices; if Wix charges something different, flashing the old figure and
  // then replacing it shows the customer a price that was never real.
  const mount = el("#shop");
  const stat = el("#static-offers");
  if (stat) stat.hidden = true;
  if (mount) {
    mount.hidden = false;
    mount.innerHTML = `<div class="offer"><span class="offer-label">Loading…</span></div>`;
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

  // Surface it on the preview host only, so setup problems are obvious while
  // building without ever showing a stack trace to a real customer.
  if (location.hostname.endsWith("github.io") || location.hostname === "localhost") {
    const note = el("#shop-fallback");
    if (note) {
      note.hidden = false;
      note.textContent = `Wix not connected: ${message}`;
    }
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
    msg.textContent = `Choose ${missing.join(" and ")} first.`;
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
      // V3 takes the resolved variant.
      const variant = matchVariant(prod, state.selection);
      if (!variant?.id) throw new Error("That combination isn't available.");
      if (variant.inventoryStatus && variant.inventoryStatus.inStock === false) {
        throw new Error("That combination is out of stock.");
      }
      options = { variantId: variant.id };
    }

    await state.client.currentCart.addToCurrentCart({
      lineItems: [
        {
          catalogReference: {
            appId: CFG.storesAppId,
            catalogItemId: prod.id,
            options,
          },
          quantity: 1,
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
    msg.textContent =
      "Sorry — we couldn't start checkout. Please try again, or email support@blaxland.co.";
    console.error("[blaxland] checkout failed:", err);
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
