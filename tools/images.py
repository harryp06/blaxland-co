#!/usr/bin/env python3
"""Turn a photo into everything the page needs to load it fast.

    python3 tools/images.py ~/photos/hero.jpg --name hero --aspect 4:5

Produces, in assets/img/:
  <name>-480.webp, -768.webp, -1200.webp, -1600.webp   responsive sizes
  <name>.jpg                                            fallback for old browsers
and prints a ready-to-paste HTML snippet with the LQIP inlined.

LQIP = Low Quality Image Placeholder. A ~20px-wide blurred copy of the photo,
encoded as a base64 data URI small enough to inline directly in the HTML. It
arrives with the document — zero extra requests, zero round trips — so the
visitor sees a blurred impression of the real photo instantly, which sharpens
when the full image lands. It is the trick that makes a page feel instant on a
phone over mobile data.

The wrapper also carries an explicit aspect-ratio, so the browser reserves the
right amount of space before the image loads. Without it the page jumps as
each photo arrives, which is the single most irritating thing a mobile page
can do and is penalised directly by Core Web Vitals (CLS).
"""

import argparse
import base64
import io
import json
import pathlib
import sys

try:
    from PIL import Image, ImageFilter
except ImportError:
    sys.exit("Pillow is required:  pip install Pillow")

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "img"
WIDTHS = [480, 768, 1200, 1600]
LQIP_WIDTH = 20
WEBP_QUALITY = 78
JPEG_QUALITY = 82


def build_lqip(im: Image.Image) -> str:
    """A tiny blurred JPEG as a base64 data URI."""
    w, h = im.size
    small = im.resize((LQIP_WIDTH, max(1, round(LQIP_WIDTH * h / w))), Image.LANCZOS)
    small = small.filter(ImageFilter.GaussianBlur(1))
    buf = io.BytesIO()
    small.convert("RGB").save(buf, "JPEG", quality=40, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def crop_to_aspect(im: Image.Image, aspect: str) -> Image.Image:
    """Centre-crop to w:h, e.g. '4:5'. Returns unchanged if aspect is None."""
    if not aspect:
        return im
    aw, ah = (float(x) for x in aspect.split(":"))
    target = aw / ah
    w, h = im.size
    current = w / h
    if abs(current - target) < 0.01:
        return im
    if current > target:          # too wide — trim the sides
        new_w = round(h * target)
        left = (w - new_w) // 2
        return im.crop((left, 0, left + new_w, h))
    new_h = round(w / target)     # too tall — trim top and bottom
    top = (h - new_h) // 2
    return im.crop((0, top, w, top + new_h))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="path to the original photo")
    ap.add_argument("--name", required=True, help="slug, e.g. 'hero' or 'flex'")
    ap.add_argument("--aspect", default=None, help="centre-crop ratio, e.g. 4:5")
    ap.add_argument("--alt", default="", help="alt text for the snippet")
    ap.add_argument("--eager", action="store_true",
                    help="set for the hero only — it is above the fold")
    a = ap.parse_args()

    src = pathlib.Path(a.source).expanduser()
    if not src.exists():
        sys.exit(f"no such file: {src}")

    OUT.mkdir(parents=True, exist_ok=True)
    im = Image.open(src)
    im = im.convert("RGB")
    # Honour EXIF rotation, or phone photos come out sideways.
    try:
        from PIL import ImageOps
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass
    im = crop_to_aspect(im, a.aspect)

    w, h = im.size
    lqip = build_lqip(im)
    written = []

    for target in WIDTHS:
        if target > w:
            continue
        resized = im.resize((target, round(target * h / w)), Image.LANCZOS)
        path = OUT / f"{a.name}-{target}.webp"
        resized.save(path, "WEBP", quality=WEBP_QUALITY, method=6)
        written.append((target, path))

    if not written:                      # source smaller than the smallest size
        path = OUT / f"{a.name}-{w}.webp"
        im.save(path, "WEBP", quality=WEBP_QUALITY, method=6)
        written.append((w, path))

    fallback = OUT / f"{a.name}.jpg"
    im.resize((min(1200, w), round(min(1200, w) * h / w)), Image.LANCZOS).save(
        fallback, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True
    )

    manifest_path = OUT / "manifest.json"
    manifest = {}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    manifest[a.name] = {
        "lqip": lqip,
        "widths": [t for t, _ in written],
        "aspect": round(w / h, 4),
        "alt": a.alt,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2))

    srcset = ", ".join(f"assets/img/{p.name} {t}w" for t, p in written)
    loading = 'loading="eager" fetchpriority="high"' if a.eager else 'loading="lazy"'

    print(f"\nwrote {len(written)} webp + 1 jpg to assets/img/")
    for t, p in written:
        print(f"  {p.name:24} {p.stat().st_size // 1024:4} KB")
    print(f"  {fallback.name:24} {fallback.stat().st_size // 1024:4} KB  (fallback)")
    print(f"  LQIP inline: {len(lqip)} chars")
    if len(lqip) > 1800:
        print("  ⚠ LQIP is large; lower LQIP_WIDTH or the JPEG quality")

    print("\n--- paste this ---\n")
    print(f'<div class="ph" style="aspect-ratio:{w}/{h};'
          f'background-image:url({lqip})">')
    print(f'  <img src="assets/img/{a.name}.jpg"')
    print(f'       srcset="{srcset}"')
    print(f'       sizes="(min-width: 46rem) 50vw, 100vw"')
    print(f'       alt="{a.alt}" width="{w}" height="{h}" {loading} decoding="async">')
    print("</div>")


if __name__ == "__main__":
    main()
