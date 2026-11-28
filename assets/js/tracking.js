/* Ad and analytics tracking: Meta Pixel, plus GA4 once an ID is set.
 *
 * Ported from the Base44 build (src/lib/tracking.js). The Meta Pixel ID is the
 * one that was saved in Base44's Store Settings. Both IDs are PUBLIC — they
 * ship in every visitor's browser by design — so they belong in this repo.
 *
 * Each tag only loads when its ID is non-blank. Every event helper is a no-op
 * when its tag isn't loaded, so shop.js can call them unconditionally.
 *
 * Events sent (Meta standard events, GA4 recommended ecommerce events):
 *   PageView          every page load                     page_view (automatic)
 *   ViewContent       product screen opens                view_item
 *   AddToCart         Checkout pressed, cart filled       add_to_cart
 *   InitiateCheckout  handing off to Wix checkout         begin_checkout
 *   Purchase          thank-you page after a Wix order    purchase
 *
 * Purchase is only sent when this browser actually started a checkout (the
 * pending order saved at InitiateCheckout), and only once per order, so
 * reloading or revisiting /thank-you/ never counts a second sale.
 */

(function () {
  var TRACKING = {
    metaPixelId: "966645636064583",
    // GA4 Measurement ID, e.g. "G-ABC123XYZ9". Blank = GA4 not loaded.
    ga4Id: "",
  };

  var PENDING_KEY = "blaxland_pending_order";
  var SENT_KEY = "blaxland_purchases_sent";
  var meta = !!TRACKING.metaPixelId;
  var ga = !!TRACKING.ga4Id;

  /* ---------- Meta Pixel (Meta's standard base code) ---------- */
  if (meta) {
    /* eslint-disable */
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    /* eslint-enable */
    // The product screen changes the address bar (#lift, #size...). Without
    // this, Meta counts each of those as an extra PageView.
    window.fbq.disablePushState = true;
    window.fbq("init", TRACKING.metaPixelId);
    window.fbq("track", "PageView");
  }

  /* ---------- GA4 (gtag.js) ---------- */
  if (ga) {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(TRACKING.ga4Id);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", TRACKING.ga4Id);
  }

  /* ---------- helpers ---------- */
  function store(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }
  function readJson(key) {
    try { return JSON.parse(store("localStorage").getItem(key) || "null"); } catch (e) { return null; }
  }
  function writeJson(key, v) {
    try { store("localStorage").setItem(key, JSON.stringify(v)); } catch (e) { /* private mode */ }
  }
  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
  }

  // One shape in, both platforms out.
  //   d = { value, currency, qty, contentId, contentName }
  function metaParams(d) {
    var p = { currency: d.currency || "AUD", content_type: "product" };
    if (num(d.value) !== undefined) p.value = num(d.value);
    if (d.contentId) p.content_ids = [String(d.contentId)];
    if (d.contentName) p.content_name = d.contentName;
    if (d.qty) p.num_items = d.qty;
    return p;
  }
  function gaParams(d) {
    var p = {
      currency: d.currency || "AUD",
      items: [{
        item_id: String(d.contentId || "insole"),
        item_name: d.contentName || "BLAXLAND AIR insoles",
        quantity: d.qty || 1,
      }],
    };
    if (num(d.value) !== undefined) p.value = num(d.value);
    return p;
  }
  function send(metaEvent, gaEvent, d, eventId) {
    d = d || {};
    if (meta && window.fbq) {
      if (eventId) window.fbq("track", metaEvent, metaParams(d), { eventID: eventId });
      else window.fbq("track", metaEvent, metaParams(d));
    }
    if (ga && window.gtag) {
      var g = gaParams(d);
      if (eventId) g.transaction_id = eventId;
      window.gtag("event", gaEvent, g);
    }
  }

  var viewed = false;

  window.blxTrack = {
    viewContent: function (d) {
      if (viewed) return; // once per page load, not on every Back/Next
      viewed = true;
      send("ViewContent", "view_item", d);
    },
    addToCart: function (d) {
      send("AddToCart", "add_to_cart", d);
    },
    initiateCheckout: function (d) {
      send("InitiateCheckout", "begin_checkout", d);
      // Remember what they're buying so the thank-you page can report the
      // sale with its value. Wix's return URL carries no order total.
      var pending = {};
      for (var k in d) pending[k] = d[k];
      pending.at = Date.now();
      writeJson(PENDING_KEY, pending);
    },
    // Call on the thank-you page. orderId comes from Wix's return URL, if any.
    purchase: function (orderId) {
      var pending = readJson(PENDING_KEY);
      // No checkout started on this browser in the last 2 days: not a sale
      // we can vouch for, so don't report one.
      if (!pending || !pending.at || Date.now() - pending.at > 2 * 864e5) return;

      var id = orderId || "chk_" + pending.at;
      var sent = readJson(SENT_KEY) || [];
      if (sent.indexOf(id) !== -1) return;

      // The ID becomes Meta's eventID (de-dupes against a future server-side
      // event) and GA4's transaction_id (de-dupes repeat purchase hits).
      send("Purchase", "purchase", pending, id);
      sent.push(id);
      writeJson(SENT_KEY, sent.slice(-20));
      try { store("localStorage").removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
    },
  };
})();
