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

  /* ---------- home <-> product screen ----------
   * The product lives on its own screen (#order, class .flow) that slides in
   * from the right over the home page. The address bar carries where you are
   * (#lift, #size, #pairs, #checkout), so the phone's back gesture and the
   * browser back button walk back through the steps and out to the home page.
   * Old #order links still open it. shop.js listens for "blx:route" to move
   * between steps; this file only opens and closes the screen. */

  var SHOP_HASHES = ["#lift", "#order", "#size", "#pairs", "#checkout"];
  var root = document.documentElement;
  var shop = document.getElementById("order");
  var home = document.getElementById("home");
  var lastTrigger = null;

  function inShop(hash) {
    return SHOP_HASHES.indexOf(hash) > -1;
  }

  function setShop(open, animate) {
    if (!shop) return;
    var wasOpen = root.classList.contains("shop-open");
    if (!animate) root.classList.add("no-anim");
    root.classList.toggle("shop-open", open);
    shop.inert = !open;
    shop.setAttribute("aria-hidden", String(!open));
    if (home) home.inert = open;
    if (!animate) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          root.classList.remove("no-anim");
        });
      });
    }
    if (open && !wasOpen) {
      var body = document.getElementById("flow-body");
      if (body) body.scrollTop = 0;
      setTimeout(function () {
        var target = shop.querySelector("[data-flow-focus]") || shop;
        if (target.focus) target.focus({ preventScroll: true });
      }, animate ? 480 : 0);
    }
    if (!open && wasOpen && lastTrigger && lastTrigger.focus) {
      lastTrigger.focus({ preventScroll: true });
    }
  }

  function route(animate) {
    setShop(inShop(location.hash), animate);
    window.dispatchEvent(
      new CustomEvent("blx:route", {
        detail: { hash: location.hash, animate: animate },
      })
    );
  }

  // Navigation helpers shop.js uses. Every move inside the site adds a history
  // entry marked {blx: true}; "back" only uses the browser's history when the
  // previous entry is ours, so someone who landed straight on a step (from an
  // ad or a shared link) is taken to the previous step or home — never off
  // the site.
  window.blxNav = {
    go: function (hash) {
      history.pushState({ blx: true }, "", hash || location.pathname + location.search);
      route(true);
    },
    back: function (fallbackHash) {
      if (history.state && history.state.blx) {
        history.back();
      } else {
        history.replaceState(
          null,
          "",
          fallbackHash || location.pathname + location.search
        );
        route(true);
      }
    },
    replace: function (hash) {
      history.replaceState(history.state, "", hash);
    },
  };

  window.addEventListener("popstate", function () {
    route(true);
  });
  window.addEventListener("hashchange", function () {
    route(true);
  });

  var reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // A quick, eased run back to the top — fixed length whatever the distance,
  // so even from the footer it feels like one motion, not a long scroll.
  function scrollToTop(ms) {
    return new Promise(function (done) {
      var start = window.scrollY;
      if (start <= 0 || reduceMotion) {
        window.scrollTo(0, 0);
        return done();
      }
      var html = document.documentElement;
      var prev = html.style.scrollBehavior;
      html.style.scrollBehavior = "auto"; // the page's smooth scroll would fight each frame
      var t0 = null;
      function frame(t) {
        if (t0 === null) t0 = t;
        var p = Math.min(1, (t - t0) / ms);
        var eased = 1 - Math.pow(1 - p, 3);
        window.scrollTo(0, start * (1 - eased));
        if (p < 1) requestAnimationFrame(frame);
        else {
          html.style.scrollBehavior = prev;
          done();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  // Any link on the page to the product goes through the router, so it
  // slides rather than jumps. The floating pill first runs the page back up
  // to the top, then slides across — one continuous movement.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var href = a.getAttribute("href");
    if (!inShop(href)) return;
    e.preventDefault();
    if (inShop(location.hash)) return;
    var fromPill = a.classList.contains("jump-to-order");
    lastTrigger = fromPill ? document.querySelector(".hero .btn") || a : a;
    if (fromPill && window.scrollY > 0) {
      scrollToTop(450).then(function () {
        window.blxNav.go("#lift");
      });
    } else {
      window.blxNav.go("#lift");
    }
  });

  route(false);

  // "Choose your lift" pill: shown whenever the hero is off screen (and the
  // product screen isn't open), so there is always one tap back to buying.
  var jump = document.querySelector(".jump-to-order:not(.is-fixed)");
  var hero = document.querySelector(".hero");
  if (jump && hero && "IntersectionObserver" in window) {
    new IntersectionObserver(
      function (entries) {
        jump.hidden = entries[0].isIntersecting;
      },
      { threshold: 0.1 }
    ).observe(hero);
  }

  // Current year in the footer.
  var yr = document.querySelector("[data-year]");
  if (yr) yr.textContent = new Date().getFullYear();
})();
