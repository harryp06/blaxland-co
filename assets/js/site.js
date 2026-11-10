/* Wires offer buttons to their Stripe Payment Links.
 * No build step, no framework, no dependencies. */

(function () {
  "use strict";

  var cfg = window.BLAXLAND || { paymentLinks: {}, storeOpen: false };
  var links = cfg.paymentLinks || {};

  document.querySelectorAll("[data-offer]").forEach(function (btn) {
    var url = links[btn.dataset.offer];
    var ready = cfg.storeOpen && typeof url === "string" && url.length > 0;

    if (ready) {
      btn.setAttribute("href", url);
      btn.removeAttribute("aria-disabled");
    } else {
      btn.removeAttribute("href");
      btn.setAttribute("aria-disabled", "true");
      btn.textContent = "Opening soon";
    }
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
