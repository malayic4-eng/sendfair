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
// Links stay out of the Facebook and Instagram post text: Facebook shows posts with an outside link
// to fewer people, and Instagram captions can't hold a clickable link. Facebook gets the link in the
// first comment (social-publish.mjs), Instagram points to the link in the bio. TikTok keeps the plain
// link, and YouTube (descriptions can hold links) gets the full one.
export const IG_LINK_TEXT = "link in bio 🔗";
export const FB_LINK_TEXT = "link in the first comment 👇";
const withRef = (url, ref) => `${url}?ref=${ref}`;
const linksFor = (url) => ({ instagram: withRef(url, "ig"), facebook: withRef(url, "fb"), tiktok: withRef(url, "tt"), youtube: withRef(url, "yt") });

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

// Every receiving country takes a turn, ordered so neighbours and the same region don't follow each
// other. Each is paired with where most of its diaspora sends from, alternating each time round.
const REEL_ORDER = ["kenya", "nigeria", "ghana", "southafrica", "senegal", "uganda", "zimbabwe", "morocco", "ethiopia", "cameroon", "tanzania", "ivorycoast", "zambia", "egypt", "rwanda", "mali", "drc"];
const REEL_SENDERS = {
  kenya: ["uk", "us"], nigeria: ["uk", "us", "canada"], ghana: ["uk", "us"], southafrica: ["uk", "australia"],
  senegal: ["europe", "us"], uganda: ["uk", "us"], zimbabwe: ["uk", "australia"], morocco: ["europe", "canada"],
  ethiopia: ["us", "canada"], cameroon: ["europe", "us"], tanzania: ["uk", "us"], ivorycoast: ["europe", "us"],
  zambia: ["uk", "us"], egypt: ["us", "europe"], rwanda: ["europe", "uk"], mali: ["europe", "us"], drc: ["europe", "canada"]
};
function reelRoute(index, needRows = 3) {
  const n = REEL_ORDER.length, cycle = Math.floor(index / n);
  for (let k = 0; k < n; k++) {
    const cid = REEL_ORDER[(index + k) % n];
    const prefs = REEL_SENDERS[cid] || ["uk"];
    const turn = cycle % prefs.length;
    const order = [...new Set([...prefs.slice(turn), ...prefs.slice(0, turn), ...corridors.senders.map((x) => x.id)])];
    for (const sid of order) {
      const route = `${sid}-${cid}`;
      const p = routeParts(route);
      if (!p) continue;
      const data = rowsFor(route, (config.defaultAmounts || {})[p.s.currency] || 250);
      if (data && data.rows.length >= needRows) return route;
    }
  }
  return (config.priorityRoutes || [])[0];
}
// House reels follow the same country order: the main city where we have city factors, else the country.
const HOUSE_MAIN_CITY = { kenya: ["nairobi", "Nairobi"], nigeria: ["lagos", "Lagos"], ghana: ["accra", "Accra"], uganda: ["kampala", "Kampala"] };
function houseCity(index) {
  const cid = REEL_ORDER[index % REEL_ORDER.length];
  const r = corridors.receivers.find((x) => x.id === cid);
  const c = HOUSE_MAIN_CITY[cid];
  return c ? { cid, city: c[0], label: c[1], country: r.name } : { cid, city: "country", label: r.name, country: r.name };
}

function houses(city) {
  const house = (buildCosts.houses || []).find((h) => h.id === "3") || { m2: 110 };
  const factor = (((regional.countries || {})[city.cid] || {}).cities || {})[city.city]?.factor || 1;
  const est = (finish) => BC.regionalEstimate(buildCosts, city.cid, house.m2, 1, midmarket.rates || {}, {}, { finish }, factor);
  const eco = est("economy"), std = est("standard"), lux = est("luxury");
  if (!std || !(std.total > 0)) return null;
  return { city, house, eco, std, lux, factor, checked: buildCosts.updated };
}

