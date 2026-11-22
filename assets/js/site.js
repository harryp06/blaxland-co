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

  // Blur-up: fade each photo in over its placeholder once it has decoded.
  // Images already in cache fire no load event, so check .complete too —
  // otherwise a returning visitor sees a permanently blurred page.
  document.querySelectorAll(".ph img").forEach(function (img) {
    if (img.complete && img.naturalWidth > 0) {
      img.classList.add("loaded");
    } else {
      img.addEventListener("load", function () {
        img.classList.add("loaded");
      });
      // If it fails, show it anyway rather than leave a blurred ghost.
      img.addEventListener("error", function () {
        img.classList.add("loaded");
      });
    }
  });

  // "Choose your lift" pill: on the home page, show it whenever neither the
  // hero (which has its own button) nor the product section is on screen, so
  // from anywhere further down there is always one tap back to buying.
  var jump = document.querySelector(".jump-to-order:not(.is-fixed)");
  var hero = document.querySelector(".hero");
  var order = document.getElementById("order");
  if (jump && order && "IntersectionObserver" in window) {
    var visible = new Set();
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) visible.add(e.target);
          else visible.delete(e.target);
        });
        jump.hidden = visible.size > 0;
      },
      { threshold: 0.15 }
    );
    io.observe(order);
    if (hero) io.observe(hero);
  }

  // Current year in the footer.
  var yr = document.querySelector("[data-year]");
  if (yr) yr.textContent = new Date().getFullYear();
})();
