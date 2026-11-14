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
body{width:1200px;height:630px;color:#151b45;font-family:F,sans-serif;padding:64px 72px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden;
background:radial-gradient(circle at 104%% 112%%,transparent 0 16%%,rgba(246,181,43,.38) 16%% 17.2%%,transparent 17.2%% 25%%,rgba(246,181,43,.26) 25%% 26.2%%,transparent 26.2%% 34%%,rgba(246,181,43,.16) 34%% 35.2%%,transparent 35.2%%),radial-gradient(rgba(27,36,112,.07) 1.6px,transparent 2px) 0 0/22px 22px,#ffffff}
.brand{display:flex;align-items:center;gap:16px;font:760 42px B,sans-serif;letter-spacing:-.02em}
.k{font:600 28px F,sans-serif;color:#5c6287}
h1{color:#111853;font:760 96px/1 B,sans-serif;letter-spacing:-.03em;max-width:1000px}
.sub{font:500 32px/1.35 F,sans-serif;color:#5c6287;max-width:860px}
.pill{align-self:flex-start;background:#1b2470;color:#ffffff;font:700 30px F,sans-serif;padding:16px 30px;border-radius:999px}
</style></head><body>
<div class="brand"><svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"><rect x="1" y="1" width="62" height="62" rx="16" fill="#1b2470"/><rect x="4.5" y="4.5" width="55" height="55" rx="13" fill="none" stroke="#f6b52b" stroke-width="0.9" opacity=".7"/><g transform="translate(32 32) scale(1.05) translate(-32 -32)" fill="#f6b52b"><path transform="translate(15.52 42.2) scale(.0275 -.0275)" d="M318 -14Q251 -14 199 0Q147 13 110 40Q73 67 54 107Q34 146 32 197L177 239Q180 195 199 167Q219 139 252 125Q285 112 326 112Q363 112 389 121Q416 130 430 145Q444 161 444 179Q444 202 425 217Q407 232 374 243Q342 253 300 264Q253 276 207 290Q161 304 124 326Q87 349 64 384Q42 419 42 472Q42 535 74 580Q105 625 164 649Q224 674 306 674Q389 674 450 648Q511 623 544 575Q577 528 576 463L430 429Q430 458 422 481Q413 503 397 518Q382 534 358 541Q334 549 303 549Q268 549 244 541Q220 532 208 518Q196 504 196 485Q196 462 215 448Q233 433 267 422Q300 412 342 401Q385 391 430 377Q475 363 513 340Q552 318 576 281Q599 243 599 186Q599 123 566 78Q533 33 470 10Q407 -14 318 -14Z"/><path d="M33.2 22.2h11.2v-2.7l5.6 4.8-5.6 4.8v-2.7h-6.6v3.6h5.6v4.2h-5.6v8.1h-4.6z"/></g></svg><span>SendFair</span></div>
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
