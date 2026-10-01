#!/usr/bin/env python3
"""
Generates the four PNGs app.json references, from the same geometry as the
web app's hero rings.

Kept in the repo because the images are derived, not authored: the radii and
stroke width below are TripleRing's out of `Finance/src/components/charts.tsx`
(viewBox 240, r = 100/78/56, strokeWidth 16) and the colours are --blue,
--green and --amber from globals.css. The sidebar <Logo> was the other
candidate, but its 32-unit box puts a 3.4 stroke on a 4.2 radius — which reads
as a dot at 28px and as a blob at 1024. If the rings ever change, change them
there and re-run:

    python assets/generate-icons.py

Needs Pillow. Nothing at build time reads this file.
"""

from math import cos, radians, sin

from PIL import Image, ImageDraw

BLUE = (0x1A, 0x73, 0xE8)
GREEN = (0x1E, 0x8E, 0x3E)
AMBER = (0xF9, 0xAB, 0x00)
WHITE = (0xFF, 0xFF, 0xFF)
PAGE = (0xF1, 0xF3, 0xF4)

SS = 4  # supersample factor — PIL has no round line caps, so draw big and shrink

VIEW = 240.0
STROKE = 16.0
# (radius, colour, fraction of the circle swept). The fractions are a plausible
# good month rather than anything computed: spending under budget with a little
# left, goals and investing both well along.
RINGS = [
    (100.0, BLUE, 0.72),
    (78.0, GREEN, 0.62),
    (56.0, AMBER, 0.55),
]


def draw_logo(size: int, scale: float, bg) -> Image.Image:
    """Rings centred in a `size` square, the 240-unit box scaled to `scale` of it."""
    big = size * SS
    img = Image.new("RGBA", (big, big), bg)
    d = ImageDraw.Draw(img)

    unit = (big * scale) / VIEW  # one logo unit, in supersampled pixels
    cx = cy = big / 2.0
    w = max(1, round(STROKE * unit))

    for r_units, colour, frac in RINGS:
        r = r_units * unit
        # ImageDraw.arc grows its line inward from the bounding box, so a box at
        # radius r puts the stroke's *centre* at r - w/2. Expanding the box by
        # half the width is what puts the centreline back on r, where the round
        # caps below assume it is.
        rb = r + w / 2.0
        box = (cx - rb, cy - rb, cx + rb, cy + rb)
        start = -90.0  # 12 o'clock, as transform="rotate(-90 …)" does
        end = start + 360.0 * frac
        d.arc(box, start=start, end=end, fill=colour + (255,), width=w)

        # Round caps, which ImageDraw.arc does not do: a disc of the stroke width
        # centred on each endpoint of the centreline.
        for ang in (start, end):
            px = cx + r * cos(radians(ang))
            py = cy + r * sin(radians(ang))
            h = w / 2.0
            d.ellipse((px - h, py - h, px + h, py + h), fill=colour + (255,))

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    # Store/launcher icon: opaque, because Play rejects transparency here.
    draw_logo(1024, 0.78, WHITE + (255,)).save("icon.png")

    # Android adaptive foreground: transparent, and small enough that the
    # launcher's circular mask cannot clip the outer ring. Android keeps the
    # middle 66% of the 108dp canvas, so 0.52 of the square leaves real margin.
    draw_logo(1024, 0.52, (0, 0, 0, 0)).save("adaptive-icon.png")

    # Splash: app.json paints --bg behind it, so this is transparent too.
    draw_logo(1024, 0.44, (0, 0, 0, 0)).save("splash.png")

    # Web favicon, in case `expo start --web` is ever used to eyeball a screen.
    draw_logo(48, 0.88, PAGE + (255,)).save("favicon.png")

    print("wrote icon.png, adaptive-icon.png, splash.png, favicon.png")


if __name__ == "__main__":
    main()
