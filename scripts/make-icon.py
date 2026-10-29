#!/usr/bin/env python3
"""Renders the discotech icon: a mirror ball on a transparent background.

Usage: scripts/make-icon.py <resources dir> <sidebar logo png> <taskbar preview png>
Writes icon.png (512 px) and icon.ico (16-256 px; a bolder, simpler ball up to 64 px) into the
resources dir, the 128 px sidebar logo, and a preview of the small sizes on light and dark
taskbars. Needs Pillow.
"""
import math, sys
from PIL import Image, ImageDraw, ImageFilter

S = 1024  # working canvas; downsampled for each size

def render(bands: int, background: bool = True, bold: bool = False) -> Image.Image:
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Background: black rounded square with a subtle vertical sheen.
    pad, radius = 64, 200
    bg = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / S
        c = int(38 - 26 * t)
        gd.line([(0, y), (S, y)], fill=(c, c, c, 255))
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, S - pad, S - pad], radius, fill=255)
    bg.paste(grad, (0, 0), mask)
    if background:
        img = Image.alpha_composite(img, bg)
    d = ImageDraw.Draw(img)

    cx, cy, r = S / 2, S / 2 + 20, 330
    light = (-0.45, -0.6, 0.66)
    ln = math.sqrt(sum(v * v for v in light))
    light = tuple(v / ln for v in light)
    tilt = math.radians(18)

    def project(lat, lon):
        x = math.cos(lat) * math.sin(lon)
        y = math.sin(lat)
        z = math.cos(lat) * math.cos(lon)
        # tilt toward the viewer around the x axis
        y, z = y * math.cos(tilt) - z * math.sin(tilt), y * math.sin(tilt) + z * math.cos(tilt)
        return x, y, z

    tiles = []
    for i in range(bands):
        lat0 = -math.pi / 2 + math.pi * i / bands
        lat1 = lat0 + math.pi / bands
        latm = (lat0 + lat1) / 2
        n = max(4, round(2 * bands * math.cos(latm)))
        for j in range(n):
            lon0 = 2 * math.pi * j / n
            lon1 = lon0 + 2 * math.pi / n
            g = 0.11 if bold else 0.07  # grout between tiles, as a fraction of the tile
            a0, a1 = lat0 + g * (lat1 - lat0), lat1 - g * (lat1 - lat0)
            o0, o1 = lon0 + g * (lon1 - lon0), lon1 - g * (lon1 - lon0)
            corners = [project(a0, o0), project(a0, o1), project(a1, o1), project(a1, o0)]
            nx, ny, nz = project(latm, (lon0 + lon1) / 2)
            if nz <= 0.02:
                continue
            tiles.append((nz, corners, (nx, ny, nz), i, j))
    tiles.sort(key=lambda t: t[0])
    # Ball body (the grout colour) behind the tiles.
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(28, 28, 30, 255))
    for nz, corners, (nx, ny, nz2), i, j in tiles:
        pts = [(cx + x * r, cy - y * r) for x, y, z in corners]
        diff = max(0.0, nx * light[0] + (-ny) * light[1] + nz2 * light[2])
        # mirror tiles: mostly mid-grey, bright where they face the light, darker at the rim
        if bold:
            # Few tones, strong contrast: reads as a ball, not as noise, at taskbar sizes.
            v = 235 if diff > 0.75 else 175 if diff > 0.45 else 115
        else:
            v = 70 + 150 * diff ** 1.6 + 25 * ((i * 7 + j * 13) % 5) / 4
        v = min(255, v)
        fill = (int(v), int(v), int(v * 1.02 if v < 250 else v), 255)
        if diff > 0.93:
            fill = (255, 255, 255, 255)
        d.polygon(pts, fill=fill)
    # Warm glints, the orange of the Claude mark used in the status bar.
    # Tiles just beside the brightest spot, on the lit side of the ball.
    side = (-0.55, -0.05, 0.83)
    lit = sorted(tiles, key=lambda t: -(t[2][0] * side[0] + (-t[2][1]) * side[1] + t[2][2] * side[2]))
    glints = [lit[0], lit[3]] if bold else [lit[0], lit[5]]
    for k, (nz, corners, _, _, _) in enumerate(glints):
        pts = [(cx + x * r, cy - y * r) for x, y, z in corners]
        d.polygon(pts, fill=(217, 119, 87, 255) if k else (240, 150, 110, 255))
    # Soft rim shading and a specular highlight.
    shade = Image.new('L', (S, S), 0)
    sd = ImageDraw.Draw(shade)
    for k in range(60):
        rr = r - k
        sd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=int(110 * (1 - k / 60) ** 2), width=2)
    img = Image.composite(Image.new('RGBA', (S, S), (0, 0, 0, 255)), img, shade)
    spec = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(spec).ellipse([cx - 175, cy - 205, cx - 75, cy - 125], fill=(255, 255, 255, 150))
    img = Image.alpha_composite(img, spec.filter(ImageFilter.GaussianBlur(28)))
    d = ImageDraw.Draw(img)
    # Thin dark rim and sparkle outline keep the shape on light and dark taskbars alike.
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(45, 45, 48, 255), width=int(r * 0.03))
    # Four-point sparkle on the lit side.
    sx, sy, L, w = cx - r * 0.68, cy - r * 0.66, r * 0.34, r * 0.075
    star = [(sx, sy - L), (sx + w, sy - w), (sx + L, sy), (sx + w, sy + w), (sx, sy + L), (sx - w, sy + w), (sx - L, sy), (sx - w, sy - w)]
    d.polygon(star, fill=(255, 255, 255, 255), outline=(45, 45, 48, 255), width=int(r * 0.025))
    if background:
        d.line([(cx, pad + 40), (cx, cy - r)], fill=(150, 150, 150, 255), width=10)
    # Square around the ball and the sparkle.
    m = r * 1.08
    return img.crop((int(cx - m), int(cy - m), int(cx + m), int(cy + m))).resize((S, S), Image.LANCZOS)

out_dir = sys.argv[1]
big = render(bands=12, background=False)
small = render(bands=6, background=False, bold=True)  # fewer, larger tiles stay readable at taskbar sizes
big.resize((512, 512), Image.LANCZOS).save(f'{out_dir}/icon.png')
sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [(small if s <= 64 else big).resize((s, s), Image.LANCZOS) for s in sizes]
frames[-1].save(f'{out_dir}/icon.ico', sizes=[(s, s) for s in sizes], append_images=frames[:-1])

# The sidebar corner logo is the same ball.
big.resize((128, 128), Image.LANCZOS).save(sys.argv[2])

# Preview on a light and a dark taskbar: each small size at 4x, nearest-neighbour.
tb = Image.new('RGBA', (5 * 270, 540), (240, 240, 240, 255))
ImageDraw.Draw(tb).rectangle([0, 270, 5 * 270, 540], fill=(32, 32, 32, 255))
for row in range(2):
    for k, sz in enumerate([24, 32, 48, 56, 64]):
        src = small if sz <= 64 else big
        im = src.resize((sz, sz), Image.LANCZOS).resize((sz * 4, sz * 4), Image.NEAREST)
        tb.paste(im, (k * 270, row * 270), im)
tb.save(sys.argv[3])
