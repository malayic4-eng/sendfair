// Embeddable rate widget: GET /embed/widget/?route=uk-nigeria&amount=250&theme=light
// Lightweight HTML (system fonts, no third-party scripts or trackers) that any site may frame.
// Top 3 services come from the site's own rank() via og-model.mjs, so they match the route page.
// The HTML is cached at Cloudflare's edge for 15 minutes per route + amount + theme; the
// embedding host is added to the "Compare all" link in the browser, so one cached copy serves every host.
// Loads are counted per embedding host in KV (embed:<YYYY-MM-DD>:<host>), batched per isolate.
import { loadData } from "./site-data.mjs";
import { resultModel } from "./og-model.mjs";

const MIN_AMOUNT = 10, MAX_AMOUNT = 1000000;
const CACHE_SECONDS = 900;
const CUR_SYM = { GBP: "£", USD: "$", EUR: "€", CAD: "C$", AUD: "A$" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function money(n, cur) {
  const big = Math.abs(n) >= 1000;
  return cur + " " + n.toLocaleString("en", { minimumFractionDigits: big ? 0 : 2, maximumFractionDigits: big ? 0 : 2 });
}
function checkedLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";
}

// ---- Per-host load counting -------------------------------------------------------------------
// Counting runs on every request (before the cache), but KV is written at most once a minute per
// host from each isolate, so a busy embed does not exhaust KV writes. A few loads can be lost when
// an isolate is recycled; the figure is a guide, not an invoice.
const pending = new Map(); // host -> { n, last }
function hostOf(request) {
  const ref = request.headers.get("Referer") || "";
  try {
    const h = new URL(ref).hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9.-]{1,253}$/.test(h) ? h : "";
  } catch { return ""; }
}
function countLoad(env, ctx, request) {
  const kv = env.SENDFAIR_KV;
  const self = new URL(request.url).hostname.replace(/^www\./, "");
  const host = hostOf(request) || "(no referrer)";
  if (!kv || host === self) return; // our own /embed/ preview is not an embed
  const p = pending.get(host) || { n: 0, last: 0 };
  p.n += 1;
  pending.set(host, p);
  const now = Date.now();
  if (now - p.last < 60000) return;
  const add = p.n;
  p.n = 0;
  p.last = now;
  const key = `embed:${new Date(now).toISOString().slice(0, 10)}:${host}`;
  ctx.waitUntil((async () => {
    try {
      const cur = Number((await kv.get(key)) || 0);
      await kv.put(key, String(cur + add), { expirationTtl: 60 * 60 * 24 * 120 });
    } catch (e) { p.n += add; }
  })());
}

