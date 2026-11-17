// Builds the day's reels-first social plan from the same data and ranking as the site.
// One Reel every day; an image post only on the configured weekdays and only when there is a reason.
// Every number here is the exact figure the route page shows.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const R = require("../src/rank.js");
const BC = require("../src/build-cost.js");

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const config = read("config.json");
const corridors = read("data/corridors.json");
const quotes = read("data/quotes.json");
const history = read("data/history.json");
const providers = read("data/providers.json").providers;
const buildCosts = read("data/build-costs.json");
const regional = read("data/regional-factors.json");
const schedule = read("data/social/schedule.json");
const tags = read("data/social/hashtags.json");
const midmarket = read("data/midmarket.json");
try { const ov = read("data/mid-overrides.json"); if (ov && ov.rates && Date.now() - new Date(ov.updatedAt).getTime() < 36 * 3600000) Object.assign(midmarket.rates, ov.rates); } catch {}
let feed = { routes: {} };
try { feed = read("data/wise-feed.json"); } catch {}
const pmap = Object.fromEntries(providers.map((p) => [p.id, p]));
const site = (config.siteUrl || "https://sendfair.africa").replace(/\/$/, "");
const WDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function nairobiDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone || "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function weekdayKey(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return WDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
function dayIndex(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000);
}
const money = (v, cur) => `${cur} ${Number(v).toLocaleString("en", { maximumFractionDigits: v >= 1000 ? 0 : 2, minimumFractionDigits: v >= 1000 ? 0 : 2 })}`;
const SEND_SYMBOL = { GBP: "£", USD: "$", CAD: "C$", AUD: "A$", EUR: "€" };
const sendMoney = (v, cur) => `${SEND_SYMBOL[cur] || cur + " "}${Number(v).toLocaleString("en")}`;
const pct = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const routeParts = (route) => {
  const [sid, rid] = route.split("-");
  const s = corridors.senders.find((x) => x.id === sid), r = corridors.receivers.find((x) => x.id === rid);
  return s && r ? { s, r } : null;
};
const routePage = (route) => { const [sid, rid] = route.split("-"); return `${site}/send-money/${sid}-to-${rid}/`; };
const linkFor = (route, ref) => `${routePage(route)}?ref=${ref}`;

function rowsFor(route, amount) {
  const p = routeParts(route);
  if (!p) return null;
  const mid = R.midRate(midmarket, p.s.currency, p.r.currency);
  const rows = R.rank({ list: (quotes.quotes || {})[route] || [], feed: (feed.routes || {})[route] || null, providers: pmap, amount, payout: "all", mid, now: Date.now(), staleH: config.staleAfterHours || 36, hideH: config.hideAfterHours || 72 }).filter((x) => !x.stale);
  return rows.length ? { p, mid, rows } : null;
}

function trend(route, days) {
  const d = history.days || {};
  const dates = Object.keys(d).sort().slice(-days);
  const pts = dates.map((x) => ({ d: x, v: (d[x] || {})[route] })).filter((x) => x.v && (x.v.mid || x.v.best));
  if (pts.length < 2) return null;
  const first = pts[0].v.mid || pts[0].v.best / pts[0].v.amount;
  const last = pts[pts.length - 1].v.mid || pts[pts.length - 1].v.best / pts[pts.length - 1].v.amount;
  if (!first || !last) return null;
  return { first, last, pct: (last / first - 1) * 100, from: pts[0].d, to: pts[pts.length - 1].d };
}

function bestChanged(route, days = 7) {
  const d = history.days || {};
  const dates = Object.keys(d).sort().slice(-days);
  const old = dates.length ? (d[dates[0]] || {})[route] : null;
  const today = rowsFor(route, (config.defaultAmounts || {})[routeParts(route)?.s.currency] || 250);
  if (!old || !old.by || !old.by.length || !today) return false;
  return !old.by.includes(today.rows[0].p.id);
}

const hashtagsFor = (r, extra = []) => [...(tags.generic || []), ...(tags[r.id] || []), ...extra].slice(0, 5).join(" ");