// Material price of the week: one building material across four countries, from the same listed
// prices as the house calculator and the material-prices page (BC.priceOf). Only prices the country
// lists itself ("quoted"); guides scaled from another country are left out. Dollar figures use the
// same mid-market rates as the site and are labelled "about".
const MATERIALS = [
  { key: "cement", name: "cement", what: "a 50kg bag of cement", unit: "a bag" },
  { key: "steel", name: "steel bar", what: "a kilo of steel bar (rebar)", unit: "a kg" },
  { key: "blocks", name: "concrete blocks", what: "one concrete block", unit: "a block", note: "Block sizes differ a little by country." }
];
const priceStr = (v, cur) => `${cur} ${Number(v).toLocaleString("en", Number.isInteger(v) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usdStr = (v) => `$${Number(v).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function materialPrices(visit) {
  const mat = MATERIALS[visit % MATERIALS.length];
  const rates = midmarket.rates || {};
  const listed = REEL_ORDER.map((cid) => {
    const c = (buildCosts.countries || {})[cid];
    if (!c) return null;
    const pr = BC.priceOf(buildCosts, cid, mat.key, rates);
    const fx = R.midRate(midmarket, c.currency, "USD");
    if (!pr || !pr.quoted || !(pr.price > 0) || !fx) return null;
    return { cid, country: c.name, currency: c.currency, price: pr.price, usd: pr.price * fx, source: pr.source || "" };
  }).filter(Boolean);
  if (listed.length < 4) return null;
  // Each time the template comes round for this material it moves on four countries.
  const round = Math.floor(visit / MATERIALS.length);
  const start = (round * 4) % listed.length;
  const pick = Array.from({ length: 4 }, (_, i) => listed[(start + i) % listed.length]).sort((a, b) => a.usd - b.usd);
  return { mat, rows: pick };
}

const TIPS = [
  { key: "hidden-fee", text: "A 'no fee' service can still cost more, because the fee is hidden in the rate.", title: "'No fee' can still cost more" },
  { key: "speed", text: "Mobile money often lands in minutes; a bank deposit can take a day. Compare both.", title: "Mobile money or bank deposit?" },
  { key: "cash", text: "Cash pickup can be right for someone without a bank account, but check the fee before you send.", title: "Cash pickup? Check the fee first" },
  { key: "compare", text: "The service at the top of a comparison is not always the cheapest for every amount. Check yours.", title: "The top service isn't always cheapest" }
];

function buildReel(template, dateStr, index) {
  // How many times this template has come round: rotates tips and materials through their whole lists.
  const visit = Math.floor(index / Math.max(1, (schedule.templates || []).length));
  if (template === "material") {
    const mp = materialPrices(visit);
    if (!mp) return null;
    const { mat, rows } = mp;
    const url = `${site}/cost-to-build/material-prices/`;
    const lead = rows[0].cid;
    const about = (x) => x.currency === "USD" ? "" : ` (about ${usdStr(x.usd)})`;
    const list = rows.map((x) => `${x.country} ${priceStr(x.price, x.currency)}${about(x)}`).join(", ");
    const cheap = rows[0], dear = rows[rows.length - 1];
    // Equal to the cent counts as a tie, so the caption never names one winner between equal prices.
    const names = (arr) => arr.length > 1 ? `${arr.slice(0, -1).join(", ")} and ${arr[arr.length - 1]}` : arr[0];
    const low = rows.filter((x) => usdStr(x.usd) === usdStr(cheap.usd)).map((x) => x.country);
    const high = rows.filter((x) => usdStr(x.usd) === usdStr(dear.usd)).map((x) => x.country);
    const sum = low.length === rows.length ? "In dollars, all four cost about the same." : `In dollars, ${names(low)} ${low.length > 1 ? "are" : "is"} the cheapest of these four and ${names(high)} the dearest.`;
    const tagsM = hashtagsFor({ id: "house" });
    const fb = (link) => `What ${mat.what} costs today: ${list}. ${sum}${mat.note ? " " + mat.note : ""} Every price with its source: ${link}\n\n${tagsM}`;
    return {
      template, route: `${lead}-material-${mat.key}`, from: mat.name, to: cheap.country, amount: 0, currency: "USD", receiveCurrency: "USD",
      material: mat.name, countries: rows.map((x) => x.cid),
      hook: `What does ${mat.what} cost?`,
      ytHook: `${mat.name[0].toUpperCase() + mat.name.slice(1)}: ${rows.map((x) => x.country).join(" vs ")}`,
      numbers: rows.map((x) => ({ label: x.currency === "USD" ? x.country : `${x.country} · about ${usdStr(x.usd)}`, value: priceStr(x.price, x.currency), final: x.price, usd: x.usd, cid: x.cid })),
      checkedAt: buildCosts.updated + "T00:00:00Z", checkDate: buildCosts.updated,
      links: linksFor(url),
      captions: {
        instagram: `What ${mat.what} costs today: ${list}. ${sum}${mat.note ? " " + mat.note : ""} Every price with its source: ${IG_LINK_TEXT}\n\n${tagsM}`,
        facebook: fb(FB_LINK_TEXT),
        tiktok: `${mat.what[0].toUpperCase() + mat.what.slice(1)}: ${rows.map((x) => `${x.country} ${priceStr(x.price, x.currency)}`).join(", ")}. Sources: ${url}?ref=tt\n\n${tagsM}`,
        youtube: fb(`${url}?ref=yt`)
      },
      hashtags: tagsM
    };
  }
  const route = reelRoute(index);
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
    const fb = (link) => `Sending ${sendMoney(amount, p.s.currency)} to ${p.r.name}? ${top.p.name} pays the most today: ${money(top.gets, p.r.currency)}, against ${money(lowest.gets, p.r.currency)} at the lowest. Compare your own amount: ${link}\n\n${commonTags}`;
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
      links: linksFor(routePage(route)),
      captions: {
        instagram: `Sending ${sendMoney(amount, p.s.currency)} to ${p.r.name}? ${top.p.name} pays the most today: ${money(top.gets, p.r.currency)}. The lowest of the services we checked pays ${money(lowest.gets, p.r.currency)} — a ${money(gap, p.r.currency)} gap. Compare yours: ${IG_LINK_TEXT}\n\n${commonTags}`,
        facebook: fb(FB_LINK_TEXT),
        tiktok: `Sending ${sendMoney(amount, p.s.currency)} to ${p.r.name}? The best pays ${money(top.gets, p.r.currency)} today. Compare yours: ${linkFor(route, "tt")}\n\n${commonTags}`,
        youtube: fb(linkFor(route, "yt"))
      },
      hashtags: commonTags
    };
  }

  if (template === "best-vs-average") {
    const avgGets = rows.reduce((a, x) => a + x.gets, 0) / rows.length;
    const avgCost = rows.reduce((a, x) => a + Math.max(0, 1 - x.gets / (amount * (data.mid || 1))), 0) / rows.length;
    const extra = top.gets - avgGets;
    const fb = (link) => `The average total cost on ${p.s.label} to ${p.r.name} today is ${(avgCost * 100).toFixed(1)}%. ${top.p.name} pays the most: ${money(top.gets, p.r.currency)}, about ${money(extra, p.r.currency)} more than the average. Compare your own amount: ${link}\n\n${commonTags}`;
    return {
      template, route, from: p.s.short, to: p.r.name, amount, currency: p.s.currency, receiveCurrency: p.r.currency,
      hook: `What does ${sendMoney(amount, p.s.currency)} to ${p.r.name} really cost?`,
      numbers: [
        { label: "Average cost", value: `${(avgCost * 100).toFixed(1)}%`, final: avgCost * 100 },
        { label: `Best: ${top.p.name}`, value: money(top.gets, p.r.currency), final: top.gets },
        { label: "Extra vs average", value: money(extra, p.r.currency), final: extra }
      ],
      checkedAt, checkDate,
      links: linksFor(routePage(route)),
      captions: {
        instagram: `The average total cost on ${p.s.label} to ${p.r.name} today is ${(avgCost * 100).toFixed(1)}%. ${top.p.name} is the best: ${money(top.gets, p.r.currency)}, about ${money(extra, p.r.currency)} more than the average. Compare yours: ${IG_LINK_TEXT}\n\n${commonTags}`,
        facebook: fb(FB_LINK_TEXT),
        tiktok: `Average cost: ${(avgCost * 100).toFixed(1)}%. Best: ${top.p.name} at ${money(top.gets, p.r.currency)}. Compare yours: ${linkFor(route, "tt")}\n\n${commonTags}`,
        youtube: fb(linkFor(route, "yt"))
      },
      hashtags: commonTags
    };
  }

  if (template === "house") {
    const city = houseCity(index);
    const h = houses(city);
    if (!h) return null;
    const url = city.city === "country" ? `${site}/cost-to-build/${city.cid}/3-bedroom/` : `${site}/cost-to-build/${city.cid}/${city.city}/3-bedroom/`;
    const fb = (link) => `A 3-bedroom house in ${city.label}: economy ${money(h.eco.total, h.eco.currency)}, standard ${money(h.std.total, h.std.currency)}, luxury ${money(h.lux.total, h.lux.currency)}. See every line: ${link}\n\n${hashtagsFor({ id: "house" })}`;
    return {
      template, route: `${city.cid}-${city.city}`, from: city.label, to: city.country, amount: 0, currency: "XOF", receiveCurrency: h.std.currency,
      hook: `What does a 3-bedroom house cost in ${city.label}?`,
      ytHook: `A 3-bedroom house in ${city.label}`,
      numbers: [
        { label: "Economy", value: money(h.eco.total, h.eco.currency), final: h.eco.total },
        { label: "Standard", value: money(h.std.total, h.std.currency), final: h.std.total },
        { label: "Luxury", value: money(h.lux.total, h.lux.currency), final: h.lux.total }
      ],
      checkedAt: h.checked + "T00:00:00Z", checkDate: h.checked,
      links: linksFor(url),
      captions: {
        instagram: `A 3-bedroom house in ${city.label}: economy ${money(h.eco.total, h.eco.currency)}, standard ${money(h.std.total, h.std.currency)}, luxury ${money(h.lux.total, h.lux.currency)}. Itemised receipt, no land or contractor fee: ${IG_LINK_TEXT}\n\n${hashtagsFor({ id: "house" })}`,
        facebook: fb(FB_LINK_TEXT),
        tiktok: `3-bedroom in ${city.label}: ${money(h.std.total, h.std.currency)} standard. Full receipt: ${url}?ref=tt\n\n${hashtagsFor({ id: "house" })}`,
        youtube: fb(`${url}?ref=yt`)
      },
      hashtags: hashtagsFor({ id: "house" })
    };
  }

  if (template === "tip") {
    const tip = TIPS[visit % TIPS.length];
    const gap = top.gets - lowest.gets;
    const fb = (link) => `${tip.text} On ${p.s.label} to ${p.r.name} today the gap is ${money(gap, p.r.currency)}. Compare your own amount: ${link}\n\n${hashtagsFor(p.r, tags.tip || [])}`;
    return {
      template, route, from: p.s.short, to: p.r.name, amount, currency: p.s.currency, receiveCurrency: p.r.currency,
      hook: tip.text,
      ytHook: `${tip.title} (${p.s.label} to ${p.r.name})`,
      numbers: [
        { label: "Best", value: money(top.gets, p.r.currency), final: top.gets },
        { label: "Lowest", value: money(lowest.gets, p.r.currency), final: lowest.gets },
        { label: "Difference", value: money(gap, p.r.currency), final: gap }
      ],
      checkedAt, checkDate,
      links: linksFor(routePage(route)),
      captions: {
        instagram: `${tip.text} On ${p.s.label} to ${p.r.name} today the gap between the best and lowest is ${money(gap, p.r.currency)}. Compare yours: ${IG_LINK_TEXT}\n\n${hashtagsFor(p.r, tags.tip || [])}`,
        facebook: fb(FB_LINK_TEXT),
        tiktok: `${tip.text} Gap today: ${money(gap, p.r.currency)}. Compare yours: ${linkFor(route, "tt")}\n\n${hashtagsFor(p.r, tags.tip || [])}`,
        youtube: fb(linkFor(route, "yt"))
      },
      hashtags: hashtagsFor(p.r, tags.tip || [])
    };
  }

  // rate-move
  const t = trend(route, 7);
  const changed = bestChanged(route);
  const eligible = (t && Math.abs(t.pct) >= (schedule.rateMoveThresholdPct || 1)) || changed;
  if (!eligible) return null;
  const moved = changed ? "The best service changed" : `The ${p.s.currency} to ${p.r.currency} rate moved ${pct(t.pct)}`;
  const fb = (link) => `${moved} this week. ${top.p.name} pays the most today: ${money(top.gets, p.r.currency)}. Compare your own amount: ${link}\n\n${commonTags}`;
  return {
    template, route, from: p.s.short, to: p.r.name, amount, currency: p.s.currency, receiveCurrency: p.r.currency,
    hook: changed ? "The best service changed this week" : `The rate moved ${pct(t.pct)} this week`,
    numbers: [
      ...(t ? [{ label: "This week", value: pct(t.pct), final: t.pct }] : []),
      { label: `Best: ${top.p.name}`, value: money(top.gets, p.r.currency), final: top.gets }
    ],
    checkedAt, checkDate,
    links: linksFor(routePage(route)),
    captions: {
      instagram: `${moved} this week. ${top.p.name} pays the most today: ${money(top.gets, p.r.currency)}. Compare yours: ${IG_LINK_TEXT}\n\n${commonTags}`,
      facebook: fb(FB_LINK_TEXT),
      youtube: fb(linkFor(route, "yt")),
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
    link: reel.links ? reel.links.facebook.replace(/\?ref=fb$/, "") : routePage(reel.route)
  };
}

