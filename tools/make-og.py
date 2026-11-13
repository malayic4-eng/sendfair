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
@font-face{font-family:B;font-weight:200 800;src:url(%(b)s)}
@font-face{font-family:F;font-weight:300 900;src:url(%(f)s)}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;color:#f3f4fa;font-family:F,sans-serif;padding:64px 72px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden;
background:radial-gradient(circle at 104%% 112%%,transparent 0 16%%,rgba(246,181,43,.22) 16%% 17.2%%,transparent 17.2%% 25%%,rgba(246,181,43,.15) 25%% 26.2%%,transparent 26.2%% 34%%,rgba(246,181,43,.09) 34%% 35.2%%,transparent 35.2%%),radial-gradient(rgba(255,255,255,.07) 1.6px,transparent 2px) 0 0/22px 22px,#1b2470}
.brand{display:flex;align-items:center;gap:16px;font:760 42px B,sans-serif;letter-spacing:-.02em}
.k{font:600 28px F,sans-serif;color:#b3b8e0}
h1{font:760 96px/1 B,sans-serif;letter-spacing:-.03em;max-width:1000px}
.sub{font:500 32px/1.35 F,sans-serif;color:#b3b8e0;max-width:860px}
.pill{align-self:flex-start;background:#f6b52b;color:#2b1d00;font:700 30px F,sans-serif;padding:16px 30px;border-radius:999px}
</style></head><body>
<div class="brand"><svg width="60" height="60" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15.5" fill="#f6b52b"/><path d="M8 19.5c3-7 10-9 15-6" stroke="#1b2470" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M19.8 10.6l3.6 2.8-3.1 3.2" stroke="#1b2470" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="23" r="2.4" fill="#1b2470"/></svg><span>SendFair</span></div>
<div style="display:grid;gap:22px"><div class="k">%(kicker)s</div><h1>%(title)s</h1><div class="sub">%(sub)s</div></div>
<div class="pill">See what lands at home</div>
</body></html>"""

FACES = {"b": font("bricolage-grotesque-latin-opsz-normal.woff2"), "f": font("figtree-latin-wght-normal.woff2")}

async def main():
    jobs = [("home", "Money transfers to Africa, compared", "Send more home.", "Ranked by what your family actually receives, after the fee and the exchange-rate markup.")]
    for s in corr["senders"]:
        for r in corr["receivers"]:
            jobs.append((f"{s['id']}-to-{r['id']}", f"{s['currency']} to {r['currency']}", f"{s['label']} to {r['name']}", "Today's transfer services ranked by how much actually arrives."))
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