const HOUSE_CITIES = [
  { cid: "kenya", city: "nairobi", label: "Nairobi", country: "Kenya" },
  { cid: "nigeria", city: "lagos", label: "Lagos", country: "Nigeria" },
  { cid: "nigeria", city: "abuja", label: "Abuja", country: "Nigeria" },
  { cid: "ghana", city: "accra", label: "Accra", country: "Ghana" },
  { cid: "uganda", city: "kampala", label: "Kampala", country: "Uganda" }
];

function houses(city) {
  const house = (buildCosts.houses || []).find((h) => h.id === "3") || { m2: 110 };
  const factor = (((regional.countries || {})[city.cid] || {}).cities || {})[city.city]?.factor || 1;
  const est = (finish) => BC.regionalEstimate(buildCosts, city.cid, house.m2, 1, midmarket.rates || {}, {}, { finish }, factor);
  const eco = est("economy"), std = est("standard"), lux = est("luxury");
  if (!std || !(std.total > 0)) return null;
  return { city, house, eco, std, lux, factor, checked: buildCosts.updated };
}

const TIPS = [
  { key: "hidden-fee", text: "A 'no fee' service can still cost more, because the fee is hidden in the rate." },
  { key: "speed", text: "Mobile money often lands in minutes; a bank deposit can take a day. Compare both." },
  { key: "cash", text: "Cash pickup can be right for someone without a bank account, but check the fee before you send." },
  { key: "compare", text: "The service at the top of a comparison is not always the cheapest for every amount. Check yours." }
];

