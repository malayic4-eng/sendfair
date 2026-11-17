// Edge renderer for the shareable result image: Satori (HTML/CSS → SVG) → resvg (SVG → PNG).
// The best/lowest providers come from the site's own rank() via og-model.js, so the card agrees with
// the page (feed merge, 36h/72h freshness, hand-lock). Cached at Cloudflare's edge per
// route + amount + size + quotes.updatedAt; all other query parameters are ignored.
import satori, { init as initSatori } from "satori/standalone";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import satoriLayoutWasm from "satori/layout.wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import figtree400 from "./fonts/figtree-latin-400-normal.woff";
import figtree700 from "./fonts/figtree-latin-700-normal.woff";
import { resultCard } from "./og-result.js";
import { resultModel } from "./og-model.js";

const READY = (async () => { await initSatori(satoriLayoutWasm); await initWasm(resvgWasm); })();
const asBuf = (f) => (f instanceof Uint8Array ? f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) : f);
const FONTS = [
  { name: "Figtree", data: asBuf(figtree400), weight: 400 },
  { name: "Figtree", data: asBuf(figtree700), weight: 700 }
];

const CUR_SYM = { GBP: "£", USD: "$", EUR: "€", CAD: "C$", AUD: "A$" };
const MIN_AMOUNT = 10, MAX_AMOUNT = 1000000;

function money(n, cur) {
  const big = Math.abs(n) >= 1000;
  return cur + " " + n.toLocaleString("en", { minimumFractionDigits: big ? 0 : 2, maximumFractionDigits: big ? 0 : 2 });
}
function dateShort(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// The built JSON is served from the same origin by Workers Assets; keep a short isolate cache.
let DATA = { at: 0, value: null };
async function loadData(env, origin) {
  if (DATA.value && Date.now() - DATA.at < 60000) return DATA.value;
  const get = async (p) => { const r = await env.ASSETS.fetch(new Request(origin + p)); return r.ok ? r.json() : null; };
  const [quotes, feed, providers, corridors, midmarket, site] = await Promise.all([
    get("/data/quotes.json"), get("/data/wise-feed.json"), get("/data/providers.json"),
    get("/data/corridors.json"), get("/data/midmarket.json"), get("/data/site.json")
  ]);
  DATA = { at: Date.now(), value: { quotes, feed, providers, corridors, midmarket, site: site || {} } };
  return DATA.value;
}

// GET /og/result.png?route=uk-nigeria&amount=250[&size=story]
export async function resultImage(request, env, ctx) {
  const u = new URL(request.url);
  const route = String(u.searchParams.get("route") || "").toLowerCase();
  const raw = Number(u.searchParams.get("amount"));
  const amount = Math.round(raw);
  const story = u.searchParams.get("size") === "story";
  if (!/^[a-z]+-[a-z]+$/.test(route) || !Number.isFinite(raw) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    return new Response("Bad request", { status: 400 });
  }

  await READY;
  const data = await loadData(env, u.origin);

  // Cache key: route + rounded amount + size + the data's own update time. Nothing else is read.
  const quotesAt = (data.quotes && data.quotes.updatedAt) || "0";
  const cacheKey = new Request(`${u.origin}/og/result.png?route=${route}&amount=${amount}&size=${story ? "story" : "wide"}&v=${encodeURIComponent(quotesAt)}`);
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit;

  const m = resultModel(data, route, amount, Date.now());
  if (!m) return new Response("No live data for that route and amount.", { status: 404 });

  const best = m.best, lowest = m.lowest, multi = m.fresh.length > 1 && lowest !== best;
  const delta = best.gets - lowest.gets;
  const pct = best.gets > 0 ? delta / best.gets : 0;
  const checked = (data.quotes && data.quotes.updatedAt) || best.q.checkedAt;
  const model = {
    amountLabel: (CUR_SYM[m.s.currency] || (m.s.currency + " ")) + amount,
    country: m.r.name,
    bestName: best.p.name,
    bestGets: money(best.gets, m.r.currency),
    delta: !multi ? "The best of the services we checked today" : pct < 0.005 ? "About the same as the lowest today" : `+${money(delta, m.r.currency)} more than the lowest`,
    date: dateShort(checked)
  };

  const W = story ? 1080 : 1200, H = story ? 1920 : 630;
  const svg = await satori(resultCard({ ...model, story }), { width: W, height: H, fonts: FONTS });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng();
  const res = new Response(png, {
    headers: {
      "Content-Type": "image/png",
      // Rate data is refreshed roughly every 30 minutes; the key already changes with the data.
      "Cache-Control": "public, max-age=1800, s-maxage=1800",
      "Access-Control-Allow-Origin": "*"
    }
  });
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
}