// A named series per template, so people recognise the format and come back for it. The name opens
// every caption and labels the Reel's first frame (and the carousel cover).
export const SERIES = {
  route: { name: "Rate of the day", emoji: "📊" },
  "best-vs-average": { name: "Best vs average", emoji: "⚖️" },
  house: { name: "What it costs to build", emoji: "🏠" },
  material: { name: "Build back home", emoji: "🧱" },
  tip: { name: "Sender's tip", emoji: "💡" },
  "rate-move": { name: "Rate alert", emoji: "📈" }
};
// Building content (house costs, material prices) has its own wording on the Reel's last frame and
// the carousel's save line.
export const BUILDING = new Set(["house", "material"]);
let QUESTIONS = {};
try { QUESTIONS = read("data/social/questions.json"); } catch {}
// One comment prompt per caption, rotating by date (the day of the year, so it moves through the whole
// list: each time a template comes round it moves on). The first comment uses the next one, so it
// never repeats the caption.
function questionsFor(template, reel, visit) {
  const list = (QUESTIONS[template] || QUESTIONS.route || []).filter(Boolean);
  if (!list.length) return { caption: "", comment: "" };
  const fill = (q) => q.replace(/\{to\}/g, reel.to || "home").replace(/\{from\}/g, reel.from || "").replace(/\{city\}/g, reel.from || reel.to || "").replace(/\{material\}/g, reel.material || "cement");
  // Two prompts per visit (caption and first comment), so each visit moves on by two.
  const i = (visit * 2) % list.length;
  return { caption: fill(list[i]), comment: fill(list[(i + 1) % list.length]) };
}
const TIKTOK_MAX = 2200; // TikTok caption limit (characters)
const YT_TITLE_MAX = 90; // our cap; YouTube allows 100
function ytTitle(series, hook) {
  const tail = " #Shorts";
  const clean = (x) => String(x).replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  let head = `${series.name}: ${clean(hook)}`;
  const room = YT_TITLE_MAX - tail.length;
  if (head.length > room) { head = head.slice(0, room - 1); head = head.slice(0, Math.max(head.lastIndexOf(" "), series.name.length + 2)).replace(/[\s,.:;—-]+$/, "") + "…"; }
  return head + tail;
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
  const worthImage = imageDay && ["house", "material", "rate-move", "best-vs-average", "tip"].includes(template);
  const image = worthImage ? buildImage(reel) : null;
  const series = SERIES[template] || { name: "", emoji: "" };
  const q = questionsFor(template, reel, Math.floor(index / Math.max(1, templates.length)));
  reel.series = series;
  reel.question = q.caption;
  // Caption layout: "<emoji> <series> | <text>", a comment prompt, the share and follow ask
  // (Facebook's suggestions), then the hashtags.
  const follow = "Follow us everywhere: sendfair.africa/follow";
  const ask = { instagram: `Share this with someone who sends money home 🔁\n${follow}`, facebook: `Share this with someone who sends money home 🔁\n${follow}`, tiktok: `Share with someone who sends money home 🔁\n${follow}`, youtube: `Share this with someone who sends money home 🔁\nFollow us everywhere: ${site}/follow/?ref=yt` };
  const split = (c) => { const at = c.lastIndexOf("\n\n#"); return at >= 0 ? { body: c.slice(0, at), tags: c.slice(at + 2) } : { body: c, tags: "" }; };
  const parts = { ...reel.captions }; // the plain text per platform, before the layout below
  const compose = (k, extra = []) => {
    const { body, tags: ht } = split(parts[k] || "");
    const head = series.name ? `${series.emoji} ${series.name} | ${body}` : body;
    return [head, ...extra, q.caption, ask[k], ht].filter(Boolean).join("\n\n");
  };
  const captions = {};
  for (const k of ["instagram", "facebook", "tiktok"]) captions[k] = compose(k);
  if (captions.tiktok.length > TIKTOK_MAX) captions.tiktok = captions.tiktok.slice(0, TIKTOK_MAX);
  captions.youtube = { title: ytTitle(series, reel.ytHook || reel.hook), description: compose("youtube").slice(0, 5000).replace(/[<>]/g, "") };
  reel.captions = captions;
  // First comments, posted by social-publish.mjs right after each post: the link on Facebook, a
  // question on Instagram (comments there can't hold a clickable link either).
  const lead = template === "house" ? "See every line of the receipt 👉" : template === "material" ? "Every price with its source 👉" : "Compare your own amount 👉";
  reel.comments = { facebook: `${lead} ${reel.links.facebook}\n\n${q.comment}`.trim(), instagram: q.comment };
  // FORCE_REEL=1 (manual test runs only): build the Reel even on a carousel day.
  const carousel = (schedule.carouselDays || []).includes(wd) && process.env.FORCE_REEL !== "1" ? buildCarousel(reel, (k) => compose(k, [`Swipe for the full numbers 👉 Save this for your ${BUILDING.has(template) ? "build" : "next transfer"} 📌`])) : null;
  return { date, weekday: wd, template, route: reel.route, reel, image, carousel, generatedAt: now.toISOString(), schedule };
}