function buildReel(template, dateStr, index) {
  const priority = config.priorityRoutes || Object.keys(quotes.quotes || {});
  const route = priority[index % priority.length];
  const p = routeParts(route);
  if (!p) return null;
  const amount = config.defaultAmounts[p.s.currency] || 250;
  const data = rowsFor(route, amount);
  if (!data) return null;
  const { rows } = data;
  const top = rows[0], second = rows[1], lowest = rows[rows.length - 1];
  const checkedAt = quotes.updatedAt || new Date().toISOString();
  const checkDate = (quotes.updatedAt || "").slice(0, 10);
  const commonTags = hashtagsFor(p.r);

  if (template === "route") {
    const gap = top.gets - lowest.gets;
    return {
      template, route, from: p.s.short, to: p.r.name, amount, currency: p.s.currency, receiveCurrency: p.r.currency,
      hook: `Sending ${sendMoney(amount, p.s.currency)} to ${p.r.name}?`,
      numbers: [
        { label: `Best: ${top.p.name}`, value: money(top.gets, p.r.currency), final: top.gets },
        ...(second ? [{ label: `Second: ${second.p.name}`, value: money(second.gets, p.r.currency), final: second.gets }] : []),
        { label: `Lowest: ${lowest.p.name}`, value: money(lowest.gets, p.r.currency), final: lowest.gets },
        { label: `Extra with ${top.p.name}`, value: money(gap, p.r.currency), final: gap }
      ],
      checkedAt, checkDate,
      captions: {
        instagram: `Sending ${sendMoney(amount, p.s.currency)} to ${p.r.name}? ${top.p.name} pays the most today: ${money(top.gets, p.r.currency)}. The lowest of the services we checked pays ${money(lowest.gets, p.r.currency)} — a ${money(gap, p.r.currency)} gap. Compare yours: ${linkFor(route, "ig")}\n\n${commonTags}`,
        facebook: `Sending ${sendMoney(amount, p.s.currency)} to ${p.r.name}? ${top.p.name} pays the most today: ${money(top.gets, p.r.currency)}, against ${money(lowest.gets, p.r.currency)} at the lowest. Compare your own amount: ${linkFor(route, "fb")}\n\n${commonTags}`,
        tiktok: `Sending ${sendMoney(amount, p.s.currency)} to ${p.r.name}? The best pays ${money(top.gets, p.r.currency)} today. Compare yours: ${linkFor(route, "tt")}\n\n${commonTags}`
      },
      hashtags: commonTags
    };
  }

  if (template === "best-vs-average") {
    const avgGets = rows.reduce((a, x) => a + x.gets, 0) / rows.length;
    const avgCost = rows.reduce((a, x) => a + Math.max(0, 1 - x.gets / (amount * (data.mid || 1))), 0) / rows.length;
    const extra = top.gets - avgGets;
    return {
      template, route, from: p.s.short, to: p.r.name, amount, currency: p.s.currency, receiveCurrency: p.r.currency,
      hook: `What does ${sendMoney(amount, p.s.currency)} to ${p.r.name} really cost?`,
      numbers: [
        { label: "Average cost", value: `${(avgCost * 100).toFixed(1)}%`, final: avgCost * 100 },
        { label: `Best: ${top.p.name}`, value: money(top.gets, p.r.currency), final: top.gets },
        { label: "Extra vs average", value: money(extra, p.r.currency), final: extra }
      ],
      checkedAt, checkDate,
      captions: {
        instagram: `The average total cost on ${p.s.label} to ${p.r.name} today is ${(avgCost * 100).toFixed(1)}%. ${top.p.name} is the best: ${money(top.gets, p.r.currency)}, about ${money(extra, p.r.currency)} more than the average. Compare yours: ${linkFor(route, "ig")}\n\n${commonTags}`,
        facebook: `The average total cost on ${p.s.label} to ${p.r.name} today is ${(avgCost * 100).toFixed(1)}%. ${top.p.name} pays the most: ${money(top.gets, p.r.currency)}, about ${money(extra, p.r.currency)} more than the average. Compare your own amount: ${linkFor(route, "fb")}\n\n${commonTags}`,
        tiktok: `Average cost: ${(avgCost * 100).toFixed(1)}%. Best: ${top.p.name} at ${money(top.gets, p.r.currency)}. Compare yours: ${linkFor(route, "tt")}\n\n${commonTags}`
      },
      hashtags: commonTags
    };
  }

  if (template === "house") {
    const city = HOUSE_CITIES[index % HOUSE_CITIES.length];
    const h = houses(city);
    if (!h) return null;
    const url = `${site}/cost-to-build/${city.cid}/${city.city}/3-bedroom/`;
    return {
      template, route: `${city.cid}-${city.city}`, from: city.label, to: city.country, amount: 0, currency: "XOF", receiveCurrency: h.std.currency,
      hook: `What does a 3-bedroom house cost in ${city.label}?`,
      numbers: [
        { label: "Economy", value: money(h.eco.total, h.eco.currency), final: h.eco.total },
        { label: "Standard", value: money(h.std.total, h.std.currency), final: h.std.total },
        { label: "Luxury", value: money(h.lux.total, h.lux.currency), final: h.lux.total }
      ],
      checkedAt: h.checked + "T00:00:00Z", checkDate: h.checked,
      captions: {
        instagram: `A 3-bedroom house in ${city.label}: economy ${money(h.eco.total, h.eco.currency)}, standard ${money(h.std.total, h.std.currency)}, luxury ${money(h.lux.total, h.lux.currency)}. Itemised receipt, no land or contractor fee: ${url}?ref=ig\n\n${hashtagsFor({ id: "house" })}`,
        facebook: `A 3-bedroom house in ${city.label}: economy ${money(h.eco.total, h.eco.currency)}, standard ${money(h.std.total, h.std.currency)}, luxury ${money(h.lux.total, h.lux.currency)}. See every line: ${url}?ref=fb\n\n${hashtagsFor({ id: "house" })}`,
        tiktok: `3-bedroom in ${city.label}: ${money(h.std.total, h.std.currency)} standard. Full receipt: ${url}?ref=tt\n\n${hashtagsFor({ id: "house" })}`
      },
      hashtags: hashtagsFor({ id: "house" })
    };
  }

  if (template === "tip") {
    const tip = TIPS[index % TIPS.length];
    const gap = top.gets - lowest.gets;
    return {
      template, route, from: p.s.short, to: p.r.name, amount, currency: p.s.currency, receiveCurrency: p.r.currency,
      hook: tip.text,
      numbers: [
        { label: "Best", value: money(top.gets, p.r.currency), final: top.gets },
        { label: "Lowest", value: money(lowest.gets, p.r.currency), final: lowest.gets },
        { label: "Difference", value: money(gap, p.r.currency), final: gap }
      ],
      checkedAt, checkDate,
      captions: {
        instagram: `${tip.text} On ${p.s.label} to ${p.r.name} today the gap between the best and lowest is ${money(gap, p.r.currency)}. Compare yours: ${linkFor(route, "ig")}\n\n${hashtagsFor(p.r, tags.tip || [])}`,
        facebook: `${tip.text} On ${p.s.label} to ${p.r.name} today the gap is ${money(gap, p.r.currency)}. Compare your own amount: ${linkFor(route, "fb")}\n\n${hashtagsFor(p.r, tags.tip || [])}`,
        tiktok: `${tip.text} Gap today: ${money(gap, p.r.currency)}. Compare yours: ${linkFor(route, "tt")}\n\n${hashtagsFor(p.r, tags.tip || [])}`
      },
      hashtags: hashtagsFor(p.r, tags.tip || [])
    };
  }

  // rate-move
  const t = trend(route, 7);
  const changed = bestChanged(route);
  const eligible = (t && Math.abs(t.pct) >= (schedule.rateMoveThresholdPct || 1)) || changed;
  if (!eligible) return null;
  return {
    template, route, from: p.s.short, to: p.r.name, amount, currency: p.s.currency, receiveCurrency: p.r.currency,
    hook: changed ? "The best service changed this week" : `The rate moved ${pct(t.pct)} this week`,
    numbers: [
      ...(t ? [{ label: "This week", value: pct(t.pct), final: t.pct }] : []),
      { label: `Best: ${top.p.name}`, value: money(top.gets, p.r.currency), final: top.gets }
    ],
    checkedAt, checkDate,
    captions: {
      instagram: `${changed ? "The best service changed" : `The ${p.s.currency} to ${p.r.currency} rate moved ${pct(t.pct)}`} this week. ${top.p.name} pays the most today: ${money(top.gets, p.r.currency)}. Compare yours: ${linkFor(route, "ig")}\n\n${commonTags}`,
      facebook: `${changed ? "The best service changed" : `The ${p.s.currency} to ${p.r.currency} rate moved ${pct(t.pct)}`} this week. ${top.p.name} pays the most today: ${money(top.gets, p.r.currency)}. Compare your own amount: ${linkFor(route, "fb")}\n\n${commonTags}`,
      tiktok: `${changed ? "Best service changed" : `Rate moved ${pct(t.pct)}`}. ${top.p.name}: ${money(top.gets, p.r.currency)}. ${linkFor(route, "tt")}\n\n${commonTags}`
    },
    hashtags: commonTags
  };
}

