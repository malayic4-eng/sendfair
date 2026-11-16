// Generates the day's social-media post queue from SendFair's live data.
// Cadence (based on today's date):
//   - Daily:  today's best transfer rate on a rotating priority route
//   - Every 3 days: a house-building cost post for a rotating country
//   - Mondays: weekly rate trend
//   - 1st of the month: monthly trend
// Output: data/social/queue.md (ASCII-only, platform-ready copy). Only factual, cited numbers.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const R = require("../src/rank.js");

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const corridors = read("data/corridors.json");
const quotes = read("data/quotes.json");
const history = read("data/history.json");
const config = read("config.json");
const providers = read("data/providers.json").providers;
const pname = (id) => (providers.find((p) => p.id === id) || {}).name || id;

const site = (config.siteUrl || "https://sendfair.africa").replace(/\/$/, "");
const now = new Date();
const iso = now.toISOString().slice(0, 10);
const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
const weekday = now.getUTCDay(); // 0 Sun ... 1 Mon
const dayOfMonth = now.getUTCDate();

const money = (v, cur) => `${cur} ${Math.round(v).toLocaleString("en")}`;

const midmarket = read("data/midmarket.json");
// Same correction the site applies (data/mid-overrides.json, kept for up to 36 hours).
try { const ov = read("data/mid-overrides.json"); if (ov && ov.rates && Date.now() - new Date(ov.updatedAt).getTime() < 36 * 3600000) Object.assign(midmarket.rates, ov.rates); } catch {}
let feed = { routes: {} };
try { feed = read("data/wise-feed.json"); } catch {}
const pmap = Object.fromEntries(providers.map((p) => [p.id, p]));
// Same ranking the site shows: fresh quotes only, Wise feed merged, sanity check against mid-market.
function topFor(route, amount) {
  const parts = routeParts(route);
  if (!parts) return null;
  const mid = R.midRate(midmarket, parts.s.currency, parts.r.currency);
  const rows = R.rank({ list: (quotes.quotes || {})[route] || [], feed: (feed.routes || {})[route] || null, providers: pmap, amount, payout: "all", mid, now: Date.now(), staleH: config.staleAfterHours || 36, hideH: config.hideAfterHours || 72 });
  const best = rows.filter((x) => !x.stale)[0];
  return best ? { id: best.p.id, gets: best.gets, rate: best.ev.rate, fee: best.ev.fee, count: rows.filter((x) => !x.stale).length } : null;
}
// Public page for a route key like "uk-nigeria" is /send-money/uk-to-nigeria/.
const routeUrl = (route) => { const [sid, rid] = route.split("-"); return `${site}/send-money/${sid}-to-${rid}/`; };
// Instagram needs a JPEG: each route has a branded card in /social/routes/, else the generic square card.
const routeImage = (route) => { const [sid, rid] = route.split("-"); const f = `src/social/routes/${sid}-to-${rid}.jpg`; return fs.existsSync(f) ? `${site}/social/routes/${sid}-to-${rid}.jpg` : `${site}/social-card.jpg`; };
const COUNTRY_TAGS = { nigeria: "#naija #nigerians", kenya: "#kenyandiaspora #mpesa", ghana: "#ghanaians #ghanadiaspora", zimbabwe: "#zimbabweans #zimdiaspora", uganda: "#ugandans", zambia: "#zambians" };
const tagsFor = (r, extra) => [extra, "#" + r.id, COUNTRY_TAGS[r.id] || "", "#diaspora #remittances #moneytransfer"].filter(Boolean).join(" ");

function routeParts(route) {
  const [sid, rid] = route.split("-");
  const s = corridors.senders.find((x) => x.id === sid);
  const r = corridors.receivers.find((x) => x.id === rid);
  return s && r ? { s, r } : null;
}

function trend(route, days) {
  const d = history.days || {};
  const dates = Object.keys(d).sort().slice(-days);
  const pts = dates.map((x) => ({ d: x, v: (d[x] || {})[route] })).filter((x) => x.v && (x.v.mid || x.v.best));
  if (pts.length < 2) return null;
  const first = pts[0].v.mid || (pts[0].v.best / pts[0].v.amount);
  const last = pts[pts.length - 1].v.mid || (pts[pts.length - 1].v.best / pts[pts.length - 1].v.amount);
  if (!first || !last) return null;
  return { first, last, pct: (last / first - 1) * 100, from: pts[0].d, to: pts[pts.length - 1].d };
}

const priority = config.priorityRoutes || Object.keys(quotes.quotes || {});
const blocks = [];

// --- Daily rate post ---
const route = priority[dayOfYear % priority.length];
const rp = routeParts(route);
const amount = rp ? config.defaultAmounts[rp.s.currency] : 250;
const top = rp ? topFor(route, amount) : null;
if (rp && top) {
  const url = routeUrl(route);
  const lead = `${rp.s.label} to ${rp.r.name}: ${pname(top.id)} delivers the most today - ${money(top.gets, rp.r.currency)} for ${money(amount, rp.s.currency)}.`;
  const body = `${top.count >= 3 ? `We compared ${top.count} services` : "We compared the services we could price"} by what actually arrives after fees and the exchange-rate margin. Check the ranking for your own amount before you send.`;
  blocks.push({
    kind: "Daily rate",
    title: `${rp.s.label} to ${rp.r.name}: ${pname(top.id)} pays the most today`,
    text: `${lead}\n\n${body}`,
    short: `${pname(top.id)} pays the most ${rp.s.label} to ${rp.r.name} today: ${money(top.gets, rp.r.currency)} for ${money(amount, rp.s.currency)}. Full ranking: ${url}`,
    long: `${lead} ${body} ${url}`,
    link: url,
    image: routeImage(route),
    tags: tagsFor(rp.r, "#sendmoney"),
  });
}

