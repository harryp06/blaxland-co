/* Wix Headless connection settings — the only file you edit to wire this up.
 *
 * The client ID is a PUBLIC credential. Wix's own documentation hardcodes it
 * in browser JavaScript, so it belongs in this repo. The client SECRET and any
 * API key never do — those are for server-side admin calls, which this site
 * does not make.
 *
 * Get the client ID from: Wix dashboard > Settings > Headless Settings,
 * creating a client with the "Visitors and Members (OAuth)" strategy.
 *
 * Also add these to the client's ALLOWED REDIRECT DOMAINS in the same screen,
 * or Wix will block the return trip from checkout:
 *   https://harryp06.github.io
 *   https://blaxland.co
 */

window.WIX_CONFIG = {
  // ⚠️ NOT YET SET. The site falls back to its static content until this is a
  // real ID. "PASTE_CLIENT_ID" is the placeholder, not a value.
  clientId: "PASTE_CLIENT_ID",

  // The volt green insole.
  productId: "e6198709-88f4-4449-bc06-f7502bf189aa",

  // Wix Stores' own app ID. Same on every Wix site — don't change it.
  storesAppId: "215238eb-22a5-4c36-9e7b-e7c08025e04e",

  // Where Wix sends the customer when the hosted checkout finishes.
  //   thankYou   — after a successful order
  //   postFlow   — if they abandon or the flow is interrupted
  // Both must be listed as ALLOWED REDIRECT DOMAINS in Headless Settings or
  // Wix refuses the redirect. On the github.io preview these are overridden
  // with the preview origin, so checkout can be tested before DNS moves —
  // which means the preview host needs allowlisting too.
  urls: {
    postFlow: "https://www.blaxland.co",
    thankYou: "https://www.blaxland.co/thank-you",
  },

  // SDK modules, pinned to exact versions. esm.sh serves the npm packages as
  // browser ES modules, which is what lets this work with no build step.
  // Pinned deliberately: an unpinned @latest would let a third party change
  // the code running on the storefront without us doing anything.
  sdk: {
    core: "https://esm.sh/@wix/sdk@1.21.18",
    stores: "https://esm.sh/@wix/stores@1.0.991",
    ecom: "https://esm.sh/@wix/ecom@1.0.2667",
    redirects: "https://esm.sh/@wix/redirects@1.0.134",
  },
};
