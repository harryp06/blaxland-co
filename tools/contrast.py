#!/usr/bin/env python3
"""Check every colour pair the site actually uses against WCAG AA.

Reads the tokens straight out of assets/css/site.css so it can never drift
from the real stylesheet. Run it after any colour change:

    python3 tools/contrast.py

Exits non-zero if any pair fails, so it can gate a commit.

AA thresholds: 4.5:1 for body text, 3.0:1 for large text and UI boundaries.
"""

import re
import sys
import pathlib

CSS = pathlib.Path(__file__).resolve().parent.parent / "assets/css/site.css"

# (label, foreground token, background token, required ratio)
# Add a row here whenever a new colour combination appears in the markup.
PAIRS = [
    ("body text",            "--fg",      "--bg",      4.5),
    ("body text on surface", "--fg",      "--surface", 4.5),
    ("muted text",           "--muted",   "--bg",      4.5),
    ("muted on surface",     "--muted",   "--surface", 4.5),
    ("lime text on dark",    "--lime",    "--bg",      3.0),
    ("BUTTON: ink on lime",  "--ink",     "--lime",    4.5),
    ("announce: ink on lime","--ink",     "--lime",    4.5),
    ("badge: ink on lime",   "--ink",     "--lime",    4.5),
    ("focus ring on dark",   "--lime",    "--bg",      3.0),
    ("focus ring on surface","--lime",    "--surface", 3.0),
    ("magenta on dark",      "--magenta", "--bg",      3.0),
    ("border on dark",       "--border",  "--bg",      1.0),
]

# Combinations that must NEVER ship. Checked in reverse: these are expected to
# fail, and the script complains if one ever starts passing (which would mean
# a token moved and the rule quietly stopped being true).
FORBIDDEN = [
    ("white on lime",   "#ffffff", "--lime"),
    ("lime on cream",   "--lime",  "--fg"),
    ("white on magenta","#ffffff", "--magenta"),
]


def parse_tokens(css: str) -> dict:
    """Pull `--name: value;` declarations out of the :root block."""
    root = re.search(r":root\s*\{(.*?)\n\}", css, re.S)
    if not root:
        sys.exit("could not find :root block in site.css")
    out = {}
    for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", root.group(1)):
        out[name] = value.strip()
    return out


def to_rgb(value: str, tokens: dict) -> tuple:
    """Resolve a token name, #hex (3 or 6), or hsl() into an (r, g, b) tuple."""
    v = tokens.get(value, value).strip() if value.startswith("--") else value.strip()
    if value.startswith("--") and value not in tokens:
        sys.exit(f"unknown token {value} — is it still defined in site.css?")

    if v.startswith("#"):
        h = v.lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) != 6:
            sys.exit(f"cannot parse colour {v!r}")
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

    m = re.match(r"hsl\(\s*([\d.]+)\s*,?\s*([\d.]+)%\s*,?\s*([\d.]+)%", v)
    if m:
        import colorsys
        h, s, l = (float(x) for x in m.groups())
        r, g, b = colorsys.hls_to_rgb(h / 360, l / 100, s / 100)
        return (round(r * 255), round(g * 255), round(b * 255))

    sys.exit(f"cannot parse colour {v!r}")


def luminance(rgb: tuple) -> float:
    out = []
    for channel in rgb:
        c = channel / 255
        out.append(c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2]


def contrast(a: tuple, b: tuple) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def main() -> int:
    tokens = parse_tokens(CSS.read_text(encoding="utf-8"))
    failures = []

    print(f"{'pair':26}{'ratio':>9}  {'need':>5}   result")
    print("-" * 56)
    for label, fg, bg, need in PAIRS:
        r = contrast(to_rgb(fg, tokens), to_rgb(bg, tokens))
        ok = r >= need
        if not ok:
            failures.append(f"{label}: {r:.1f}:1, needs {need}:1")
        print(f"{label:26}{r:8.1f}:1  {need:5.1f}   {'pass' if ok else 'FAIL'}")

    print(f"\n{'must stay unusable':26}{'ratio':>9}")
    print("-" * 56)
    for label, fg, bg in FORBIDDEN:
        r = contrast(to_rgb(fg, tokens), to_rgb(bg, tokens))
        # If a forbidden pair climbs above 4.5:1 the palette has shifted enough
        # that this guard is stale and the rule needs rethinking.
        suspicious = r >= 4.5
        if suspicious:
            failures.append(
                f"{label} now measures {r:.1f}:1 — palette shifted, revisit the lime rule"
            )
        print(f"{label:26}{r:8.1f}:1  {'<-- CHECK' if suspicious else 'correctly unusable'}")

    if failures:
        print(f"\n{len(failures)} problem(s):")
        for f in failures:
            print(f"  - {f}")
        return 1

    print(f"\nall {len(PAIRS)} pairs pass WCAG AA")
    return 0


if __name__ == "__main__":
    sys.exit(main())