// Carousel script: slide 1 the hook over the day's photo, then one figure per slide (the same ranked
// numbers as the Reel), then what the numbers mean in one plain sentence, then save/share over the
// second photo. 5–7 slides. Every figure in the insight comes from reel.numbers.
const nameOf = (label) => String(label || "").replace(/^[^:]*:\s*/, "");
function insightFor(reel) {
  const n = reel.numbers;
  const byLabel = (re) => n.find((x) => re.test(x.label));
  if (reel.template === "route") {
    const best = byLabel(/^Best:/), low = byLabel(/^Lowest:/), extra = byLabel(/^Extra with/);
    if (best && low && extra) return `On the same ${sendMoney(reel.amount, reel.currency)}, ${nameOf(best.label)} pays ${extra.value} more than ${nameOf(low.label)}. Same money sent, more at home.`;
  }
  if (reel.template === "best-vs-average") {
    const avg = n[0], best = n[1], extra = n[2];
    if (avg && best && extra) return `An average service keeps ${avg.value} of what you send. ${nameOf(best.label)} pays ${extra.value} more than the average today.`;
  }
  if (reel.template === "house") {
    const [eco, std, lux] = n;
    if (eco && std && lux) return `Standard finish adds ${money(std.final - eco.final, reel.receiveCurrency)} over economy. Luxury adds ${money(lux.final - std.final, reel.receiveCurrency)} more. Every line is on the receipt.`;
  }
  if (reel.template === "material") {
    const cheap = n[0], dear = n[n.length - 1];
    const where = (x) => x.label.split(" · ")[0];
    if (cheap && dear && cheap.usd && dear.usd && usdStr(cheap.usd) !== usdStr(dear.usd)) return `About ${usdStr(cheap.usd)} in ${where(cheap)}, about ${usdStr(dear.usd)} in ${where(dear)}. Price your whole house before you send the money.`;
  }
  if (reel.template === "tip") {
    const gap = n[n.length - 1];
    if (gap) return `On ${reel.from} to ${reel.to} today, the gap between the best and the lowest service is ${gap.value}. Check before you send.`;
  }
  const best = byLabel(/^Best:/);
  return best ? `${nameOf(best.label)} pays the most today: ${best.value}. Rates move, so check before every transfer.` : "Rates move every day. Check before every transfer.";
}
// captionFor(platform) lays out the carousel caption the same way as the Reel's, with the swipe and
// save line straight after the text.
function buildCarousel(reel, captionFor) {
  if (!reel || !reel.numbers || !reel.numbers.length) return null;
  const captions = {};
  for (const k of ["instagram", "facebook"]) captions[k] = captionFor(k);
  return { insight: insightFor(reel), captions };
}

const isCli = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("social-content.mjs");
if (isCli) {
  const plan = buildPlan();
  fs.mkdirSync("data/social", { recursive: true });
  if (!plan) { console.error("No plan: not enough live data today."); process.exit(1); }
  fs.writeFileSync("data/social/plan.json", JSON.stringify(plan, null, 1) + "\n");
  console.log(`Plan ${plan.date}: ${plan.template} on ${plan.route}${plan.image ? " (+ image post)" : ""}`);
}