function buildImage(reel) {
  if (!reel) return null;
  const rows = reel.numbers.slice(0, 4).map((n) => ({ label: n.label, value: n.value }));
  return {
    headline: reel.hook,
    rows,
    footnote: `Source: SendFair (sendfair.africa) · checked ${new Date(reel.checkDate + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`,
    cta: "sendfair.africa",
    link: reel.template === "house" ? `${site}/cost-to-build/` : routePage(reel.route)
  };
}

export function buildPlan(now = new Date(), forceTemplate = null) {
  const date = nairobiDate(now);
  const index = dayIndex(date);
  const templates = schedule.templates || ["route"];
  let template = forceTemplate || templates[index % templates.length];
  if (template === "rate-move" && !buildReel("rate-move", date, index)) { if (forceTemplate) return null; template = "route"; }
  const reel = buildReel(template, date, index);
  if (!reel) return null;
  const wd = weekdayKey(date);
  const imageDay = (schedule.imagePostDays || []).includes(wd);
  const worthImage = imageDay && ["house", "rate-move", "best-vs-average", "tip"].includes(template);
  const image = worthImage ? buildImage(reel) : null;
  return { date, weekday: wd, template, route: reel.route, reel, image, generatedAt: now.toISOString(), schedule };
}

const isCli = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("social-content.mjs");
if (isCli) {
  const plan = buildPlan();
  fs.mkdirSync("data/social", { recursive: true });
  if (!plan) { console.error("No plan: not enough live data today."); process.exit(1); }
  fs.writeFileSync("data/social/plan.json", JSON.stringify(plan, null, 1) + "\n");
  console.log(`Plan ${plan.date}: ${plan.template} on ${plan.route}${plan.image ? " (+ image post)" : ""}`);
}
