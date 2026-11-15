"""Draw 22px and 44px logos, and a title card for each guide. Run locally; the site build only copies the files."""
import json
import os
from PIL import Image, ImageDraw, ImageFont

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
logo_dir = os.path.join(root, "src", "logos")
og_dir = os.path.join(root, "src", "og")

avif = False
try:
    Image.new("RGB", (8, 8)).save(os.path.join(logo_dir, "_avif_probe.avif"), "AVIF")
    os.remove(os.path.join(logo_dir, "_avif_probe.avif"))
    avif = True
except Exception as exc:
    print("AVIF_NO", type(exc).__name__)

n = 0
for name in os.listdir(logo_dir):
    if not name.endswith(".png"):
        continue
    stem = name[:-4]
    src = Image.open(os.path.join(logo_dir, name)).convert("RGBA")
    for size, suffix in ((22, "-22"), (44, "-44")):
        frame = src.resize((size, size), Image.Resampling.LANCZOS)
        frame.save(os.path.join(logo_dir, stem + suffix + ".webp"), "WEBP", quality=80, method=6)
        if avif:
            frame.save(os.path.join(logo_dir, stem + suffix + ".avif"), "AVIF", quality=50)
    n += 1
print("LOGOS", n, "AVIF", avif)

guides = json.load(open(os.path.join(root, "data", "guides.json"), encoding="utf-8"))
font_b = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 54)
font_s = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 28)
font_k = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 22)

def wrap(draw, text, font, width):
    words = text.split()
    lines, cur = [], ""
    for word in words:
        trial = (cur + " " + word).strip()
        if draw.textlength(trial, font=font) <= width:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines[:5]

made = 0
for article in guides["articles"]:
    img = Image.new("RGB", (1200, 630), (27, 36, 112))
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, 16, 630), fill=(230, 179, 37))
    draw.text((72, 70), "SendFair", font=font_s, fill=(230, 179, 37))
    y = 160
    for line in wrap(draw, article["title"], font_b, 1040):
        draw.text((72, y), line, font=font_b, fill=(255, 255, 255))
        y += 68
    draw.text((72, 540), "A guide, not a photograph of a house or a transfer.", font=font_k, fill=(215, 211, 234))
    img.save(os.path.join(og_dir, f"guide-{article['pillar']}-{article['slug']}.png"), "PNG", optimize=True)
    made += 1
print("OG", made)
