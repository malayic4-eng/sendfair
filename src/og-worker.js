// Edge renderer for the shareable result image: Satori (HTML/CSS → SVG) → resvg (SVG → PNG).
// Cached at Cloudflare's edge per route + amount + check timestamp, expiring after the next rate refresh.
import satori, { init as initSatori } from "satori/standalone";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import satoriLayoutWasm from "satori/layout.wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import figtree400 from "./fonts/figtree-latin-400-normal.woff";
import figtree700 from "./fonts/figtree-latin-700-normal.woff";
import { resultCard } from "./og-result.js";

const READY = (async () => { await initSatori(satoriLayoutWasm); await initWasm(resvgWasm); })();
const asBuf = (f) => (f instanceof Uint8Array ? f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) : f);
const FONTS = [
  { name: "Figtree", data: asBuf(figtree400), weight: 400 },
  { name: "Figtree", data: asBuf(figtree700), weight: 700 }
];

const CUR_SYM = { GBP: "£", USD: "$", EUR: "€", CAD: "C$", AUD: "A$" };
function money(n, cur) {
  const big = Math.abs(n) >= 1000;
  return cur + " " + n.toLocaleString("en", { minimumFractionDigits: big ? 0 : 2, maximumFractionDigits: big ? 0 : 2 });
}
function dateShort(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function getsFor(q, amount) {
  const fee = (Number(q.feeFixed) || 0) + amount * ((Number(q.feePct) || 0) / 100);
  return (amount - fee) * Number(q.rate);
}

// The built JSON is served from the same origin by Workers Assets; keep a short isolate cache.
let DATA = { at: 0, value: null };
async function loadData(env, origin) {
  if (DATA.value && Date.now() - DATA.at < 60000) return DATA.value;
  const get = async (p) => { const r = await env.ASSETS.fetch(new Request(origin + p)); return r.ok ? r.json() : null; };
  const [quotes, corridors, providers] = await Promise.all([get("/data/quotes.json"), get("/data/corridors.json"), get("/data/providers.json")]);
  DATA = { at: Date.now(), value: { quotes, corridors, providers } };
  return DATA.value;
}

function buildModel(data, route, amount) {
  const list = (data.quotes && data.quotes.quotes && data.quotes.quotes[route]) || [];
  const [fromId, toId] = route.split("-");
  const s = ((data.corridors && data.corridors.senders) || []).find((x) => x.id === fromId);
  const r = ((data.corridors && data.corridors.receivers) || []).find((x) => x.id === toId);
  const names = Object.fromEntries((((data.providers && data.providers.providers) || []).map((p) => [p.id, p.name])));
  if (!s || !r) return null;
  const rows = list.filter((q) => Number(q.rate) > 0).map((q) => ({ q, gets: getsFor(q, amount), name: names[q.provider] || q.provider }));
  if (!rows.length) return null;
  rows.sort((a, b) => b.gets - a.gets);
  const best = rows[0], worst = rows[rows.length - 1];
  const delta = best.gets - worst.gets;
  const pct = best.gets > 0 ? delta / best.gets : 0;
  const checked = rows.map((x) => x.q.checkedAt).filter(Boolean).sort().pop();
  return {
    amountLabel: (CUR_SYM[s.currency] || (s.currency + " ")) + amount,
    country: r.name,
    bestName: best.name,
    bestGets: money(best.gets, r.currency),
    delta: pct < 0.005 ? "About the same as the lowest today" : `+${money(delta, r.currency)} more than the lowest`,
    date: dateShort(checked)
  };
}

// GET /og/result.png?route=uk-nigeria&amount=250&ts=<check time>[&size=story]
export async function resultImage(request, env, ctx) {
  const u = new URL(request.url);
  const route = String(u.searchParams.get("route") || "").toLowerCase();
  const amount = Math.round(Number(u.searchParams.get("amount")));
  const story = u.searchParams.get("size") === "story";
  if (!/^[a-z]+-[a-z]+$/.test(route) || !(amount > 0) || amount > 1000000) return new Response("Bad request", { status: 400 });
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  await READY;
  const data = await loadData(env, u.origin);
  const m = buildModel(data, route, amount);
  if (!m) return new Response("No live data for that route and amount.", { status: 404 });
  const W = story ? 1080 : 1200, H = story ? 1920 : 630;
  const svg = await satori(resultCard({ ...m, story }), { width: W, height: H, fonts: FONTS });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng();
  const res = new Response(png, {
    headers: {
      "Content-Type": "image/png",
      // Rate data is refreshed roughly every 30 minutes; the ts in the URL changes with the check.
      "Cache-Control": "public, max-age=1800, s-maxage=1800",
      "Access-Control-Allow-Origin": "*"
    }
  });
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}
