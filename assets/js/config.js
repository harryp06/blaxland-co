/* BLAXLAND 30 — the only file you edit to wire up checkout.
 *
 * Each offer points at a Stripe Payment Link. Create them in the Stripe
 * Dashboard (Payments > Payment Links), then paste the URLs here.
 *
 * Deliberately, prices are NOT duplicated in this file. The old Base44 build
 * kept prices in three places (storeFacts.js, offers.js, pricing.ts) and had
 * comment blocks warning they MUST MATCH. Stripe is now the single authority
 * on what is charged; the figures in index.html are display only. If they ever
 * disagree with Stripe, Stripe wins and the HTML is the bug.
 *
 * WHEN BUILDING EACH PAYMENT LINK, SET:
 *   - Currency ................. AUD
 *   - Shipping address ......... collect, Australia only
 *   - Shipping rates ........... A$9.95 on the 1-pair link, free on 2- and 3-pair
 *   - Promotion codes .......... allow
 *   - Custom fields ............ one dropdown per pair, labelled "Pair 1" etc.
 *                                with all 15 height x size options.
 *                                Stripe allows a maximum of 3 custom fields,
 *                                which is exactly enough for the 3-pair link.
 *   - After payment ............ show confirmation page, send receipt
 *
 * Leave a URL as null and its button renders disabled with "Opening soon".
 */

window.BLAXLAND = {
  paymentLinks: {
    single: null,
    double: null,
    set: null,
  },

  // Flip to true only when all three links above are live AND a real test
  // purchase has completed end to end.
  storeOpen: false,
};
