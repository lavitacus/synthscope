# Draws the SynthScope app icons: a silver lens with a champagne ring on a black field lit
# by a soft dusk glow, matching the in-app brand mark. Run: pip install pillow && python scripts/make_icons.py
import os, math
from PIL import Image, ImageDraw, ImageFilter

BLACK = (0, 0, 0, 255)
CHAMP = (230, 200, 145, 255)
SS = 4  # supersampling for smooth edges

def radial(size, cx, cy, r, inner, outer):
    img = Image.new('RGBA', (size, size), outer)
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = min(1.0, math.hypot(x - cx, y - cy) / r)
            px[x, y] = tuple(int(inner[i] + (outer[i] - inner[i]) * t) for i in range(4))
    return img

def background(size):
    s = size // 8  # paint small, scale up: the glow is soft anyway
    bg = Image.new('RGBA', (s, s), BLACK)
    glow = radial(s, s * 0.3, s * 0.25, s * 0.75, (22, 52, 74, 255), (0, 0, 0, 0))
    glow2 = radial(s, s * 0.8, s * 0.85, s * 0.7, (40, 32, 88, 255), (0, 0, 0, 0))
    bg = Image.alpha_composite(bg, glow); bg = Image.alpha_composite(bg, glow2)
    return bg.resize((size, size), Image.BICUBIC).filter(ImageFilter.GaussianBlur(size / 40))

def mark(size, scale):
    S = size * SS; img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    c = S / 2; R = S * scale
    # silver lens, lit from the top left
    lens = radial(S // 4, (c - R * 0.35) / 4, (c - R * 0.4) / 4, R * 1.5 / 4, (255, 255, 255, 255), (120, 120, 128, 255)).resize((S, S), Image.BICUBIC)
    mask = Image.new('L', (S, S), 0); ImageDraw.Draw(mask).ellipse([c - R, c - R, c + R, c + R], fill=255)
    img.paste(lens, (0, 0), mask)
    d = ImageDraw.Draw(img)
    core = R * 0.68  # a thick silver ring around a dark lens, like the rim of a scope
    d.ellipse([c - core, c - core, c + core, c + core], fill=(8, 8, 10, 255))
    lw = max(2, int(R * 0.035))
    d.ellipse([c - core, c - core, c + core, c + core], outline=CHAMP, width=lw)
    dot = R * 0.13  # the signal: a champagne point inside the lens
    d.ellipse([c + R * 0.12 - dot, c - R * 0.12 - dot, c + R * 0.12 + dot, c - R * 0.12 + dot], fill=CHAMP)
    return img.resize((size, size), Image.LANCZOS)

def icon(size, scale, transparent=False):
    base = Image.new('RGBA', (size, size), (0, 0, 0, 0)) if transparent else background(size)
    m = mark(size, scale)
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sm = Image.new('L', (size, size), 0); c = size / 2; r = size * scale
    ImageDraw.Draw(sm).ellipse([c - r, c - r + size * 0.03, c + r, c + r + size * 0.03], fill=170)
    shadow.putalpha(sm.filter(ImageFilter.GaussianBlur(size / 30)))
    return Image.alpha_composite(Image.alpha_composite(base, shadow), m)

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
for sub in ('www/icons', 'assets'): os.makedirs(os.path.join(root, sub), exist_ok=True)
out = {
    'www/icons/icon-192.png': icon(192, 0.30), 'www/icons/icon-512.png': icon(512, 0.30),
    'www/icons/maskable-512.png': icon(512, 0.24), 'assets/icon-only.png': icon(1024, 0.30),
    'assets/icon-foreground.png': icon(1024, 0.22, True), 'assets/icon-background.png': background(1024)
}
for p, im in out.items(): im.save(os.path.join(root, p)); print('wrote', p)