// --- House post (every 3 days) ---
if (dayOfYear % 3 === 0) {
  const bcs = read("data/build-costs.json");
  const ids = Object.keys(bcs.countries || {});
  if (ids.length) {
    const id = ids[dayOfYear % ids.length];
    const c = bcs.countries[id];
    const url = `${site}/cost-to-build/${id}/`;
    blocks.push({
      kind: "House build",
      title: `What a house really costs in ${c.name}`,
      short: `Building back home in ${c.name}? See the itemised receipt for a 3-bedroom bungalow - materials, trade days and the permit, line by line: ${url}`,
      text: `Building back home in ${c.name}? Before you send a lump sum, check the itemised receipt: every bag of cement, block, roof sheet, window, tile and trade day, plus the building permit (prices checked ${bcs.updated}). Land and the contractor's fee are not included.`,
      long: `Building back home in ${c.name}? Before you send a lump sum, check the itemised receipt: every bag of cement, block, roof sheet, window, tile and trade day, plus the building permit (prices checked ${bcs.updated}). Land and the contractor's fee are not included: ${url}`,
      link: url,
      image: `${site}/social-card.jpg`,
      tags: "#buildbackhome #diaspora #construction #africa #" + id,
    });
  }
}

// --- Weekly trend (Mondays) ---
if (weekday === 1) {
  const tRoute = priority[(dayOfYear + 1) % priority.length];
  const trp = routeParts(tRoute);
  const t = trend(tRoute, 7);
  if (t && trp && Math.abs(t.pct) <= 3) {
    const dir = t.pct >= 0 ? "up" : "down";
    blocks.push({
      kind: "Weekly trend",
      title: `This week's rate: ${trp.s.label} to ${trp.r.name}`,
      short: `The ${trp.s.currency} to ${trp.r.currency} rate is ${dir} ${Math.abs(t.pct).toFixed(1)}% this week. See how today compares: ${routeUrl(tRoute)}`,
      text: `This week the mid-market ${trp.s.currency} to ${trp.r.currency} rate is ${dir} ${Math.abs(t.pct).toFixed(1)}% (${t.from} to ${t.to}). Rates move, so compare what actually arrives before you send.`,
      long: `This week the mid-market ${trp.s.currency} to ${trp.r.currency} rate is ${dir} ${Math.abs(t.pct).toFixed(1)}% (${t.from} to ${t.to}). Rates move - compare what actually arrives before you send: ${routeUrl(tRoute)}`,
      link: `${routeUrl(tRoute)}`,
      image: routeImage(tRoute),
      tags: tagsFor(trp.r, "#exchangerate"),
    });
  }
}

// --- Monthly trend (1st) ---
if (dayOfMonth === 1) {
  const tRoute = priority[(dayOfYear + 2) % priority.length];
  const trp = routeParts(tRoute);
  const t = trend(tRoute, 30);
  if (t && trp) {
    blocks.push({
      kind: "Monthly trend",
      title: `${trp.s.label} to ${trp.r.name}: the month in rates`,
      short: `Over the past month the ${trp.s.currency} to ${trp.r.currency} rate moved ${t.pct >= 0 ? "+" : ""}${t.pct.toFixed(1)}%. Full history and today's ranking: ${routeUrl(tRoute)}`,
      text: `Over the past month the mid-market ${trp.s.currency} to ${trp.r.currency} rate moved ${t.pct >= 0 ? "+" : ""}${t.pct.toFixed(1)}% (${t.from} to ${t.to}). See the full rate history and today's best service on the route page.`,
      long: `Over the past month the mid-market ${trp.s.currency} to ${trp.r.currency} rate moved ${t.pct >= 0 ? "+" : ""}${t.pct.toFixed(1)}% (${t.from} to ${t.to}). See the full rate history and today's best service on the route page: ${routeUrl(tRoute)}`,
      link: `${routeUrl(tRoute)}`,
      image: routeImage(tRoute),
      tags: tagsFor(trp.r, "#exchangerate"),
    });
  }
}

const out = [`# SendFair social queue - ${iso}`, "", `${blocks.length} post(s) generated from live data (rates updated ${quotes.updatedAt || "?"}).`, ""];
for (const b of blocks) {
  out.push(`## ${b.kind}: ${b.title}`, "", "**Facebook / Instagram (longer):**", b.long, "", "**X / TikTok (short):**", b.short, "", "**Hashtags:** " + b.tags, "", "**Link:** " + b.link, "");
}
fs.mkdirSync("data/social", { recursive: true });
fs.writeFileSync("data/social/queue.md", out.join("\n") + "\n");
fs.writeFileSync("data/social/queue.json", JSON.stringify({ date: iso, generatedAt: new Date().toISOString(), posts: blocks }, null, 1) + "\n");
console.log(`Social queue: ${blocks.length} post(s) written to data/social/queue.md`);
blocks.forEach((b) => console.log(`  - ${b.kind}: ${b.title}`));
