/* Page furniture: fallback buttons, marquee, footer year.
 * The live storefront lives in shop.js. No framework, no dependencies. */

(function () {
  "use strict";

  // The [data-offer] cards are the fallback shown only when the Wix
  // storefront cannot load. If Wix is unreachable there is no way to take an
  // order, so these are always disabled — they exist to keep the page intact,
  // not to sell. The real, live buy button is built by shop.js.
  document.querySelectorAll("[data-offer]").forEach(function (btn) {
    btn.removeAttribute("href");
    btn.setAttribute("aria-disabled", "true");
    btn.textContent = "Opening soon";
  });

  // Marquee needs its content tripled for the -33.3333% keyframe to loop
  // seamlessly. Done here so the text lives once in the HTML.
  var track = document.querySelector(".marquee-track");
  if (track && track.children.length === 1) {
    var original = track.children[0];
    for (var i = 0; i < 2; i++) {
      track.appendChild(original.cloneNode(true));
    }
  }

  // Current year in the footer.
  var yr = document.querySelector("[data-year]");
  if (yr) yr.textContent = new Date().getFullYear();
})();
