// Generates the day's social-media post queue from SendFair's live data.
// Cadence (based on today's date):
//   - Daily:  today's best transfer rate on a rotating priority route
//   - Every 3 days: a house-building cost post for a rotating country
//   - Mondays: weekly rate trend
//   - 1st of the month: monthly trend
// Output: data/social/queue.md (ASCII-only, platform-ready copy). Only factual, cited numbers.
import fs from "node:fs";

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

function topFor(route, amount) {
  const list = (quotes.quotes || {})[route] || [];
  let best = null;
  for (const q of list) {
    const fixed = Number(q.feeFixed ?? q.fee ?? 0) || 0;
    const pct = Number(q.feePct) || 0;
    const rate = Number(q.rate) || 0;
    const sent = (amount - fixed) / (1 + pct / 100);
    if (!(sent > 0) || !(rate > 0)) continue;
    const gets = sent * rate;
    if (!best || gets > best.gets) best = { id: q.provider, gets, rate, fee: fixed };
  }
  return best;
}

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
  const url = `${site}/send-money/${route}/`;
  blocks.push({
    kind: "Daily rate",
    title: `${rp.s.label} to ${rp.r.name}: ${pname(top.id)} pays the most today`,
    short: `${pname(top.id)} pays the most ${rp.s.label} to ${rp.r.name} today: ${money(top.gets, rp.r.currency)} for ${money(amount, rp.s.currency)}. Full ranking: ${url}`,
    long: `${rp.s.label} to ${rp.r.name}: ${pname(top.id)} delivers the most today - ${money(top.gets, rp.r.currency)} for ${money(amount, rp.s.currency)}. We compared every service; see the full ranking or check your own amount: ${url}`,
    link: url,
    tags: "#remittances #diaspora #sendmoney #africa #" + rp.r.id,
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
      long: `Building back home in ${c.name}? Before you send a lump sum, check the itemised receipt: every bag of cement, block, roof sheet, window, tile and trade day, plus the building permit (prices checked ${bcs.updated}). Land and the contractor's fee are not included: ${url}`,
      link: url,
      tags: "#buildbackhome #diaspora #construction #africa #" + id,
    });
  }
}

// --- Weekly trend (Mondays) ---
if (weekday === 1) {
  const t = trend(route, 7);
  if (t && rp) {
    const dir = t.pct >= 0 ? "up" : "down";
    blocks.push({
      kind: "Weekly trend",
      title: `This week's rate: ${rp.s.label} to ${rp.r.name}`,
      short: `The ${rp.s.currency} to ${rp.r.currency} rate is ${dir} ${Math.abs(t.pct).toFixed(1)}% this week. See how today compares: ${site}/send-money/${route}/`,
      long: `This week the mid-market ${rp.s.currency} to ${rp.r.currency} rate is ${dir} ${Math.abs(t.pct).toFixed(1)}% (${t.from} to ${t.to}). Rates move - compare what actually arrives before you send: ${site}/send-money/${route}/`,
      link: `${site}/send-money/${route}/`,
      tags: "#exchangerate #weekly #diaspora #" + rp.r.id,
    });
  }
}

// --- Monthly trend (1st) ---
if (dayOfMonth === 1) {
  const t = trend(route, 30);
  if (t && rp) {
    blocks.push({
      kind: "Monthly trend",
      title: `${rp.s.label} to ${rp.r.name}: the month in rates`,
      short: `Over the past month the ${rp.s.currency} to ${rp.r.currency} rate moved ${t.pct >= 0 ? "+" : ""}${t.pct.toFixed(1)}%. Full history and today's ranking: ${site}/send-money/${route}/`,
      long: `Over the past month the mid-market ${rp.s.currency} to ${rp.r.currency} rate moved ${t.pct >= 0 ? "+" : ""}${t.pct.toFixed(1)}% (${t.from} to ${t.to}). See the full rate history and today's best service on the route page: ${site}/send-money/${route}/`,
      link: `${site}/send-money/${route}/`,
      tags: "#monthlyrecap #exchangerate #diaspora #" + rp.r.id,
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
