"""Render the Panelhouse and Back Room source icons (a house made of comic panels).

Usage: python assets/make_icons.py <out_dir>, then copy panelhouse.png to
src/TachiDesk/includes/icon.png and backroom.png to src/BackRoom/includes/icon.png.
"""
import sys
from PIL import Image, ImageDraw, ImageFilter

S = 1280          # draw at 4x, downsample to OUT for clean edges
OUT = 320         # Paperback 0.8 icons in this repo are 320x320 RGBA
INK = (16, 14, 24)


def rounded_tile(color_top, color_bottom):
    tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / (S - 1)
        gd.line([(0, y), (S, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(color_top, color_bottom)) + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=255)
    tile.paste(grad, (0, 0), mask)
    return tile


def halftone(draw, box, color, step, r):
    x0, y0, x1, y1 = box
    # Keep whole dots inside the panel so they don't bleed into the gutter
    for j, y in enumerate(range(int(y0) + step // 2, int(y1 - r), step)):
        for x in range(int(x0) + step // 2 + (step // 2 if j % 2 else 0), int(x1 - r), step):
            draw.ellipse((x - r, y - r, x + r, y + r), fill=color)


def house(img, roof, wall_a, wall_b, wall_c, door=None, dots=None, glow=None):
    d = ImageDraw.Draw(img)
    g = int(S * 0.028)                       # gutter width
    left, right = S * 0.20, S * 0.80
    eave, base = S * 0.47, S * 0.80
    peak = (S * 0.50, S * 0.17)

    # Ink silhouette first; panels are inset from it, so gutters read as comic borders
    outline = [(left - g, eave + g * 0.4), peak[0:1] + (peak[1] - g * 1.6,), (right + g, eave + g * 0.4)]
    d.polygon([outline[0], (peak[0], peak[1] - g * 1.6), outline[2]], fill=INK)
    d.rectangle((left - g, eave - g, right + g, base + g), fill=INK)

    # Roof panel
    d.polygon([(left + g * 0.9, eave - g), (peak[0], peak[1] + g * 0.9), (right - g * 0.9, eave - g)], fill=roof)
    # Wall: one tall panel on the left, two stacked on the right
    split_x = S * 0.47
    split_y = (eave + base) / 2
    a = (left, eave, split_x - g / 2, base)
    b = (split_x + g / 2, eave, right, split_y - g / 2)
    c = (split_x + g / 2, split_y + g / 2, right, base)
    for box, color in ((a, wall_a), (b, wall_b), (c, wall_c)):
        d.rectangle(box, fill=color)
    if dots:
        halftone(d, b, dots, step=int(S * 0.034), r=int(S * 0.0085))
    if door:
        dx0, dx1 = a[0] + (a[2] - a[0]) * 0.28, a[0] + (a[2] - a[0]) * 0.72
        dy0 = a[1] + (a[3] - a[1]) * 0.36
        if glow:
            halo = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ImageDraw.Draw(halo).rounded_rectangle((dx0 - g * 3, dy0 - g * 3, dx1 + g * 3, a[3]), radius=g * 3, fill=glow)
            img.alpha_composite(halo.filter(ImageFilter.GaussianBlur(g * 2.5)))
            d = ImageDraw.Draw(img)
        d.rounded_rectangle((dx0, dy0, dx1, a[3] + g), radius=int((dx1 - dx0) / 2), fill=door)
    return img


def save(img, path):
    img.resize((OUT, OUT), Image.LANCZOS).save(path)


out_dir = sys.argv[1]
panel = house(rounded_tile((54, 46, 120), (24, 20, 58)),
              roof=(255, 112, 92), wall_a=(255, 241, 214), wall_b=(64, 196, 196), wall_c=(255, 196, 77),
              door=INK, dots=(36, 148, 150))
save(panel, out_dir + "/panelhouse.png")

back = house(rounded_tile((46, 18, 40), (14, 8, 16)),
             roof=(120, 30, 58), wall_a=(54, 26, 48), wall_b=(84, 34, 66), wall_c=(66, 28, 56),
             door=(255, 72, 88), dots=(110, 44, 86), glow=(255, 40, 70, 150))
save(back, out_dir + "/backroom.png")
print("ok")