// ---- Widget ------------------------------------------------------------------------------------
function widgetHtml({ m, amount, dark, origin, checked }) {
  const routePath = `/send-money/${m.s.id}-to-${m.r.id}/`;
  const compare = `${origin}${routePath}?amount=${amount}&ref=embed`;
  const sym = CUR_SYM[m.s.currency] || m.s.currency + " ";
  const top = m.fresh.slice(0, 3);
  const rows = top.map((x, i) => `<li><span class="n">${i + 1}</span><img src="${origin}/logos/${esc(x.p.id)}-44.avif" alt="" width="22" height="22" decoding="async" onerror="this.remove()"><span class="p">${esc(x.p.name)}</span><span class="g">${esc(money(x.gets, m.r.currency))}</span></li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Sending ${esc(sym + amount)} from ${esc(m.s.label)} to ${esc(m.r.name)} · SendFair</title>
<style>
:root{--bg:${dark ? "#111853" : "#ffffff"};--ink:${dark ? "#ffffff" : "#151b45"};--muted:${dark ? "#c7cdf1" : "#5c6287"};--line:${dark ? "rgba(199,205,241,.25)" : "#e4e6f0"};--accent:${dark ? "#f6b52b" : "#1b2470"};--chip:${dark ? "rgba(246,181,43,.14)" : "#f0f1f8"}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.w{padding:14px 14px 10px;border:1px solid var(--line);border-radius:12px;min-height:100vh}
h1{font-size:15px;margin:0 0 2px}.sub{color:var(--muted);font-size:12px;margin:0 0 10px}
ol{list-style:none;margin:0;padding:0}
li{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--line)}
.n{width:20px;height:20px;border-radius:50%;background:var(--chip);color:var(--accent);font-weight:700;font-size:12px;display:inline-flex;align-items:center;justify-content:center;flex:none}
img{border-radius:5px;flex:none}.p{flex:1;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.g{font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums;white-space:nowrap}
.k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:0 0 2px}
.f{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--muted)}
@media (max-width:300px){.w{padding:10px 10px 8px}h1{font-size:14px}li{gap:6px;padding:6px 0}img{display:none}.f{flex-wrap:wrap}}
a.c{display:inline-block;background:var(--accent);color:${dark ? "#111853" : "#fff"};text-decoration:none;font-weight:700;border-radius:999px;padding:7px 12px;font-size:12px;white-space:nowrap}
</style>
</head>
<body>
<div class="w">
<h1>Sending ${esc(sym + amount.toLocaleString("en"))} from ${esc(m.s.label)} to ${esc(m.r.name)}</h1>
<p class="sub">Most money home today, after fees</p>
<p class="k">They receive</p>
<ol>${rows}</ol>
<div class="f"><span>Checked ${esc(checked)}</span><a class="c" id="c" href="${esc(compare)}" target="_blank" rel="noopener">Compare all</a></div>
</div>
<script>(function(){try{var h=new URL(document.referrer).hostname;if(h){var a=document.getElementById("c");a.href+="&host="+encodeURIComponent(h.replace(/^www\\./,""));}}catch(e){}})();</script>
</body>
</html>`;
}

function headers(extra) {
  return Object.assign({
    "Content-Type": "text/html; charset=utf-8",
    // The only page on the site that other sites may frame.
    "Content-Security-Policy": "frame-ancestors *; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "X-Robots-Tag": "noindex",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff"
  }, extra || {});
}

export async function embedWidget(request, env, ctx) {
  try {
    countLoad(env, ctx, request);
    const u = new URL(request.url);
    const route = String(u.searchParams.get("route") || "uk-nigeria").toLowerCase();
    const theme = u.searchParams.get("theme") === "dark" ? "dark" : "light";
    const rawAmount = u.searchParams.get("amount");
    if (!/^[a-z]+-[a-z]+$/.test(route)) return new Response("Unknown route.", { status: 400, headers: headers({ "Cache-Control": "no-store" }) });

    const data = await loadData(env, u.origin);
    const sender = ((data.corridors && data.corridors.senders) || []).find((x) => x.id === route.split("-")[0]);
    const def = sender && ((data.site && data.site.defaultAmounts) || {})[sender.currency];
    let amount = Math.round(Number(rawAmount == null || rawAmount === "" ? (def || 250) : rawAmount));
    if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) return new Response("Amount must be between 10 and 1,000,000.", { status: 400, headers: headers({ "Cache-Control": "no-store" }) });

    const quotesAt = (data.quotes && data.quotes.updatedAt) || "0";
    const cacheKey = new Request(`${u.origin}/embed/widget/?route=${route}&amount=${amount}&theme=${theme}&v=${encodeURIComponent(quotesAt)}`);
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;

    const m = resultModel(data, route, amount, Date.now());
    if (!m) return new Response("No live rates for that route right now.", { status: 404, headers: headers({ "Cache-Control": "no-store" }) });
    const checked = checkedLabel(quotesAt !== "0" ? quotesAt : m.best.q && m.best.q.checkedAt);
    const html = widgetHtml({ m, amount, dark: theme === "dark", origin: u.origin, checked });
    const res = new Response(html, { headers: headers({ "Cache-Control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}` }) });
    ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    console.error("embed widget failed", e && e.stack ? e.stack : String(e));
    return new Response("Rates are unavailable right now.", { status: 500, headers: headers({ "Cache-Control": "no-store" }) });
  }
}

// GET /api/embeds?days=30 — loads per embedding host, newest day first. Needs the admin password.
export async function embedStats(request, env, safeEqual, json) {
  const pw = request.headers.get("x-admin-password") || "";
  if (!env.ADMIN_PASSWORD || !safeEqual(pw, env.ADMIN_PASSWORD)) return json({ error: "Not allowed." }, 401);
  const kv = env.SENDFAIR_KV;
  if (!kv) return json({ hosts: [] });
  const days = Math.max(1, Math.min(120, parseInt(new URL(request.url).searchParams.get("days"), 10) || 30));
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const totals = {};
  let cursor;
  do {
    const page = await kv.list({ prefix: "embed:", cursor });
    for (const k of page.keys) {
      const [, day, host] = k.name.match(/^embed:(\d{4}-\d{2}-\d{2}):(.+)$/) || [];
      if (!day || day < since) continue;
      const n = Number((await kv.get(k.name)) || 0);
      const t = totals[host] || (totals[host] = { host, loads: 0, lastDay: day });
      t.loads += n;
      if (day > t.lastDay) t.lastDay = day;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return json({ days, since, hosts: Object.values(totals).sort((a, b) => b.loads - a.loads) });
}
