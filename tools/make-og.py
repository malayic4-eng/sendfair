"""Generates the link-preview images (1200x630) in src/og/ for the home page and every route.
Run again only if you add countries:  python3 tools/make-og.py   (needs: pip install playwright && playwright install chromium)
"""
import asyncio, base64, json, pathlib, sys
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent

def font(name):
    data = (ROOT / "src" / "fonts" / name).read_bytes()
    return "data:font/woff2;base64," + base64.b64encode(data).decode()
corr = json.loads((ROOT / "data" / "corridors.json").read_text())
OUT = ROOT / "src" / "og"
OUT.mkdir(parents=True, exist_ok=True)

TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:B;font-weight:700;src:url(%(b7)s)}
@font-face{font-family:I;font-weight:500;src:url(%(i5)s)}
@font-face{font-family:I;font-weight:700;src:url(%(i7)s)}
@font-face{font-family:M;font-weight:600;src:url(%(m6)s)}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#f3f6f1;color:#12201a;font-family:I,sans-serif;padding:64px 72px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}
.brand{display:flex;align-items:center;gap:16px;font:700 40px B,sans-serif}.brand b{color:#0b6b4c}
.k{font:600 26px M,monospace;color:#56655d;letter-spacing:.06em}
h1{font:700 92px/1.02 B,sans-serif;letter-spacing:-.02em;max-width:980px}
.sub{font:500 32px I,sans-serif;color:#3d4c44;max-width:900px}
.foot{display:flex;justify-content:space-between;align-items:end}
.pill{background:#0b6b4c;color:#fff;font:700 28px I,sans-serif;padding:16px 28px;border-radius:999px}
.arc{position:absolute;right:-120px;top:-140px;width:520px;height:520px;border-radius:50%%;border:46px solid #dcefe5}
.dot{position:absolute;right:120px;top:300px;width:56px;height:56px;border-radius:50%%;background:#f2c14e}
</style></head><body><div class="arc"></div><div class="dot"></div>
<div class="brand"><svg width="56" height="56" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0b6b4c"/><path d="M8 19c3-7 10-9 15-6" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M20 10.5l3.4 2.6-3 3" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="22.5" r="2.3" fill="#f2c14e"/></svg><span>Send<b>Fair</b></span></div>
<div style="display:grid;gap:22px"><div class="k">%(kicker)s</div><h1>%(title)s</h1><div class="sub">%(sub)s</div></div>
<div class="foot"><div class="pill">See what lands at home</div></div>
</body></html>"""

FACES = {"b7": font("bricolage-grotesque-latin-700-normal.woff2"), "i5": font("inter-latin-500-normal.woff2"), "i7": font("inter-latin-700-normal.woff2"), "m6": font("ibm-plex-mono-latin-600-normal.woff2")}

async def main():
    jobs = [("home", "24 routes · checked by hand", "Compare money transfers to Africa", "Ranked by what your family actually receives, after fees and exchange-rate markup.")]
    for s in corr["senders"]:
        for r in corr["receivers"]:
            jobs.append((f"{s['id']}-to-{r['id']}", f"{s['currency']} → {r['currency']}", f"{s['label']} to {r['name']}", "Today's rates compared by how much actually arrives."))
    async with async_playwright() as p:
        exe = sys.argv[1] if len(sys.argv) > 1 else None
        b = await p.chromium.launch(executable_path=exe, args=["--no-sandbox"]) if exe else await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1200, "height": 630})
        for name, kicker, title, sub in jobs:
            await pg.set_content(TEMPLATE % {**FACES, "kicker": kicker, "title": title, "sub": sub})
            await pg.evaluate("document.fonts.ready")
            await pg.screenshot(path=str(OUT / f"{name}.png"))
        await b.close()
    print(f"Wrote {len(jobs)} images to {OUT}")

asyncio.run(main())
