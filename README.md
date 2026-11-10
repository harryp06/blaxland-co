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
