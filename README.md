# blaxland.co

Static storefront for BLAXLAND 30 height insoles. Plain HTML, CSS and a few
lines of vanilla JS. No build step, no dependencies, no framework.

## Why it's built this way

Hosted on GitHub Pages, which serves static files only — it cannot run
server-side code. Checkout is therefore handled entirely by **Stripe Payment
Links**: the buttons link out to Stripe's hosted pages, and Stripe collects the
shipping address, takes the payment, emails the receipt and keeps the order
record. There is no server, no database and no secret key anywhere in this
repository.

Height and size are collected as Stripe **custom fields** — one dropdown per
pair, each listing all 15 height x size combinations. Stripe allows a maximum
of three custom fields per link, which is exactly enough for the three-pair
pack.

## Layout

```
index.html          the whole storefront (one page)
policies.html       shipping, returns, privacy and terms
assets/css/site.css design tokens and all styling
assets/js/config.js >>> THE ONLY FILE YOU NEED TO EDIT <<<
assets/js/site.js   wires the buttons to the links in config.js
.nojekyll           tells GitHub Pages to serve the files as-is
```

## Going live

1. Create three Payment Links in the Stripe Dashboard. The settings each one
   needs are listed in the comment block at the top of `assets/js/config.js`.
2. Paste the three URLs into `assets/js/config.js`.
3. Complete one real end-to-end test purchase and confirm the receipt arrives
   and the order appears in the Stripe Dashboard.
4. Only then set `storeOpen: true` in the same file.
5. Commit and push. GitHub Pages redeploys automatically.

Until step 4, every order button renders disabled and reads "Opening soon".
This is deliberate: a button that looks live but fails is worse than one that
is honestly switched off.

## Prices

Prices appear in `index.html` as display text only. **Stripe is the authority
on what is actually charged.** If the page and Stripe ever disagree, Stripe is
right and the HTML is the bug. Nothing here duplicates a price into a second
file that has to be kept in sync.

Current display prices: A$52.95 (1 pair), A$94.95 (2 pairs), A$137.95 (3
pairs). Shipping A$9.95 on one pair, free on two or more.

## Local preview

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Colour

Near-black base, cream body text, and **lime (`#D8FF00`) as the single
accent** — roughly 5% of the page, reserved almost entirely for the action.
Hue 69°, sampled from the product photography.

One hard rule, because the numbers are brutal:

| | ratio | |
|---|---|---|
| black on lime | **18.2:1** | use this |
| lime on near-black | **17.1:1** | use this |
| white on lime | **1.2:1** | never |
| lime on cream | **1.0:1** | never — literally invisible |

Lime is a surface you put *black* text on, or text on a dark background.
Wherever `--lime` is a background, the foreground must be `--ink`.

Magenta (`#ED2AD0`) exists for urgency only — a price drop, low stock — at
tiny surface area. It is never a second button. The page must only ever have
one loudest thing on it, or the call to action stops being it.

After any colour change:

```sh
python3 tools/contrast.py
```

It reads the tokens straight out of `site.css`, checks every pair the site
uses against WCAG AA, and exits non-zero on failure. It also verifies the
forbidden combinations are *still* unusable, so the rule above can't quietly
stop being true.

## Claims policy

Three rules, and they are not negotiable:

1. **No delivery estimate is published until the supplier confirms one in
   writing**, with the business-day convention named.
2. **No change-of-mind or money-back guarantee is advertised until its terms
   are written down** — when the clock starts, who pays return postage, and
   what condition the item must be in.
3. **No reviews, star ratings, testimonials, customer counts or statistics
   until they are real.** Not AI-generated, not illustrative, not "coming
   soon" with a number attached.

Stated height is the thickness of the insole, never a promise of how much
taller the wearer will stand. Australian Consumer Law rights are stated and
never disclaimed.
