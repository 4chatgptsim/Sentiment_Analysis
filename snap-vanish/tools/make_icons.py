"""Draws the Snap Vanish icon: a glowing orb crumbling into dust to the right."""
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 1024
out_dir = Path(sys.argv[1])
random.seed(7)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# Rounded-square dark background.
bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(bg)
d.rounded_rectangle((32, 32, S - 32, S - 32), radius=220, fill=(24, 16, 44, 255))
img.alpha_composite(bg)

# Orb with a purple → gold gradient, eaten away on its right side.
cx, cy, r = 430, 512, 250
orb = Image.new("RGBA", (S, S), (0, 0, 0, 0))
px = orb.load()
for y in range(cy - r, cy + r):
    for x in range(cx - r, cx + r):
        dx, dy = x - cx, y - cy
        if dx * dx + dy * dy > r * r:
            continue
        # erosion front: noisy, further right = more eaten
        front = cx + 0.35 * r + 70 * math.sin(y / 37.0) + 40 * math.sin(y / 13.0 + 1.3)
        if x > front:
            continue
        t = (dy + r) / (2 * r)
        c0, c1 = (167, 139, 250), (253, 211, 77)
        col = tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3))
        shade = 1.0 - 0.35 * ((dx * dx + dy * dy) / (r * r))
        px[x, y] = tuple(int(c * shade) for c in col) + (255,)
img.alpha_composite(orb)

# Dust: particles drifting right, getting smaller and fainter.
dust = Image.new("RGBA", (S, S), (0, 0, 0, 0))
dd = ImageDraw.Draw(dust)
for _ in range(420):
    t = random.random() ** 0.8
    x = cx + 0.25 * r + t * 520 + random.gauss(0, 18)
    y = cy + random.gauss(0, 150 * (1 - 0.5 * t)) - t * 120
    size = (1 - t) * 30 + 6
    a = int(255 * (1 - t) ** 1.2)
    col = (253, 211, 77, a) if random.random() < 0.5 else (196, 181, 253, a)
    dd.rectangle((x, y, x + size, y + size), fill=col)
dust = dust.filter(ImageFilter.GaussianBlur(1.5))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((32, 32, S - 32, S - 32), radius=220, fill=255)
clipped = Image.new("RGBA", (S, S), (0, 0, 0, 0))
clipped.paste(dust, (0, 0), mask)
img.alpha_composite(clipped)

for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(out_dir / f"icon{size}.png")
