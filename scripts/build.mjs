// Builds the static site into dist/.
// Usage: node scripts/build.mjs [--demo] [--preview] [--out dist]
//   --demo     fills the site with clearly labelled example quotes (previews only, never deploy)
//   --preview  writes links as .../index.html and uses hosted fonts so the site works inside a file preview
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildReports, reportSummary } from "./report-data.mjs";
import { FR, t, moneyFr, dateFr, assertFrKeys, frGrammar, capFirst } from "./i18n.mjs";
import { mergeConfig as mergeQuoteCheckConfig, priceFor as quoteCheckPrice } from "../src/quote-check/config.mjs";
import { TRAVEL_IDS, sponsorsFor, flightTarget, esimTarget } from "../src/partner-links.mjs";
import { historySummary } from "./rate-summary.mjs";
import { loadQuestions, questionPage, questionsIndex, relatedQuestions } from "./questions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const R = require(path.join(ROOT, "src/rank.js"));
const BC = require(path.join(ROOT, "src/build-cost.js"));
const args = process.argv.slice(2);
const DEMO = args.includes("--demo");
const PREVIEW = args.includes("--preview");
const OUT = path.resolve(ROOT, args.includes("--out") ? args[args.indexOf("--out") + 1] : "dist");
const NOW = Date.now();
const rateText = (v) => Number(v).toLocaleString("en", { maximumFractionDigits: 4 });

function read(p) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); }
  catch (e) { fail([`${p} is not valid JSON: ${e.message}`]); }
}
function fail(problems) {
  console.error("\nBuild stopped. Fix these and publish again:\n" + problems.map((p) => "  - " + p).join("\n") + "\n");
  process.exit(1);
}
function readOptional(p, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); }
  catch { return fallback; }
}

const config = read("config.json");
const corridors = read("data/corridors.json");
const providersFile = read("data/providers.json");
let quotesFile = read("data/quotes.json");
let midmarket = read("data/midmarket.json");
if (!midmarket.rates || !Object.keys(midmarket.rates).length) fail(["data/midmarket.json is missing or has no rates"]);
const buildCosts = readOptional("data/build-costs.json", { countries: {}, houses: [], updated: "" });
const regionalFactors = readOptional("data/regional-factors.json", { countries: {} });
const questions = loadQuestions(path.join(ROOT, "data/questions.json"));
const partners = readOptional("data/partners.json", { travel: {}, origins: {}, airports: {}, sponsors: [] });
if (!buildCosts.countries || !Object.keys(buildCosts.countries).length) fail(["data/build-costs.json is missing or has no countries"]);
{
  const p = [], seen = new Set(), provIds = new Set((providersFile.providers || []).map((x) => x.id));
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
  for (const sp of partners.sponsors || []) {
    const at = `data/partners.json sponsor "${sp.id || sp.name || "?"}"`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sp.id || "")) p.push(`${at}: id must be lowercase letters, numbers and dashes`);
    if (seen.has(sp.id) || provIds.has(sp.id) || TRAVEL_IDS.includes(sp.id)) p.push(`${at}: id is already used`);
    seen.add(sp.id);
    for (const k of ["name", "category", "blurb"]) if (!sp[k]) p.push(`${at}: needs a ${k}`);
    if (!/^https:\/\//.test(sp.url || "")) p.push(`${at}: url must start with https://`);
    if (!isDate(sp.starts) || !isDate(sp.ends)) p.push(`${at}: starts and ends must be dates like 2026-12-01`);
    if (!(sp.countries || []).length) p.push(`${at}: needs at least one country`);
    for (const c of sp.countries || []) if (!buildCosts.countries[c]) p.push(`${at}: unknown country "${c}" (use the ids in data/build-costs.json)`);
    if ((sp.blurb || "").length > 220) p.push(`${at}: keep the blurb under 220 characters`);
  }
  for (const k of ["flightsWrap", "esimWrap"]) { const w = (partners.travel || {})[k]; if (w && (!/^https:\/\//.test(w) || !w.includes("{url}"))) p.push(`data/partners.json travel.${k} must start with https:// and contain {url}`); }
  if (p.length) fail(p);
}

// Quote Check. QUOTE_CHECK_ENABLED=true turns the public pages and calls-to-action on at build time.
// The Worker checks the same env var at runtime, so uploads and payments stay off until it is set there too.
const QC_CONFIG_FILE = read("config/quote-check.json");
const QC = mergeQuoteCheckConfig(QC_CONFIG_FILE);
const QC_ENV = process.env.QUOTE_CHECK_ENABLED;
const QC_ON = QC_ENV === "true" || QC_ENV === "1" || ((QC_ENV == null || QC_ENV === "") && QC.enabled === true);
const QC_TEST = process.env.QUOTE_CHECK_TEST_MODE === "true" || process.env.QUOTE_CHECK_TEST_MODE === "1" || ((process.env.QUOTE_CHECK_TEST_MODE == null || process.env.QUOTE_CHECK_TEST_MODE === "") && QC.payment.testMode === true);
const QC_SYNONYMS = read("data/quote-check/synonyms.json");
if (!QC.prices || !Object.keys(QC.prices).length) fail(["config/quote-check.json needs at least one price in prices"]);
if (!/^\d{4}-\d{2}-\d{2}$/.test(String(buildCosts.updated || ""))) fail(["data/build-costs.json needs an updated date in YYYY-MM-DD form"]);

// Kinds of service, used to compare ways of sending on the Gulf guide.
const METHOD = {
  exchange: { name: "Exchange house", short: "Exchange houses" },
  bank: { name: "Bank remittance service", short: "Bank remittance services" },
  wallet: { name: "Mobile wallet", short: "Mobile wallets" },
  app: { name: "International transfer app", short: "International apps" },
  network: { name: "Global cash network", short: "Global cash networks" }
};
const servesFrom = (p, sid) => !p.sendsFrom || p.sendsFrom.includes(sid);

// ---------- validation ----------
(function validate() {
  const p = [];
  if (!/^https:\/\//.test(config.siteUrl || "")) p.push("config.json: siteUrl must start with https://");
  const senders = corridors.senders || [], receivers = corridors.receivers || [];
  if (!senders.length || !receivers.length) p.push("data/corridors.json: needs senders and receivers");
  const ids = new Set();
  for (const pr of providersFile.providers || []) {
    if (!pr.id || !pr.name) p.push(`data/providers.json: every provider needs an id and a name (${JSON.stringify(pr)})`);
    if (ids.has(pr.id)) p.push(`data/providers.json: "${pr.id}" appears twice`);
    ids.add(pr.id);
    if (!/^https:\/\//.test(pr.website || "")) p.push(`data/providers.json: ${pr.id} website must start with https://`);
    if (pr.affiliateUrl && !/^https:\/\//.test(pr.affiliateUrl)) p.push(`data/providers.json: ${pr.id} affiliateUrl must start with https://`);
  }
  const senderIds = new Set(senders.map((x) => x.id));
  for (const x of senders) if (/-/.test(x.id)) p.push(`data/corridors.json: sender id "${x.id}" must not contain "-"`);
  for (const pr of providersFile.providers || []) {
    for (const sid of pr.sendsFrom || []) if (!senderIds.has(sid)) p.push(`data/providers.json: ${pr.id} sendsFrom has unknown country "${sid}"`);
    if (pr.type && !METHOD[pr.type]) p.push(`data/providers.json: ${pr.id} type must be one of ${Object.keys(METHOD).join(", ")}`);
    if (!/^[a-z]+$/.test(pr.id || "")) p.push(`data/providers.json: id "${pr.id}" must be lowercase letters only`);
  }
  const routes = new Set(senders.flatMap((s) => receivers.map((r) => `${s.id}-${r.id}`)));
  for (const [k, list] of Object.entries(quotesFile.quotes || {})) {
    if (!routes.has(k)) { p.push(`data/quotes.json: unknown route "${k}"`); continue; }
    if (!Array.isArray(list)) { p.push(`data/quotes.json: ${k} must be a list`); continue; }
    list.forEach((q, i) => {
      if (!ids.has(q.provider)) p.push(`data/quotes.json: ${k} #${i + 1} uses unknown provider "${q.provider}"`);
      if (!(Number(q.rate) > 0)) p.push(`data/quotes.json: ${k} ${q.provider} has no valid rate`);
      if (!Array.isArray(q.payout) || !q.payout.length || q.payout.some((m) => !R.LABEL[m])) p.push(`data/quotes.json: ${k} ${q.provider} needs payout from mobile, bank, cash`);
    });
  }
  if (p.length) fail(p);
})();

// Hand-checked corrections for currencies where the free feed is off (kept for up to 36 hours).
try {
  const ov = JSON.parse(fs.readFileSync(path.join(ROOT, "data/mid-overrides.json"), "utf8"));
  if (ov && ov.rates && NOW - new Date(ov.updatedAt).getTime() < 36 * 3600000 && midmarket.rates) {
    Object.assign(midmarket.rates, ov.rates);
    midmarket.overrideAt = ov.updatedAt;
    // The previous check's rates, for the "since yesterday" trend next to the market rate.
    if (ov.previous && ov.previous.rates) midmarket.previous = { updatedAt: ov.previous.updatedAt, rates: Object.assign({ USD: 1 }, ov.previous.rates) };
  }
} catch {}
// Trustpilot ratings (data/ratings.json) are attached to each provider.
const ratingsFile = readOptional("data/ratings.json", { ratings: {} });
for (const p of providersFile.providers) if (ratingsFile.ratings[p.id]) p.rating = { ...ratingsFile.ratings[p.id], source: ratingsFile.source || "Trustpilot", checkedAt: ratingsFile.checkedAt };
const providers = Object.fromEntries(providersFile.providers.map((x) => [x.id, x]));
// Daily history (data/history.json), written by scripts/record-history.mjs after each rate check.
const history = readOptional("data/history.json", { days: {} });
// How often each service delivered the most on a route, from the daily history (last 30 days).
const winsFor = (k) => {
  const days = Object.keys(history.days || {}).sort().slice(-30).map((d) => (history.days[d] || {})[k]).filter((e) => e && (e.by || []).length);
  const n = {}; days.forEach((e) => e.by.forEach((id) => { n[id] = (n[id] || 0) + 1; }));
  return { days: days.length, wins: Object.entries(n).sort((a, b) => b[1] - a[1]) };
};
const histFor = (k) => Object.keys(history.days || {}).sort().map((d) => ({ d, ...(history.days[d][k] || {}) })).filter((x) => x.mid || x.best);
const esc = R.esc;
const plain = (s) => String(s).replace(/ /g, " ");
const site = config.siteUrl.replace(/\/$/, "");
const staleH = config.staleAfterHours || 36, hideH = config.hideAfterHours || 72;

// ---------- demo data (preview only, bannered on every page) ----------
let demoReports = null;
if (DEMO) {
  const rates = { USD: 1, GBP: 0.75, CAD: 1.39, AUD: 1.52, AED: 3.6725, SAR: 3.75, QAR: 3.64, KWD: 0.31, BHD: 0.376, OMR: 0.3845, NGN: 1460, GHS: 11.2, KES: 129.2, UGX: 3640, ZMW: 23.6 };
  midmarket = { base: "USD", updatedAt: new Date(NOW - 3 * 3600000).toISOString(), source: "Example figures", demo: true, rates };
  const pick = ["lemfi", "wise", "worldremit", "remitly", "sendwave", "taptapsend", "afriex", "nala", "westernunion", "mukuru"];
  const out = {}, coverage = {}, reps = {};
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const buckets = ["Under 1 hour", "Same day", "1–2 days"];
  for (const s of corridors.senders) {
    for (const r of corridors.receivers) {
      const k = `${s.id}-${r.id}`, mid = rates[r.currency] / rates[s.currency], ref = config.defaultAmounts[s.currency];
      const from = s.region === "gulf" ? providersFile.providers.filter((p) => servesFrom(p, s.id)).map((p) => p.id) : pick;
      const list = [], used = new Set(), n = Math.min(from.length, 4 + Math.floor(rnd() * 3));
      while (used.size < n) {
        const id = from[Math.floor(rnd() * from.length)];
        if (used.has(id)) continue;
        used.add(id);
        const age = rnd() < 0.1 ? 50 : rnd() < 0.05 ? 90 : rnd() * 10;
        const base = { provider: id, speed: rnd() < 0.7 ? "Minutes" : "Same day", refAmount: ref, checkedAt: new Date(NOW - age * 3600000).toISOString(), note: "" };
        const mk = (markup) => Number((mid * (1 - markup)).toFixed(mid >= 100 ? 2 : 4));
        if (id === "wise") {
          list.push({ ...base, rate: mk(0.001), feeFixed: 0.8, feePct: 1.4, payout: r.id === "nigeria" ? ["bank"] : ["bank", "mobile"] });
        } else if (id === "worldremit" && r.id !== "nigeria") {
          list.push({ ...base, variant: "Mobile money", rate: mk(0.02), feeFixed: 1.99, feePct: 0, payout: ["mobile"] });
          list.push({ ...base, variant: "Bank", rate: mk(0.028), feeFixed: 0.99, feePct: 0, payout: ["bank"] });
        } else {
          const fee = rnd() < 0.45 ? 0 : Math.round((0.99 + rnd() * 4) * 100) / 100;
          const payout = r.id === "nigeria" ? ["bank", ...(rnd() < 0.4 ? ["mobile"] : [])] : ["mobile", ...(rnd() < 0.6 ? ["bank"] : []), ...(rnd() < 0.25 ? ["cash"] : [])];
          list.push({ ...base, rate: mk(0.004 + rnd() * 0.04), feeFixed: fee, feePct: 0, payout });
        }
      }
      out[k] = list;
      coverage[k] = [...used];
      reps[k] = Object.fromEntries([...used].slice(0, 3).map((id) => [id, { n: 3 + Math.floor(rnd() * 20), typical: buckets[Math.floor(rnd() * 3)] }]));
    }
  }
  quotesFile = { updatedAt: new Date(NOW - 2 * 3600000).toISOString(), coverage, quotes: out };
  demoReports = { routes: reps };
}
// Merge quotes scraped directly from operators' own sites (separate files) so those providers
// appear on more routes than the Wise feed alone provides.
for (const [file, providers] of [
  ["worldremit-quotes.json", new Set(["worldremit"])],
  ["extra-quotes.json", new Set(["ria", "mukuru", "transfergo", "paysend", "xe", "smallworld", "ace", "sigue", "ofx"])],
]) {
  const scraped = readOptional(`data/${file}`, { quotes: {} });
  for (const [k, list] of Object.entries(scraped.quotes || {})) {
    quotesFile.quotes[k] = [...(list || []), ...(quotesFile.quotes[k] || []).filter((q) => !providers.has(q.provider))];
  }
}
const quotes = quotesFile.quotes || {};
const isAutoQ = (q) => q.source === "wise-feed" || q.source === "worldremit" || q.source === "scrape" || /^Updated automatically from/.test(q.note || "");
const handCheckedRoutes = Object.entries(quotes).filter(([, list]) => (list || []).some((q) => !isAutoQ(q))).length;
const wiseFeedData = readOptional("data/wise-feed.json", { routes: {} });
const gitDate = (() => { try { return require("child_process").execSync("git log -1 --format=%cs -- scripts/build.mjs config.json", { cwd: ROOT }).toString().trim().slice(0, 10); } catch { return ""; } })();
const guideByUrl = {};
for (const a of (readOptional("data/guides.json", { articles: [] }).articles || [])) guideByUrl[`guides/${a.pillar}/${a.slug}/`] = a;

// Newest date (YYYY-MM-DD) among the quotes, and Wise-feed rows, that match a filter on (route key, provider id).
function newestDate(match) {
  let best = "";
  for (const [k, list] of Object.entries(quotes)) for (const q of list || []) if (q.checkedAt && match(k, q.provider) && q.checkedAt > best) best = q.checkedAt;
  for (const [k, provs] of Object.entries(wiseFeedData.routes || {})) for (const [id, f] of Object.entries(provs || {})) if (f && f.collected && match(k, id) && f.collected > best) best = f.collected;
  return best.slice(0, 10);
}
const senderById = Object.fromEntries(corridors.senders.map((x) => [x.id, x]));
const receiverById = Object.fromEntries(corridors.receivers.map((x) => [x.id, x]));
const routeParts = (k) => { const [sid, rid] = k.split("-"); return { s: senderById[sid], r: receiverById[rid] }; };
const midDate = String((midmarket && midmarket.updatedAt) || "").slice(0, 10);
const later = (a, b) => (a > b ? a : b);
const fallbackDate = String(quotesFile.updatedAt || "").slice(0, 10);

function lastmodFor(u) {
  const seg = u.replace(/\/$/, "").split("/");
  if (seg[0] === "send-money" && seg[1]) {
    const key = seg[1].replace("-to-", "-");
    return newestDate((k) => k === key) || fallbackDate;
  }
  if (seg[0] === "send-money-to" && seg[1]) return newestDate((k) => k.endsWith("-" + seg[1])) || fallbackDate;
  if (seg[0] === "providers" && seg[1]) return newestDate((k, id) => id === seg[1]) || fallbackDate;
  if (seg[0] === "compare" && seg[1]) {
    const [a, b] = seg[1].split("-vs-");
    if (seg[2]) { const key = seg[2].replace("-to-", "-"); return newestDate((k, id) => k === key && (id === a || id === b)) || fallbackDate; }
    return newestDate((k, id) => id === a || id === b) || fallbackDate;
  }
  if (seg[0] === "rates" && seg[1]) {
    const [sc, rc] = seg[1].toUpperCase().split("-TO-");
    const d = newestDate((k) => { const p = routeParts(k); return p.s && p.r && p.s.currency === sc && p.r.currency === rc; });
    return later(d, midDate) || fallbackDate;
  }
  if (seg[0] === "cost-to-build" || (seg[0] === "fr" && seg[1] === "cost-to-build")) {
    const id = seg[0] === "fr" ? seg[2] : seg[1];
    const c = id && (buildCosts.countries || {})[id];
    return String((c && c.updated) || buildCosts.updated || gitDate || "").slice(0, 10);
  }
  if (seg[0] === "guides") {
    const g = guideByUrl[u];
    return String((g && g.updated) || gitDate || "").slice(0, 10);
  }
  return gitDate;
}
const coverage = quotesFile.coverage || {};

// ---------- helpers ----------
const slug = (s, r) => `${s.id}-to-${r.id}`;
const corridorPath = (s, r) => `send-money/${slug(s, r)}/`;
const link = (prefix, p) => { const out = PREVIEW ? prefix + (p === "" ? "index.html" : p.endsWith("/") ? p + "index.html" : p) : prefix + p; return out === "" ? (PREVIEW ? "index.html" : "/") : out; };
const hrefFor = (prefix) => (p, k) => (config.trackClicks && !DEMO ? `${prefix}go/${encodeURIComponent(p.id)}?r=${encodeURIComponent(k)}` : (p.affiliateUrl || p.website).replace("{route}", k));
const hasOg = fs.existsSync(path.join(ROOT, "src/og"));
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
function routeTitle(s, r, top) {
  const from = s.short, name = r.name, sc = s.currency, rc = r.currency;
  if (sc === rc) {
    const t = `Send money from ${from} to ${name}: compare ${sc} transfer services`;
    return t.length <= 60 ? t : `Send money from ${from} to ${name}: ${sc} transfers`;
  }
  let t = top
    ? `Send money from ${from} to ${name}: best ${sc} to ${rc} rate today`
    : `Send money from ${from} to ${name}: compare ${sc} to ${rc} transfer services`;
  if (t.length <= 60) return t;
  t = top
    ? `Send money from ${from} to ${name}: ${sc} to ${rc} rates`
    : `Send money from ${from} to ${name}: ${sc} to ${rc} rates`;
  if (t.length <= 60) return t;
  return top ? `${from} to ${name} transfers: best ${sc} rate today` : `${from} to ${name}: ${sc} to ${rc} rates`;
}
function guideDescription(a) {
  const strip = (t) => String(t || "").replace(/<[^>]+>/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
  const sentencesOf = (t) => (t.match(/[^.!?]+[.!?]+/g) || []).map((x) => x.trim());
  const fit = (t, min) => { let out = ""; for (const sen of sentencesOf(t)) { const next = out ? out + " " + sen : sen; if (next.length > 155) break; out = next; } return out.length >= min ? out : ""; };
  const lead = [a.seoDescription, a.description, a.lede].map(strip).filter(Boolean);
  const body = [];
  for (const sec of a.sections || []) for (const p of sec.paragraphs || []) body.push(strip(p));
  // 1. The page's own summary, if it already fits.
  for (const t of lead) if (t.length >= 90 && t.length <= 155) return t;
  // 2. Whole sentences from the summary (an opening sentence of 90+ characters is enough).
  for (const t of lead) { const out = fit(t, 90); if (out) return out; }
  // 3. Whole sentences from the article body.
  for (const t of body) { const out = fit(t, 110); if (out) return out; }
  return clip(lead[0] || body[0] || "", 155);
}
function compareTitle(A, B) {
  const t = `${A.name} vs ${B.name}: who sends more money to Africa?`;
  return t.length <= 60 ? t : `${A.name} vs ${B.name}: who delivers more to Africa?`;
}

// Logo: the "App Tile". Indigo rounded square, marigold S, and an F whose top bar ends in an arrow (money on its way).
const tile = (fill, ring, size) => `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><rect x="1" y="1" width="62" height="62" rx="16" fill="${fill}"/><rect x="4.5" y="4.5" width="55" height="55" rx="13" fill="none" stroke="#f6b52b" stroke-width="${ring}" opacity=".7"/><g transform="translate(32 32) scale(1.05) translate(-32 -32)" fill="#f6b52b"><path transform="translate(15.52 42.2) scale(.0275 -.0275)" d="M318 -14Q251 -14 199 0Q147 13 110 40Q73 67 54 107Q34 146 32 197L177 239Q180 195 199 167Q219 139 252 125Q285 112 326 112Q363 112 389 121Q416 130 430 145Q444 161 444 179Q444 202 425 217Q407 232 374 243Q342 253 300 264Q253 276 207 290Q161 304 124 326Q87 349 64 384Q42 419 42 472Q42 535 74 580Q105 625 164 649Q224 674 306 674Q389 674 450 648Q511 623 544 575Q577 528 576 463L430 429Q430 458 422 481Q413 503 397 518Q382 534 358 541Q334 549 303 549Q268 549 244 541Q220 532 208 518Q196 504 196 485Q196 462 215 448Q233 433 267 422Q300 412 342 401Q385 391 430 377Q475 363 513 340Q552 318 576 281Q599 243 599 186Q599 123 566 78Q533 33 470 10Q407 -14 318 -14Z"/><path d="M33.2 22.2h11.2v-2.7l5.6 4.8-5.6 4.8v-2.7h-6.6v3.6h5.6v4.2h-5.6v8.1h-4.6z"/></g></svg>`;
const logo = tile("#111853", 1.1, 34);
const wallet = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><rect x="4" y="8" width="16" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="16" cy="13.5" r="1.4" fill="currentColor"/></svg>`;
const fbIcon = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M13.5 21v-7.1h2.4l.4-2.9h-2.8V9.1c0-.9.3-1.5 1.6-1.5h1.3V4.9c-.3 0-1.1-.1-2.1-.1-2.1 0-3.5 1.3-3.5 3.6V11H8.4v2.9h2.4V21h2.7z"/></svg>`;
const igIcon = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><circle cx="12" cy="12" r="4"/><circle cx="17.4" cy="6.6" r="1.2" fill="currentColor" stroke="none"/></svg>`;
const ttIcon = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M16.6 3h-3.1v12.3a2.7 2.7 0 1 1-2.7-2.7c.3 0 .5 0 .8.1V9.5a5.9 5.9 0 1 0 5 5.8V9.1a7.4 7.4 0 0 0 4.3 1.4V7.4a4.3 4.3 0 0 1-4.3-4.4z"/></svg>`;
const socialProfiles = [
  config.facebookUrl ? { name: "Facebook", url: config.facebookUrl, icon: fbIcon } : null,
  config.instagramUrl ? { name: "Instagram", url: config.instagramUrl, icon: igIcon } : null,
  config.tiktokUrl ? { name: "TikTok", url: config.tiktokUrl, icon: ttIcon } : null
].filter(Boolean);
const waIcon = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.6a8.5 8.5 0 0 1-12.6 7.5L3 21l1.9-5.4A8.5 8.5 0 1 1 21 11.6z"/><path d="M8.6 8.9c.2-.5.5-.5.8-.5h.5c.2 0 .4 0 .5.4l.6 1.5c.1.2 0 .4-.1.6l-.4.5c-.1.1-.2.3 0 .6.5.9 1.3 1.6 2.2 2.1.3.2.5.1.6 0l.5-.5c.2-.2.3-.2.6-.1l1.5.7c.3.2.4.3.4.5v.5c0 .4-.2.7-.6.9-.5.3-1.1.4-1.7.2-1.9-.5-3.7-2.1-4.8-4.1-.4-.7-.6-1.4-.4-2 .1-.3.2-.5.3-.8z" fill="currentColor" stroke="none"/></svg>`;
const footerSocials = [...socialProfiles, ...(config.whatsappChannelUrl ? [{ name: "WhatsApp", url: config.whatsappChannelUrl, icon: waIcon }] : [])];

function routeContext(s, r, prefix, amount) {
  const k = `${s.id}-${r.id}`;
  const mid = R.midRate(midmarket, s.currency, r.currency);
  const list = quotes[k] || [];
  const rows = R.rank({ list, providers, amount, payout: "all", mid, now: NOW, staleH, hideH, feed: wiseFeedData.routes[k] });
  const cov = coverage[k] && coverage[k].length ? coverage[k] : Object.keys(providers).filter((id) => servesFrom(providers[id], s.id));
  return {
    s, r, key: k, amount, payout: "all", mid, rows, allRows: rows, hist: histFor(k), now: NOW, midPrev: midmarket.previous ? R.midRate(midmarket.previous, s.currency, r.currency) : null, midPrevAt: midmarket.previous && midmarket.previous.updatedAt, timeStyle: "absolute", anyQuotes: list.length > 0, reports: demoReports ? demoReports.routes[k] : {},
    hrefFor: hrefFor(prefix), disclosureHref: link(prefix, "disclosure/"), checkList: cov.map((id) => providers[id]).filter(Boolean),
    avgPct: config.regionalAverageCost.percent, avgLabel: config.regionalAverageCost.label,
    midUpdated: midmarket && (midmarket.overrideAt || midmarket.updatedAt), quotesUpdated: quotesFile.updatedAt
  };
}

function validateJsonLd(items) {
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("JSON-LD item must be an object: " + JSON.stringify(item).slice(0, 120));
    if (!item["@type"]) throw new Error("JSON-LD item has no @type: " + JSON.stringify(item).slice(0, 120));
    JSON.stringify(item);
  }
}
function jsonldGraph(items) {
  const list = (items || []).filter(Boolean);
  validateJsonLd(list);
  if (!list.length) return "";
  const graph = list.map((item) => { const { "@context": _ctx, ...rest } = item; return rest; });
  return `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph })}</script>`;
}
function head({ title, description, canonical, prefix, jsonld = [], noindex = false, og = "home", ogType = "website", alternates = [], extraCss = [] }) {
  const ads = ""; // AdSense now loads only after the visitor accepts optional cookies (see src/app.js).
  const cfa = config.cfAnalyticsToken && !DEMO ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${esc(config.cfAnalyticsToken)}"}'></script>` : "";
  // Impact (affiliate network, used by Remitly and others): site verification and link tracking.
  const impact = ""; // Impact now loads only after the visitor accepts optional cookies (see src/app.js).
  const fonts = PREVIEW
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&family=Figtree:wght@300..900&display=swap">`
    : `<link rel="preload" href="${prefix}assets/fonts/figtree-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${prefix}assets/fonts/bricolage-grotesque-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${prefix}assets/fonts.css?v=${V.fonts}">`;
  if (hasOg && !fs.existsSync(path.join(ROOT, "src/og", og + ".png"))) og = "home";
  const ogImg = hasOg ? `<meta property="og:image" content="${site}/og/${og}.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`;
  description = clip(description, 158);
  return `<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${PREVIEW ? '<meta name="claude:viewport-fit-sides" content="cover">' : ""}
${noindex || DEMO ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">'}
${canonical != null ? `<link rel="canonical" href="${site}/${canonical}">` : ""}
${alternates.map((a) => `<link rel="alternate" hreflang="${esc(a.lang)}" href="${esc(a.href)}">`).join("\n")}
<meta property="og:site_name" content="${esc(config.siteName)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${esc(ogType)}">
${canonical != null ? `<meta property="og:url" content="${site}/${canonical}">` : ""}
${ogImg}
<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#101428" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${prefix}favicon.svg" type="image/svg+xml">
<link rel="icon" href="${prefix}favicon-48.png" sizes="48x48" type="image/png">
<link rel="icon" href="${prefix}icon-192.png" sizes="192x192" type="image/png">
<link rel="shortcut icon" href="${prefix}favicon.ico">
<link rel="apple-touch-icon" href="${prefix}apple-touch-icon.png"><link rel="manifest" href="${prefix}manifest.webmanifest">
${fonts}
<link rel="stylesheet" href="${prefix}assets/style.css?v=${V.css}">
${extraCss.map((f) => `<link rel="stylesheet" href="${prefix}assets/${f}?v=${V[f === "quote-check.css" ? "qccss" : f.replace(".css", "")] || ""}">`).join("\n")}
${jsonldGraph(jsonld)}
${config.googleSiteVerification ? `<meta name="google-site-verification" content="${esc(config.googleSiteVerification)}">` : ""}
${config.bingSiteVerification ? `<meta name="msvalidate.01" content="${esc(config.bingSiteVerification)}">` : ""}
${ads}${cfa}${impact}`;
}

// Cut a description to fit search results: at a sentence end if one is close, else at a word, with an ellipsis.
// First candidate that fits a search result without being cut off; otherwise the shortest, clipped.
function fitDescription(list, max = 158) {
  const ok = list.find((t) => t.length <= max);
  return ok || clip(list.reduce((a, b) => (b.length < a.length ? b : a)), max);
}
function clip(t, max) {
  t = String(t || "");
  if (t.length <= max) return t;
  const cut = t.slice(0, max), dot = cut.lastIndexOf(". ");
  if (dot > max * 0.6) return cut.slice(0, dot + 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "") + "…";
}
// First title candidate that fits a search result; otherwise the shortest one (the head clips nothing).
function fitTitle(list, max = 60) {
  const ok = list.find((t) => t.length <= max);
  return ok || list.reduce((a, b) => (b.length < a.length ? b : a));
}

function header(prefix, lang, alternates = []) {
  const fr = lang === "fr";
  const alt = (alternates || []).find((a) => a.lang === (fr ? "en" : "fr"));
  const altLink = alt ? `<a class="lang-switch" href="${esc(alt.href)}" hreflang="${alt.lang}" lang="${alt.lang}">${fr ? "English" : "Français"}</a>` : "";
  const L = fr ? {
    allRoutes: t("nav.allRoutes"), buildHouse: t("nav.buildHouse"), guides: t("nav.guides"), search: t("nav.search"),
    embed: t("nav.embed"), howWeRank: t("nav.howWeRank"), about: t("nav.about"), language: t("nav.language"),
    translateNote: t("nav.translateNote"), privacy: t("nav.privacy")
  } : {
    allRoutes: "All routes", buildHouse: "Build a house", guides: "Guides", search: "Search",
    embed: "Rate widget for your site", howWeRank: "How we rank", about: "About", language: "Language",
    translateNote: "Machine translation by Google. Amounts and service names stay as they are.", privacy: "Privacy"
  };
  return `${DEMO ? `<div class="demo-banner"><div class="wrap"><strong>Preview with example figures.</strong> These rates are made up to show how the site works. The live site shows only quotes checked by hand.</div></div>` : ""}
<header class="site-header"><div class="wrap">
<a class="brand" href="${link(prefix, "")}">${logo}<span>SendFair</span></a>
<nav class="site-nav" aria-label="${fr ? "Navigation principale" : "Main"}"><a href="${link(prefix, "")}#corridors">${L.allRoutes}</a><a href="${link(prefix, fr ? "cost-to-build/" : "cost-to-build/")}">${L.buildHouse}</a><div class="nav-svc"><button type="button" class="nav-svc-btn" id="sf-svc-btn" aria-expanded="false" aria-controls="sf-svc-menu">${fr ? "Services" : "Services"}<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="nav-drop" id="sf-svc-menu">${serviceGroups(prefix).map((g) => `<div class="nav-drop-group"><span class="nav-drop-h">${esc(g.title)}</span>${g.items.map((it) => `<a href="${it.href}" data-svc="nav-${it.id}">${esc(it.name)}${it.tag ? ` <span class="svc-tag">${esc(it.tag)}</span>` : ""}</a>`).join("")}</div>`).join("")}</div></div><a href="${link(prefix, "guides/")}">${L.guides}</a><a href="${link(prefix, "search/")}">${L.search}</a><a href="${link(prefix, "methodology/")}">${L.howWeRank}</a><a href="${link(prefix, "about/")}">${L.about}</a>${altLink}<button type="button" class="lang-btn" id="sf-lang" aria-expanded="false" aria-controls="sf-lang-box" title="${fr ? "Traduire cette page" : "Translate this page"}"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9M12 3C9.5 5.6 8.2 8.6 8.2 12s1.3 6.4 3.8 9" fill="none" stroke="currentColor" stroke-width="1.8"/></svg><span class="lang-txt">${L.language}</span></button></nav>
</div><div class="lang-box" id="sf-lang-box" hidden><div class="wrap"><div id="google_translate_element"></div><p class="lang-note">${L.translateNote} <a href="${link(prefix, "privacy/")}">${L.privacy}</a></p></div></div></header>`;
}

function footer(prefix, lang) {
  const fr = lang === "fr";
  const L = fr ? {
    sendTo: t("footer.sendTo"), popularRoutes: t("footer.popularRoutes"), services: t("footer.services"), exchangeRates: t("footer.exchangeRates"),
    buildHouse: t("footer.buildHouse"), sameHouse: t("footer.sameHouse"), materialPrices: t("footer.materialPrices"), whatReceipt: t("footer.whatReceipt"),
    search: t("footer.search"), allPages: t("footer.allPages"), costIndex: t("footer.costIndex"), guides: t("footer.guides"),
    costToBuild: t("footer.costToBuild"), fromGulf: t("footer.fromGulf"), about: t("footer.about"), contact: t("footer.contact"),
    howRank: t("footer.howRank"), howMakeMoney: t("footer.howMakeMoney"), privacy: t("footer.privacy"), terms: t("footer.terms"),
    cookies: t("footer.cookies"), accessibility: t("footer.accessibility"), embed: t("nav.embed"), cookieSettings: t("footer.cookieSettings"), install: t("footer.install"),
    disclaimer: t("footer.disclaimer"), ratesBy: t("footer.ratesBy"),
    copyright: t("footer.copyright", { legal: config.legalName || config.businessName || config.siteName, email: config.contactEmail })
  } : {
    sendTo: "Send money to", popularRoutes: "Popular routes", services: "Services", exchangeRates: "Exchange rates",
    buildHouse: "Build a house", sameHouse: "Same house, every country", materialPrices: "Material prices", whatReceipt: "What the receipt prices",
    search: "Search", allPages: "All pages", costIndex: "Remittance Cost Index", guides: "Guides",
    costToBuild: "Cost to build a house", fromGulf: "Sending from the Gulf", about: "About", contact: "Contact",
    howRank: "How we rank", howMakeMoney: "How we make money", privacy: "Privacy", terms: "Terms",
    cookies: "Cookies", accessibility: "Accessibility", embed: "Rate widget for your site", cookieSettings: "Cookie settings", install: "Add SendFair to your home screen",
    disclaimer: "SendFair compares money transfer services and estimates what it costs to build a house back home. We do not send, hold or exchange money, and we do not build the house. Rates change through the day; always confirm the final amount on the provider's own screen before you pay.",
    ratesBy: "Mid-market reference rates by",
    copyright: `\u00a9 ${new Date(NOW).getUTCFullYear()} ${config.siteName}${(config.legalName || config.businessName) ? `, a ${esc(config.legalName || config.businessName)} service` : ""}. Run independently from Nairobi. Contact: <span class="email">${esc(config.contactEmail)}</span>`
  };
  const FR_COST = new Set(["senegal", "ivorycoast", "mali", "cameroon", "drc", "rwanda"]);
  const hub = (r) => hubPath(r);
  const routeP = (s, r) => corridorPath(s, r);
  const rateP = (a, b) => `rates/${a.toLowerCase()}-to-${b.toLowerCase()}/`;
  const countryCost = (id) => fr && FR_COST.has(id) ? `fr/cost-to-build/${id}/` : `cost-to-build/${id}/`;
  return `<footer class="site-footer"><div class="wrap">
<a class="brand" href="${link(prefix, "")}">${logo}<span>SendFair</span></a>
<div class="foot-cols">
<div><h2>${L.sendTo}</h2><ul>${corridors.receivers.map((r) => `<li><a href="${link(prefix, hub(r))}">${esc(r.name)}</a></li>`).join("")}</ul></div>
<div><h2>${L.popularRoutes}</h2><ul>${(config.priorityRoutes || []).map((k) => { const [a, b] = k.split("-"); const S = corridors.senders.find((x) => x.id === a), Rr = corridors.receivers.find((x) => x.id === b); return S && Rr ? `<li><a href="${link(prefix, routeP(S, Rr))}">${esc(S.label)} ${fr ? "vers" : "to"} ${esc(Rr.name)}</a></li>` : ""; }).join("")}</ul></div>
<div><h2>${L.services}</h2><ul>${providersWithQuotes().map((p) => `<li><a href="${link(prefix, provPath(p))}">${esc(p.name)} review</a></li>`).join("")}</ul></div>
<div><h2>${L.exchangeRates}</h2><ul>${["GBP-NGN", "USD-NGN", "GBP-KES", "USD-KES", "GBP-GHS", "USD-GHS"].map((x) => { const [a, b] = x.split("-"); return `<li><a href="${link(prefix, rateP(a, b))}">${a} ${fr ? "vers" : "to"} ${b}</a></li>`; }).join("")}</ul></div>
<div><h2>${L.buildHouse}</h2><ul>${QC_ON ? `<li><a href="${link(prefix, "quote-check/")}">Quote Check</a></li>` : ""}<li><a href="${link(prefix, "cost-to-build/same-house/")}">${L.sameHouse}</a></li><li><a href="${link(prefix, "cost-to-build/material-prices/")}">${L.materialPrices}</a></li><li><a href="${link(prefix, fr ? "fr/cost-to-build/what-this-receipt-is/" : "cost-to-build/what-this-receipt-is/")}">${L.whatReceipt}</a></li>${Object.keys(buildCosts.countries || {}).map((id) => `<li><a href="${link(prefix, countryCost(id))}">${esc(buildCosts.countries[id].name)}</a></li>`).join("")}</ul></div>
</div>
${footerSocials.length ? `<nav class="social" aria-label="Social media">${footerSocials.map((s) => `<a href="${esc(s.url)}" rel="noopener" target="_blank">${s.icon}<span>${s.name}</span></a>`).join("")}</nav>` : ""}
<nav aria-label="${fr ? "Liens de pied de page" : "Footer"}"><a href="${link(prefix, "search/")}">${L.search}</a><a href="${link(prefix, "sitemap/")}">${L.allPages}</a><a href="${link(prefix, "reports/")}">${L.costIndex}</a><a href="${link(prefix, "guides/")}">${L.guides}</a>${questions.some((q) => q.status === "live") ? `<a href="${link(prefix, "questions/")}">Questions</a>` : ""}<a href="${link(prefix, "cost-to-build/")}">${L.costToBuild}</a><a href="${link(prefix, "flying-home/")}">${fr ? "Rentrer au pays" : "Flying home"}</a>${gulfSenders.length ? `<a href="${link(prefix, GULF_GUIDE)}">${L.fromGulf}</a>` : ""}<a href="${link(prefix, "about/")}">${L.about}</a><a href="${link(prefix, "contact/")}">${L.contact}</a><a href="${link(prefix, "methodology/")}">${L.howRank}</a><a href="${link(prefix, "disclosure/")}">${L.howMakeMoney}</a><a href="${link(prefix, "advertise/")}">${fr ? "Publicité" : "Advertise"}</a><a href="${link(prefix, "embed/")}">${L.embed}</a><a href="${link(prefix, "privacy/")}">${L.privacy}</a><a href="${link(prefix, "terms/")}">${L.terms}</a><a href="${link(prefix, "cookies/")}">${L.cookies}</a><a href="${link(prefix, "accessibility/")}">${L.accessibility}</a><button type="button" class="cookie-settings" id="sf-cookie-settings" hidden>${L.cookieSettings}</button><button type="button" class="install-btn" id="sf-install" hidden>${L.install}</button></nav>
<p>${L.disclaimer}</p>
<p>${L.ratesBy} <a href="https://www.exchangerate-api.com" rel="noopener" target="_blank">ExchangeRate-API</a>.</p>
<p>${L.copyright}</p>
</div></footer>`;
}

// Notification card in the header: what the family's phone would show for today's best option, in their local time.
function phone(ctx) {
  const n = R.notice(ctx);
  const home = R.homeTime(ctx.r.id, NOW);
  return `<figure class="phone" id="sf-phone">
<div class="notif" id="sf-notif"><span class="notif-icon">${wallet}</span><div class="notif-main"><div class="notif-head"><strong id="sf-ph-title">${n.title}</strong><span><span id="sf-ph-city">${esc(home.city)}</span> <span id="sf-ph-time">${home.time}</span></span></div><p id="sf-ph-text">${n.text}</p></div></div>
<figcaption id="sf-ph-cap">${n.cap}</figcaption>
</figure>`;
}

function tool({ heading, sub, ctx, after = "" }) {
  const baseQuick = STEP_AMOUNTS[ctx.s.currency] || [];
  const quickList = baseQuick.indexOf(ctx.amount) > -1 ? baseQuick : [...baseQuick, ctx.amount].sort((a, b) => a - b);
  return `<section class="hero"><div class="wrap hero-grid">
<div class="hero-copy"><h1>${heading}</h1><p class="lede">${sub}</p></div>
<div class="hero-side">${phone(ctx)}<div class="picks" id="sf-picks" aria-label="Best service by way of receiving">${R.picks(ctx)}</div></div>
</div></section>
<section class="sheet"><div class="wrap">
<div class="tool">
  <div class="controls">
    <div class="field"><label for="sf-from">Sending from</label><select id="sf-from">${corridors.senders.map((s) => `<option value="${s.id}"${s.id === ctx.s.id ? " selected" : ""}>${esc(s.label)} (${s.currency})</option>`).join("")}</select></div>
    <div class="field"><label for="sf-to">Sending to</label><select id="sf-to">${corridors.receivers.map((r) => `<option value="${r.id}"${r.id === ctx.r.id ? " selected" : ""}>${esc(r.name)} (${r.currency})</option>`).join("")}</select></div>
    <div class="field amount-field"><label for="sf-amount" id="sf-amount-label">You pay in total</label><div class="amount-wrap"><button type="button" id="sf-mode" class="mode-btn" title="Switch between the amount you pay and the amount they need">Pay <span class="mode-cur">${ctx.s.currency}</span><span class="mode-ic" aria-hidden="true">⇄</span></button><span id="sf-cur" hidden>${ctx.s.currency}</span><input id="sf-amount" type="number" inputmode="decimal" min="1" step="any" value="${ctx.amount}"><span class="quick" id="sf-quick" role="group" aria-label="Common amounts">${quickList.map((a) => `<button type="button" data-amt="${a}" aria-pressed="${a === ctx.amount}">${a >= 1000 ? a / 1000 + "k" : a}</button>`).join("")}</span></div></div>
    <div class="field payout-field"><span class="label" id="sf-payout-label">They receive by</span><div class="payout-tabs" role="group" aria-labelledby="sf-payout-label">
      <button type="button" data-payout="all" aria-pressed="true">Any</button><button type="button" data-payout="mobile" aria-pressed="false">Mobile<span class="lg"> money</span></button><button type="button" data-payout="bank" aria-pressed="false">Bank</button><button type="button" data-payout="cash" aria-pressed="false">Cash</button>
    </div></div>
  </div>
  <div id="sf-results">${R.renderResults(ctx)}</div>
  <div class="tool-meta" id="sf-meta">${R.metaLine(ctx)}</div>
  <p class="note" id="sf-note"${ctx.r.note ? "" : " hidden"}>${esc(ctx.r.note)}</p>
</div>
<ul class="trustbar" aria-label="Why you can trust these rankings">
  <li><strong>Independent.</strong> Run from Nairobi; no provider owns us.</li>
  <li><strong>${handCheckedRoutes === 0 ? "Updated automatically" : "Updated every 30 minutes"}</strong>${handCheckedRoutes === 0 ? " every 30 minutes, mostly from Wise's comparison data" : ` for the big providers, and ${handCheckedRoutes} routes checked by hand`}; each row shows when.</li>
  <li><strong>Standard rates only.</strong> No paid placements; commissions never change the order.</li>
  <li><strong>Ratings shown</strong> from Trustpilot, so you see what customers say.</li>
</ul>
${shareBar(ctx)}${after}
</div></section>`;
}

function shareBar(ctx) {
  const url = ctx.shareUrl || `${site}/${corridorPath(ctx.s, ctx.r)}`;
  const shareLink = `${url}${url.includes("?") ? "&" : "?"}ref=share`;
  return `<div class="share">
<a id="sf-wa" data-url="${esc(url)}" href="https://wa.me/?text=${encodeURIComponent(R.shareText(ctx, url))}" target="_blank" rel="noopener">Share on WhatsApp</a>
<button type="button" id="sf-share-result" data-route="${esc(ctx.key)}" data-amount="${ctx.amount}" data-ts="${esc(ctx.quotesUpdated || "")}" data-link="${esc(shareLink)}">Share this result</button>
<button type="button" id="sf-save-route" data-route="${esc(ctx.key)}" data-amount="${ctx.amount}">Save this route</button>
<button type="button" id="sf-copy">Copy link</button>
<span class="share-msg" id="sf-share-msg" aria-live="polite"></span>
</div>
<div class="share-more" id="sf-share-more" hidden>
<a id="sf-fb" target="_blank" rel="noopener">Facebook</a>
<a id="sf-x" target="_blank" rel="noopener">X</a>
<button type="button" id="sf-wa-text">WhatsApp</button>
<button type="button" id="sf-download">Download image</button>
<button type="button" id="sf-copy2">Copy link</button>
</div>`;
}

function reportSection(ctx) {
  if (!config.reportsEnabled && !DEMO) return "";
  return `<section class="block"><div class="wrap"><form class="report" id="sf-report">
<div class="section-head"><h2>Sent money on this route recently?</h2><p class="lede">Tell other senders how long it took to arrive. It takes five seconds and we never ask who you are.</p></div>
<label for="sf-rep-provider" class="label">Service you used</label>
<select id="sf-rep-provider"><option value="">Choose the service you used</option>${(ctx.checkList || []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select>
<fieldset><legend>How long until the money arrived?</legend>
<label class="opt"><input type="radio" name="sf-rep-bucket" value="under1h"> Under 1 hour</label>
<label class="opt"><input type="radio" name="sf-rep-bucket" value="sameday"> Same day</label>
<label class="opt"><input type="radio" name="sf-rep-bucket" value="1to2days"> 1&ndash;2 days</label>
<label class="opt"><input type="radio" name="sf-rep-bucket" value="longer"> Longer</label>
</fieldset>
<fieldset class="report-rating"><legend>Rate it (optional)</legend>${[1, 2, 3, 4, 5].map((n) => `<label class="opt"><input type="radio" name="sf-rep-rating" value="${n}"> ${n} ★</label>`).join("")}</fieldset>
<label for="sf-rep-comment" class="label">A short comment (optional, up to 200 characters)</label>
<textarea id="sf-rep-comment" name="comment" maxlength="200" rows="2" placeholder="How did it go?"></textarea>
<button type="submit">Send report</button><p class="report-msg" id="sf-rep-msg" aria-live="polite"></p>
</form>
<div class="comments" id="sf-comments" data-route="${esc(ctx.key)}" hidden><h3>What other senders said</h3><ul></ul></div>
</div></section>`;
}

function alerts() {
  let body;
  if (DEMO) {
    body = `<form id="sf-alert-form" data-demo="1"><label for="sf-email" class="label" style="flex-basis:100%;color:inherit">Email for daily alerts</label><input id="sf-email" name="email" type="email" required placeholder="you@example.com"><button type="submit">Get rate alerts</button></form><p id="sf-alert-msg" aria-live="polite"></p>`;
  } else if (config.newsletterFormAction) {
    const embed = String(config.newsletterFormAction).includes("embed-subscribe") ? `<input type="hidden" name="embed" value="1"><p><a href="https://buttondown.com/${esc(String(config.newsletterFormAction).split("/").pop())}">SendFair on Buttondown</a></p>` : "";
    const wa = config.whatsappChannelUrl ? `<div style="margin-top:14px"><a class="btn-light" href="${esc(config.whatsappChannelUrl)}" target="_blank" rel="noopener">Follow on WhatsApp</a></div>` : "";
    body = `<form id="sf-alert-form" action="${esc(config.newsletterFormAction)}" method="post">${embed}<label for="sf-email" class="label" style="flex-basis:100%;color:inherit">Email for daily alerts</label><input id="sf-email" name="email" type="email" required placeholder="you@example.com"><button type="submit">Get rate alerts</button></form>${wa}`;
  } else if (config.whatsappChannelUrl) {
    body = `<div><a class="btn-light" href="${esc(config.whatsappChannelUrl)}" target="_blank" rel="noopener">Follow on WhatsApp</a></div>`;
  } else return "";
  const confirm = config.newsletterFormAction ? " We ask you to confirm the address before the first message." : "";
  return `<section class="alerts" id="alerts"><div class="wrap"><h2>Know when your rate moves</h2><p>One short message each morning: which service pays the most for your route today. Unsubscribe anytime.${confirm}</p>${body}</div></section>`;
}

function houseNote(r, prefix) {
  const c = buildCosts.countries && buildCosts.countries[r.id];
  if (!c) return "";
  const est = BC.estimate(buildCosts, r.id, 110, 1, midmarket.rates || {});
  if (!est || !(est.total > 0)) return "";
  return `<h2>Building a house in ${esc(r.name)}</h2>
<p>A 3-bedroom bungalow in ${esc(c.city)} needs about ${esc(plain(R.money(est.total, est.currency)))} for the build, on prices checked ${esc(buildCosts.updated)}. You can switch the roof sheet, windows, doors, tiles, ceiling and paint. Land and the contractor's fee are not included. <a href="${link(prefix, `cost-to-build/${r.id}/`)}">Open the ${esc(r.name)} house calculator</a> before you send a lump sum.</p>`;
}

function buildWidget(prefix, countryId, lang, opts = {}) {
  const fr = lang === "fr";
  const extra = `${opts.factor && opts.factor !== 1 ? ` data-factor="${opts.factor}"` : ""}${opts.size ? ` data-size="${esc(opts.size)}"` : ""}${opts.city ? ` data-city="${esc(opts.city)}"` : ""}`;
  return `<div class="build-tool" id="sf-build" data-country="${esc(countryId)}" data-root="${prefix}" data-lang="${fr ? "fr" : "en"}"${extra}>
<div class="build-controls">
  <label>${fr ? "Pays" : "Country"} <select id="sf-build-country"></select></label>
  <label>${fr ? "Envoi depuis" : "Sending the money from"} <select id="sf-build-from"></select></label>
</div>
<div class="build-controls">
  <div class="field"><span class="label" id="sf-storey-label">${fr ? "Maison" : "House"}</span><div class="payout-tabs" id="sf-build-storey" role="group" aria-labelledby="sf-storey-label"><button type="button" data-storeys="1" aria-pressed="true">${fr ? "Plain-pied" : "Bungalow"}</button><button type="button" data-storeys="2" aria-pressed="false">${fr ? "Deux niveaux" : "Maisonette"}</button></div><span class="hint">${fr ? "Même surface. Deux niveaux, c'est la même surface sur une emprise plus petite." : "Same floor area. A maisonette is two floors on a smaller footprint."}</span></div>
  <div class="field"><span class="label" id="sf-finish-label">${fr ? "Finition" : "Finish"}</span><div class="payout-tabs" id="sf-build-finish" role="group" aria-labelledby="sf-finish-label"><button type="button" data-finish="economy">${fr ? "Économie" : "Economy"}</button><button type="button" data-finish="standard" aria-pressed="true">${fr ? "Standard" : "Standard"}</button><button type="button" data-finish="luxury">${fr ? "Luxe" : "Luxury"}</button></div><span class="hint">${fr ? "Le standard est le prix affiché. Économie et luxe ne changent que le carrelage, la peinture, les portes, les fenêtres et les appareils. La structure, la main-d'œuvre et le permis restent au prix affiché." : "Standard is the listed price. Economy and luxury change tiles, paint, doors, windows and fittings only. Structure, labour and the permit stay on the listed price."}</span></div>
  <div class="field"><span class="label" id="sf-site-label">${fr ? "Terrain" : "Plot"}</span><div class="payout-tabs" id="sf-build-site" role="group" aria-labelledby="sf-site-label"><button type="button" data-site="flat" aria-pressed="true">${fr ? "Plat, sur une route" : "Flat, on a road"}</button><button type="button" data-site="steep">${fr ? "Pentu ou loin" : "Steep or far"}</button></div><span class="hint">${fr ? "Pentu ou loin ajoute une marge sur le sable et le gravier. Une étude de sol reste nécessaire." : "Steep or far adds a planning allowance to sand and ballast. A soil test is still required."}</span></div>
</div>
<div class="size-picks" id="sf-build-sizes" role="group" aria-label="${fr ? "Taille" : "House size"}"></div>
<div id="sf-build-custom" hidden><label>${fr ? "Surface, mètres carrés" : "Floor area, square metres"} <input id="sf-build-m2" type="number" min="20" max="500" step="1" value="120"></label></div>
<div class="build-side">
  <label>${fr ? "Leur somme, dans la monnaie du pays" : "Their lump sum, in this country's currency"} <input id="sf-build-quote" inputmode="decimal" placeholder="${fr ? "Collez leur chiffre" : "Paste their figure"}" autocomplete="off"></label>
  <fieldset>
    <legend>${fr ? "Sous le reçu. Hors du total tant que vous ne les cochez pas." : "Under the receipt. Off until you include them."}</legend>
    <label><input id="sf-x-contingency" type="checkbox"> ${fr ? "Imprévus de 10 %" : "10% contingency"}</label>
    <label><input id="sf-x-contractor" type="checkbox"> ${fr ? "Marge de l'entrepreneur, là où elle est publiée" : "Contractor's fee, where a margin is published"}</label>
    <label><input id="sf-x-professional" type="checkbox"> ${fr ? "Architecte et ingénieur" : "Architect and engineer"}</label>
  </fieldset>
</div>
<div id="sf-build-out"><p class="note">${fr ? "Calcul des quantités…" : "Working out the quantities…"}</p></div>
</div>`;
}

// ---------- Quote Check (paid builder-quote review) ----------
const QUOTE_CHECK_LOCAL_TERMS = {
  kenya: "mabati, sandcrete blocks, river sand and fundi days",
  nigeria: "Dangote cement, sandcrete blocks, sharp sand, granite and bricklayer days",
  ghana: "Ghacem cement, sandcrete blocks, chippings and mason days",
  uganda: "iron sheets, concrete blocks, lake sand and mason days",
  tanzania: "iron sheets, concrete blocks, sand and mason days",
  zambia: "iron sheets, concrete blocks, sand and bricklayer days",
  zimbabwe: "IBR sheets, concrete blocks, sand and builder days",
  southafrica: "IBR sheets, concrete blocks, sand and builder days"
};
function quoteCheckCurrencyOptions(selected) {
  const set = new Set(Object.values(buildCosts.countries).map((c) => c.currency));
  for (const cur of Object.keys(QC.prices)) set.add(cur);
  ["USD", "GBP", "EUR"].forEach((c) => set.add(c));
  return [...set].sort().map((c) => `<option value="${esc(c)}"${c === selected ? " selected" : ""}>${esc(c)}</option>`).join("");
}
function quoteCheckPriceString() {
  return Object.entries(QC.prices).map(([cur, amount]) => `${cur} ${Number(amount).toLocaleString("en")}`).join(" · ");
}
function quoteCheckClientConfig() {
  return {
    enabled: QC_ON,
    prices: QC.prices,
    defaultPriceCurrency: QC.defaultPriceCurrency,
    maxFiles: QC.limits.maxFiles,
    maxFileMb: QC.limits.maxFileMb,
    maxTotalMb: QC.limits.maxTotalMb,
    testMode: QC_TEST,
    countries: Object.fromEntries(Object.entries(buildCosts.countries).map(([id, c]) => [id, { currency: c.currency, name: c.name }]))
  };
}

function quoteCheckHero(countryId) {
  const c = countryId ? buildCosts.countries[countryId] : null;
  const where = c ? ` in ${esc(c.name)}` : "";
  const price = quoteCheckPrice(QC, c ? c.currency : "KES");
  return `<section class="qc-hero"><div class="wrap">
<div>
<p class="qc-kicker">SendFair Quote Check${c ? " · " + esc(c.name) : ""}</p>
<h1>Is your builder's quote${where} fair?</h1>
<p class="qc-lede">We check it line by line against today's local prices — cement, blocks, roofing, tiles, labour days and the permit — and show you where it sits. You see the quote total and how many lines we can match before you pay.</p>
<div class="qc-hero-actions"><a class="qc-btn" href="#check">Check my quote</a><a class="qc-btn qc-btn-ghost" href="#sample">See a sample report</a></div>
</div>
<div class="qc-hero-card">
<p class="qc-kicker">One-off fee</p>
<p class="qc-price" data-qc-price>${price.currency} ${Number(price.amount).toLocaleString("en")}</p>
<p style="font-size:.82rem;color:var(--on-indigo-muted);margin:0 0 12px">Free preview first. Pay only to unlock the line-by-line report.</p>
<ul>
<li>Every matched line, with our local price and the date checked</li>
<li>A verdict: below, within, above or well above typical</li>
<li>Quantity checks and questions to ask your builder</li>
<li>A private web report and a PDF by email</li>
</ul>
</div>
</div></section>`;
}

function quoteCheckPanels(countryId) {
  const c = countryId ? buildCosts.countries[countryId] : null;
  return `<section class="qc-block"><div class="wrap">
<div class="qc-section-head"><h2>What we check, and what we don't</h2><p>${c ? `The same published ${esc(c.name)} prices behind our <a href="${link("../../", `cost-to-build/${countryId}/`)}">house calculator</a>, applied to the quote in front of you.` : "The same published prices behind our house calculator, applied to the quote in front of you."}</p></div>
<div class="qc-two">
<div class="qc-panel yes"><h3>What we check</h3><ul>
<li>Cement, steel, sand, ballast, blocks, roofing, timber, windows, doors, tiles, ceiling, paint, kitchen, wardrobes, plumbing and electrical lines.</li>
<li>Trade days: mason, labourer, carpenter, painter, electrician and plumber, where the quote prices them separately.</li>
<li>The published building permit and plan fees for the stated floor area.</li>
<li>The quote's own arithmetic: quantity x unit price against the line total, and the lines against the quote total.</li>
<li>Quantity sanity checks for cement, blocks, roofing and other items, using the same planning take-off as the calculator.</li>
<li>A currency conversion at the mid-market rate when the quote is written in a different currency from the price list.</li>
</ul></div>
<div class="qc-panel no"><h3>What we don't check</h3><ul>
<li>The plot of land, stamp duty, survey and title work.</li>
<li>The contractor's fee, profit, overhead, financing and site preliminaries.</li>
<li>Architect's, engineer's and quantity surveyor's fees, and design changes.</li>
<li>Structural design, soil conditions, retaining walls, water and power connections.</li>
<li>Anything not in our price data, including imported or specialist finishes. Those lines are listed as not checked, never given an invented price.</li>
<li>Whether the builder is honest or the workmanship is good. We check the numbers, not the person.</li>
</ul></div>
</div>
</div></section>`;
}

function quoteCheckSteps() {
  return `<section class="qc-block alt"><div class="wrap">
<div class="qc-section-head"><h2>How it works</h2><p>Upload the quote. We read it, check it and show you a free preview before you pay.</p></div>
<div class="qc-steps">
<div class="qc-step"><h3>Upload the quote</h3><p>A PDF, a photo of a printed or handwritten quote, an XLSX or a CSV. Up to ${QC.limits.maxFiles} files, ${QC.limits.maxFileMb} MB each.</p></div>
<div class="qc-step"><h3>See the free preview</h3><p>The number of line items, the quote total we detected, and how many lines we can match to our local prices. No line-level verdicts yet.</p></div>
<div class="qc-step"><h3>Pay once, read the report</h3><p>Unlock the line-by-line table, the verdict, quantity checks and the questions to ask. The private link works on your phone; the PDF arrives by email.</p></div>
</div>
</div></section>`;
}

function quoteCheckForm(prefix, countryId) {
  const selected = countryId || "kenya";
  const c = buildCosts.countries[selected] || buildCosts.countries.kenya;
  const price = quoteCheckPrice(QC, c.currency);
  const countryOptions = Object.entries(buildCosts.countries).map(([id, x]) => `<option value="${esc(id)}"${id === selected ? " selected" : ""}>${esc(x.name)} (${esc(x.currency)})</option>`).join("");
  const disabled = QC_ON ? "" : " disabled";
  return `<div class="qc-form-wrap">
<form class="qc-form" id="qc-form" method="post" action="/api/quote-check/upload" enctype="multipart/form-data" data-enabled="${QC_ON ? "true" : "false"}" data-config="${esc(JSON.stringify(quoteCheckClientConfig()))}">
<h2>Check my quote</h2>
<p class="qc-hint">Free preview first. We ask for the country, the house and an email so we can send the report and match the right local prices.</p>
<div id="qc-disabled" class="qc-alert qc-test"${QC_ON ? " hidden" : ""}><strong>Quote Check opens soon.</strong> We are not taking quotes yet. Email <a href="mailto:hello@sendfair.africa">hello@sendfair.africa</a> and we will tell you when it opens.</div>
${QC_TEST && QC_ON ? '<div class="qc-alert qc-test"><strong>Test mode.</strong> Sample quotes are used for Kenya, Nigeria and Ghana. No card is charged. Do not use this build for real customers.</div>' : ""}
<div class="qc-grid">
<div class="qc-field"><label for="qc-country">Country</label><select id="qc-country" name="country" required>${countryOptions}</select></div>
<div class="qc-field"><label for="qc-town">Town, county or state</label><input id="qc-town" name="town" type="text" maxlength="120" placeholder="e.g. ${esc(c.city || "Nairobi")}" required></div>
<div class="qc-field"><label for="qc-bedrooms">Bedrooms</label><select id="qc-bedrooms" name="bedrooms" required>${[1,2,3,4,5,6].map((n) => `<option value="${n}"${n === 3 ? " selected" : ""}>${n}${n === 6 ? "+" : ""}</option>`).join("")}</select></div>
<div class="qc-field"><label for="qc-storeys">House type</label><select id="qc-storeys" name="storeys" required><option value="1" selected>Bungalow (one floor)</option><option value="2">Maisonette (two floors)</option></select></div>
<div class="qc-field"><label for="qc-m2">Approximate floor area, m²</label><input id="qc-m2" name="m2" type="number" min="20" max="1000" step="1" value="110" required><span class="qc-hint">A 3-bedroom bungalow is often about 100–120 m².</span></div>
<div class="qc-field"><label for="qc-quote-currency">Quote currency</label><select id="qc-quote-currency" name="quoteCurrency" required>${quoteCheckCurrencyOptions(c.currency)}</select></div>
<div class="qc-field full"><label for="qc-email">Email for the report</label><input id="qc-email" name="email" type="email" autocomplete="email" maxlength="200" placeholder="you@example.com" required><span class="qc-hint">We send the private report link and the PDF here.</span></div>
</div>
<div class="qc-field full">
<span class="qc-label" id="qc-files-label">The quote</span>
<div class="qc-drop" id="qc-drop" role="button" tabindex="0" aria-labelledby="qc-files-label">
<strong>Drop the quote here, or click to choose</strong>
<span>PDF, JPG/PNG photo, XLSX or CSV · up to ${QC.limits.maxFiles} files · ${QC.limits.maxFileMb} MB each</span>
<input id="qc-files" name="files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.xlsx,.csv" required${disabled}>
</div>
<ul class="qc-files" id="qc-file-list" aria-live="polite"></ul>
</div>
<label class="qc-consent"><input type="checkbox" name="consent" value="on" required><span>I agree to SendFair processing these files to produce this report, and I accept the <a href="${link(prefix, "terms/")}">terms</a> and the <a href="${link(prefix, "privacy/")}">privacy policy</a>. I confirm I have the right to share this quote.</span></label>
<div class="qc-error" id="qc-error" role="alert" tabindex="-1" hidden></div>
<div class="qc-progress" id="qc-progress" hidden><span class="qc-spinner" aria-hidden="true"></span><span>Uploading and reading the quote…</span></div>
<button class="qc-btn" id="qc-submit" type="submit"${disabled}>Check my quote</button>
<noscript><p class="qc-small">Quote Check needs JavaScript to upload the files. Email <a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a> if you cannot use the form.</p></noscript>
</form>
<div class="qc-side">
<div class="qc-side-card"><h3>One-off fee</h3><p class="qc-side-price" data-qc-price>${price.currency} ${Number(price.amount).toLocaleString("en")}</p><p>Free preview first. Pay only if you want the line-by-line report. The charge currency is confirmed at checkout.</p></div>
<div class="qc-side-card"><h3>What you get</h3><ul><li>A private web report with a line-by-line table.</li><li>Our typical unit price and the date we checked it.</li><li>A PDF sent to your email.</li><li>The unmatched lines, listed separately as not checked.</li><li>Questions to ask your builder.</li></ul></div>
<div class="qc-side-card"><h3>Your files</h3><p>Stored privately, never on a public URL. Deleted together with the extracted data ${QC.retentionDays} days after the report. Under the Kenya Data Protection Act and, for diaspora users, GDPR/UK GDPR.</p></div>
</div>
</div>`;
}

function quoteCheckSample(countryId) {
  const c = countryId ? buildCosts.countries[countryId] : buildCosts.countries.kenya;
  const cur = c.currency;
  return `<section class="qc-block" id="sample"><div class="wrap">
<div class="qc-section-head"><h2>A sample report</h2><p>Example figures from a Kenya quote, shown to explain the format. They are not a real quote and not a price for your house.</p></div>
<div class="qc-cards">
<div class="qc-card"><span class="qc-card-k">Quote total detected</span><strong class="qc-card-v">KES 3,642,600</strong><span class="qc-card-s">19 line items</span></div>
<div class="qc-card"><span class="qc-card-k">SendFair estimate for matched items</span><strong class="qc-card-v">KES 2,859,130</strong><span class="qc-card-s">16 of 19 lines matched</span></div>
<div class="qc-card"><span class="qc-card-k">Difference on matched items</span><strong class="qc-card-v qc-up">+KES 525,970</strong><span class="qc-card-s">+18.4% · matched value KES 3,385,100</span></div>
<div class="qc-card qc-verdict qc-flag-above"><span class="qc-card-k">Verdict</span><strong class="qc-card-v">Above typical</strong><span class="qc-card-s">Ask about the flagged lines before you agree.</span></div>
</div>
<div class="table-wrap qc-table-wrap"><table class="rates-table qc-table">
<caption>Sample line-by-line rows. Our prices checked ${esc(buildCosts.updated)}.</caption>
<thead><tr><th>Item as written</th><th>Our match</th><th class="num">Qty</th><th>Unit</th><th class="num">Quoted unit</th><th class="num">Our typical unit</th><th class="num">Difference</th><th>Flag</th></tr></thead>
<tbody>
<tr><td><strong>Cement, 50kg bags</strong></td><td>Cement<span class="qc-line-note">Bamburi Fundi, top of the range</span></td><td class="num">650</td><td>bags</td><td class="num">KES 820</td><td class="num">KES 780<span class="qc-src">checked ${esc(buildCosts.updated)}</span></td><td class="num"><span class="qc-flag-within">+5.1%</span></td><td><span class="qc-flag qc-flag-within">Within typical range</span></td></tr>
<tr><td><strong>Mabati iron sheets, gauge 30</strong></td><td>Roofing</td><td class="num">220</td><td>m²</td><td class="num">KES 720</td><td class="num">KES 580<span class="qc-src">checked ${esc(buildCosts.updated)}</span></td><td class="num"><span class="qc-flag-above">+24.1%</span></td><td><span class="qc-flag qc-flag-above">Above typical</span></td></tr>
<tr><td><strong>Ceiling boards</strong></td><td>Ceiling boards<span class="qc-line-note">arithmetic does not add up</span></td><td class="num">110</td><td>m²</td><td class="num">KES 250</td><td class="num">KES 182<span class="qc-src">checked ${esc(buildCosts.updated)}</span></td><td class="num"><span class="qc-flag-well">+37.4%</span></td><td><span class="qc-flag qc-flag-well">Well above typical</span></td></tr>
<tr><td><strong>Machine-cut stones 9x9</strong></td><td>Not checked<span class="qc-line-note">our boundary-wall price is per metre, the quote is per piece</span></td><td class="num">500</td><td>pieces</td><td class="num">KES 60</td><td class="num">—</td><td class="num">—</td><td><span class="qc-flag qc-flag-none">Not checked</span></td></tr>
<tr><td><strong>Architect's fee</strong></td><td>Not checked<span class="qc-line-note">outside our price data</span></td><td class="num">1</td><td>each</td><td class="num">KES 150,000</td><td class="num">—</td><td class="num">—</td><td><span class="qc-flag qc-flag-none">Not checked</span></td></tr>
</tbody></table></div>
<p class="qc-small">The full report also lists quantity checks and the questions to ask your builder. Prices are checked ${esc(buildCosts.updated)}.</p>
</div></section>`;
}

function quoteCheckFaqs(countryId) {
  const c = countryId ? buildCosts.countries[countryId] : null;
  const where = c ? ` in ${c.name}` : "";
  const cur = c ? c.currency : "KES";
  const price = quoteCheckPrice(QC, cur);
  return [
    ["What is SendFair Quote Check?", `It is a paid review of a builder's quote${where}. We read the quote, match each line to the same published local prices behind our house calculator, and show you where the quote sits. It is a comparison, not a valuation or a quantity survey.`],
    ["What do you check?", "Materials, trade days, the published permit fees, the quote's own arithmetic, and quantities where we have a planning take-off. Every matched line shows our typical unit price and the date we checked it."],
    ["What don't you check?", "Land, the contractor's fee or profit, architect's and engineer's fees, structural design, soil conditions, site preliminaries and anything not in our price data. Those lines are listed separately as not checked; we never invent a price for them."],
    ["How much does it cost?", `One-off fee: ${price.currency} ${Number(price.amount).toLocaleString("en")} for a ${cur} quote. Other currencies: ${quoteCheckPriceString()}. The free preview comes first; you pay only to unlock the line-by-line report. The exact charge currency is confirmed at checkout.`],
    ["When do I pay?", "After you upload. You see the number of line items, the quote total and how many lines we can match for free. The line-level verdicts unlock after payment."],
    ["What can I upload?", `A PDF, a JPG or PNG photo of a printed or handwritten quote, an XLSX spreadsheet or a CSV bill of quantities. Up to ${QC.limits.maxFiles} files, ${QC.limits.maxFileMb} MB each.`],
    ["How current are the prices?", `The house-build prices were checked ${buildCosts.updated} and are refreshed monthly. Every report shows the date on each matched price. Prices vary by site, supplier and season.`],
    ["What happens to my files?", `They are stored privately, never on a public URL, and deleted together with the extracted data ${QC.retentionDays} days after the report. Payment records are kept for accounting. The privacy policy on this site explains this in full.`],
    ["What if my quote is in a different currency?", "We compare in the country's price currency and convert the quote at the mid-market rate on the day. The report states the rate it used."],
    ["Is this a professional valuation?", "No. It is an estimate for comparison, not a professional valuation or quantity survey. Always confirm a price with your own supplier and ask your builder about anything flagged."]
  ];
}

function quoteCheckPage(countryId) {
  const c = countryId ? buildCosts.countries[countryId] : null;
  const name = c ? c.name : "";
  const terms = countryId && QUOTE_CHECK_LOCAL_TERMS[countryId] ? QUOTE_CHECK_LOCAL_TERMS[countryId] : "cement, blocks, roofing, sand, labour days and the permit";
  const faqs = quoteCheckFaqs(countryId);
  const rel = countryId ? `quote-check/${countryId}/` : "quote-check/";
  const prefix = countryId ? "../../" : "../";
  const price = quoteCheckPrice(QC, c ? c.currency : "KES");
  const title = countryId
    ? `Quote Check ${name}: is your builder's quote fair? · ${config.siteName}`
    : `Quote Check: is your builder's quote fair? · ${config.siteName}`;
  const description = countryId
    ? `Send a builder's quote in ${name} for a line-by-line check against today's local prices: ${terms}. Free preview, then a paid report.`
    : `Check a builder's quote line by line against today's local prices in 17 African countries. Free preview, then a fixed-fee report with a verdict, quantity checks and questions to ask.`;
  const trail = countryId
    ? [[config.siteName, ""], ["Quote Check", "quote-check/"], [name, rel]]
    : [[config.siteName, ""], ["Quote Check", rel]];
  const ld = [
    {
      "@context": "https://schema.org",
      "@type": "Service",
      name: `SendFair Quote Check${countryId ? " " + name : ""}`,
      serviceType: "Builder quote review",
      provider: { "@type": "Organization", name: config.siteName, url: site },
      areaServed: countryId ? name : Object.values(buildCosts.countries).map((x) => x.name),
      description: "A line-by-line comparison of a builder's quote with SendFair's published local construction prices.",
      offers: { "@type": "Offer", price: price.amount, priceCurrency: price.currency, availability: QC_ON ? "https://schema.org/InStock" : "https://schema.org/PreOrder" }
    },
    crumbs(trail),
    faqLd(faqs)
  ];
  const body = `${quoteCheckHero(countryId)}
${quoteCheckPanels(countryId)}
${quoteCheckSteps()}
<section class="qc-block" id="check"><div class="wrap">
<div class="qc-section-head"><h2>Upload the quote</h2><p>${countryId ? `Prices are the published ${esc(name)} figures behind our <a href="${link(prefix, `cost-to-build/${countryId}/`)}">${esc(name)} house calculator</a>.` : "Choose the country and we use that country's published prices. The report is a comparison, not a valuation."}</p></div>
${quoteCheckForm(prefix, countryId)}
</div></section>
${quoteCheckSample(countryId)}
<section class="qc-block alt"><div class="wrap">
<div class="qc-section-head"><h2>Questions</h2></div>
${faqBlock(faqs)}
<p class="qc-small">Quote Check is run by ${esc(config.legalName || config.siteName)} from Nairobi. It is an estimate for comparison, not a professional valuation or quantity survey. Read the <a href="${link(prefix, "privacy/")}">privacy policy</a> and the <a href="${link(prefix, "terms/")}">terms</a>.</p>
${countryId ? "" : `<h2>Quote Check by country</h2><ul class="route-links">${Object.keys(buildCosts.countries).map((id) => `<li><a href="${link(prefix, `quote-check/${id}/`)}">${esc(buildCosts.countries[id].name)}</a></li>`).join("")}</ul>`}
${countryId ? `<p><a class="btn" href="${link(prefix, `cost-to-build/${countryId}/`)}">Price the whole house in ${esc(name)}</a></p>` : ""}
</div></section>`;
  write(rel + "index.html", page({
    prefix, canonical: rel, noindex: !QC_ON, og: "home", extraCss: ["quote-check.css"], extraJs: "quote-check.js",
    title, description, jsonld: ld, body
  }));
  if (QC_ON) urls.push(rel);
}

// "Everything SendFair does": one short tile per service, grouped, right under the comparison.
function serviceGroups(prefix) {
  return [
    { title: "Send money", items: [
      { id: "compare", href: link(prefix, "") + "#corridors", name: "Compare transfers", text: "See which service delivers the most on your route, after fees and the rate markup." },
      { id: "rates", href: link(prefix, "rates/"), name: "Exchange rates today", text: "Every currency pair, with today's mid-market rate and the 7-day change." },
      { id: "index", href: link(prefix, "reports/"), name: "Remittance Cost Index", text: "What sending money home really costs, route by route, every month." }
    ] },
    { title: "Build a house", items: [
      { id: "calculator", href: link(prefix, "cost-to-build/"), name: "House cost calculator", text: `Price walls, roof, finishes, labour and the permit in ${Object.keys(buildCosts.countries).length} countries.` },
      { id: "quote-check", href: link(prefix, "quote-check/"), name: "Quote Check", tag: QC_ON ? "" : "Opens soon", text: "Is your builder's quote fair? We check it line by line against local prices." }
    ] },
    { title: "Stay updated", items: [
      { id: "alerts", href: link(prefix, "") + "#alerts", name: "Rate alerts", text: "One short message each morning with the best service for your route." },
      { id: "flying-home", href: link(prefix, "flying-home/"), name: "Flying home", text: "Flights, eSIMs and money tips for the trip back home." }
    ] }
  ];
}

function peopleAlsoAsk({ prefix, country = null, sender = null, topic = "send", limit = 4 }) {
  const live = questions.filter((q) => q.status === "live" && q.topic === topic);
  if (!live.length) return "";
  const list = relatedQuestions(live, { slug: "__people__", country, sender, topic }, limit);
  if (!list.length) return "";
  return `<h2>People also ask</h2><ul class="route-links">${list.map((q) => `<li><a href="${link(prefix, `questions/${q.slug}/`)}">${esc(q.question)}</a></li>`).join("")}</ul>`;
}

function servicesHub(prefix) {
  const groups = serviceGroups(prefix);
  return `<section class="block services-hub" aria-labelledby="services-hub-h"><div class="wrap">
<div class="section-head"><h2 id="services-hub-h">Everything SendFair does</h2><p class="lede">Free tools for sending money home and building back home. Pick one.</p></div>
<div class="svc-groups">${groups.map((g) => `<div class="svc-group"><h3>${esc(g.title)}</h3><ul class="svc-list">${g.items.map((it) => `<li><a class="svc-tile" href="${it.href}" data-svc="${it.id}"><span class="svc-name">${esc(it.name)}${it.tag ? ` <span class="svc-tag">${esc(it.tag)}</span>` : ""}</span><span class="svc-text">${esc(it.text)}</span></a></li>`).join("")}</ul></div>`).join("")}</div>
</div></section>`;
}

function quoteCheckCard(prefix, countryId) {
  if (!QC_ON) return "";
  const rel = countryId ? `quote-check/${countryId}/` : "quote-check/";
  const c = countryId ? buildCosts.countries[countryId] : null;
  const price = quoteCheckPrice(QC, c ? c.currency : "KES");
  return `<section class="block" id="quote-check-home"><div class="wrap">
<div class="section-head"><h2>Got a quote already? Check it.</h2><p class="lede">A builder's lump sum is hard to read. Send us the quote and we check it line by line against today's local prices${c ? ` in ${esc(c.name)}` : ""}: materials, trade days and the permit. Free preview, then a fixed-fee report.</p></div>
<div class="build-card" style="max-width:640px">
<span class="k">SendFair Quote Check${c ? " · " + esc(c.name) : ""}</span>
<strong>${price.currency} ${Number(price.amount).toLocaleString("en")} <span style="font:600 .8rem var(--font-body);color:var(--muted)">one-off, after a free preview</span></strong>
<span class="s">Line-by-line table, a verdict, quantity checks, questions to ask your builder, a private web report and a PDF by email. Land and the contractor's fee are not included.</span>
<p style="margin:10px 0 0"><a class="btn" href="${link(prefix, rel)}">Check my quote</a> <a class="btn btn-ghost" href="${link(prefix, rel)}#sample">See a sample</a></p>
</div>
</div></section>`;
}

function quoteCheckInlineCta(prefix, countryId) {
  if (!QC_ON) return "";
  const rel = countryId ? `quote-check/${countryId}/` : "quote-check/";
  return `<div class="build-card" style="margin:18px 0 0"><span class="k">Got a quote already?</span><strong>Check it line by line</strong><span class="s">SendFair Quote Check compares a builder's quote with the same local prices used here${countryId ? ` for ${esc(buildCosts.countries[countryId].name)}` : ""}. Free preview first.</span><p style="margin:8px 0 0"><a class="btn" href="${link(prefix, rel)}">Open Quote Check</a></p></div>`;
}

function buildTeaser(prefix) {
  const rates = midmarket.rates || {};
  const picks = ["nigeria", "ghana", "kenya"].filter((id) => buildCosts.countries[id]);
  const cards = picks.map((id) => {
    const est = BC.estimate(buildCosts, id, 110, 1, rates);
    if (!est) return "";
    return `<a class="build-card" href="${link(prefix, `cost-to-build/${id}/`)}"><span class="k">3-bedroom bungalow · ${esc(est.country.name)}</span><strong class="num">${esc(plain(R.money(est.total, est.currency)))}</strong><span class="s">Walls, roof, finishes, services, a septic tank and a boundary wall. Land and the contractor's fee are not included.</span></a>`;
  }).join("");
  return `<section class="block" id="build-home"><div class="wrap">
<div class="section-head"><h2>Build a house back home</h2><p class="lede">Building is one of the main reasons people send money — and a round sum is where quotes get inflated. Price the walls, roof, finishes, trade days and the building permit before you send a lump sum. Pick the country, then switch the roof sheet, windows, doors, tiles, ceiling and paint. Land and the contractor's fee are not in the figure. Prices checked ${esc(buildCosts.updated)}.</p></div>
<div class="build-tease">${cards}</div>
<p><a class="btn" href="${link(prefix, "cost-to-build/")}">Open the building calculator</a></p>
<ul class="route-links">${Object.keys(buildCosts.countries).map((id) => `<li><a href="${link(prefix, `cost-to-build/${id}/`)}">Cost to build in ${esc(buildCosts.countries[id].name)}</a></li>`).join("")}</ul>
</div></section>`;
}

function regionMonth() {
  return new Date(String(buildCosts.updated || "") + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
function regionPage({ cid, c, rel, house, city, factor }) {
  const rates = midmarket.rates || {};
  const area = house ? house.m2 : 110;
  const houseName = house ? `${house.id}-bedroom` : "3-bedroom";
  const cityName = city ? city.name : "";
  const monthYear = regionMonth();
  const eco = BC.regionalEstimate(buildCosts, cid, area, 1, rates, {}, { finish: "economy" }, factor);
  const std = BC.regionalEstimate(buildCosts, cid, area, 1, rates, {}, { finish: "standard" }, factor);
  const lux = BC.regionalEstimate(buildCosts, cid, area, 1, rates, {}, { finish: "luxury" }, factor);
  if (!std || !(std.total > 0)) return;
  const prefix = "../".repeat(rel.split("/").filter(Boolean).length);
  const where = city ? cityName + ", " + c.name : c.name;
  const pct = Math.round((factor - 1) * 100);
  const cityPara = city
    ? (Math.abs(pct) <= 1
      ? `${c.name}'s published prices in this receipt are quoted for ${c.city || cityName}, so ${cityName} uses them as they are: the same quantities and the same prices, checked ${buildCosts.updated}. Other towns are adjusted against these prices.`
      : `Building in ${cityName} costs about ${Math.abs(pct)}% ${pct > 0 ? "more" : "less"} than the national average we use for ${c.name}, on the same quantities. The factor multiplies materials and labour; the permit keeps its published fee. Checked ${city.checked || buildCosts.updated}.`)
    : `A ${houseName} house is about ${area} m² on one floor. The receipt uses the same quantities in every country, so the difference between countries is the price of bags, blocks, days and the permit.`;
  let lastGroup = null, rows = "";
  for (const l of std.lines) {
    if (l.group !== lastGroup) { rows += `<tr class="group"><th colspan="4">${esc(l.group)}</th></tr>`; lastGroup = l.group; }
    const rate = l.qty > 0 && l.cost > 0 ? l.cost / l.qty : null;
    rows += `<tr><th scope="row">${esc(l.label)}</th><td>${esc(l.qtyLabel || "")}</td><td class="num">${rate ? esc(plain(R.money(rate, c.currency, Math.abs(rate) >= 100 ? 0 : 2))) : "–"}</td><td class="num">${l.cost > 0 ? esc(plain(R.money(l.cost, c.currency))) : "–"}</td></tr>`;
  }
  const materials = std.lines.filter((l) => l.cost > 0 && l.qty > 0 && l.group !== "Labour" && l.group !== "Permits").map((l) => {
    const rate = l.cost / l.qty;
    return `<tr><th scope="row">${esc(l.label)}</th><td>${esc(l.unitName || "")}</td><td class="num">${esc(plain(R.money(rate, c.currency, Math.abs(rate) >= 100 ? 0 : 2)))}</td></tr>`;
  }).join("");
  const faqs = [
    [`What does a ${houseName} house cost to build in ${where}?`, `A ${houseName} bungalow of about ${area} m² comes to ${plain(R.money(std.total, c.currency))} in the standard finish, ${plain(R.money(eco.total, eco.currency))} in economy and ${plain(R.money(lux.total, lux.currency))} in luxury. Prices checked ${buildCosts.updated}. Land and the contractor's fee are not included.`],
    [`What is included in the ${where} receipt?`, `Cement, steel, blocks, sand, ballast, roof, windows, doors, tiles, ceiling, paint, fittings, wiring, plumbing, a water tank, a septic tank, a boundary wall, a gate, the published permit fee and the trade days. Each line shows its quantity and its source.`],
    [`Why do prices differ by city?`, `The national prices in this receipt are the published figures for ${c.city || c.name}. A city factor multiplies materials and labour where a local source says costs differ; the permit keeps its published fee.${city ? ` The ${cityName} factor is ${city.factor} (${pct >= 0 ? "+" : ""}${pct}%).` : ""}`]
  ];
  const trail = [[config.siteName, ""], ["Cost to build a house", "cost-to-build/"], [c.name, `cost-to-build/${cid}/`]];
  if (city) trail.push([cityName, `cost-to-build/${cid}/${rel.split("/")[2]}/`]);
  if (house) trail.push([`${houseName} house`, rel]);
  const h1 = house ? `Cost to build a ${houseName} house in ${where} (${monthYear})` : `Cost to build a house in ${where} (${monthYear})`;
  const title = house ? `Cost to build a ${houseName} house in ${where} · SendFair` : `Cost to build a house in ${where} · SendFair`;
  const description = `${house ? houseName + " house" : "House"} in ${where}: economy ${plain(R.money(eco.total, c.currency))}, standard ${plain(R.money(std.total, c.currency))}, luxury ${plain(R.money(lux.total, c.currency))}. Itemised receipt and material prices checked ${buildCosts.updated}.`;
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>${esc(h1)}</h1>
<p class="lede">${esc(cityPara)}</p>
<div class="facts">
  <div><span class="k">Economy</span><span class="v num">${esc(plain(R.money(eco.total, c.currency)))}</span></div>
  <div><span class="k">Standard</span><span class="v num">${esc(plain(R.money(std.total, c.currency)))}</span></div>
  <div><span class="k">Luxury</span><span class="v num">${esc(plain(R.money(lux.total, c.currency)))}</span></div>
  <div><span class="k">Prices checked</span><span class="v">${esc(buildCosts.updated)}</span></div>
</div>
${buildWidget(prefix, cid, "en", { factor, size: house ? house.id : "", city: city ? rel.split("/")[2] : "" })}
${sponsorBox(cid, prefix)}
<h2>The itemised receipt</h2>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">Item</th><th scope="col">Quantity</th><th scope="col" class="num">Rate</th><th scope="col" class="num">Amount</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<h2>Materials price list</h2>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">Material</th><th scope="col">Unit</th><th scope="col" class="num">Price</th></tr></thead>
<tbody>${materials}</tbody></table></div>
<h2>What is excluded</h2>
<ul class="tips">
<li>The plot of land.</li>
<li>The contractor's own fee. A published small-job allowance is shown under the receipt only when you tick it.</li>
<li>A 10% contingency, and the architect's or engineer's fee, only when ticked.</li>
<li>Appliances, a land survey, water beyond the tank, a power connection, a retaining wall on a steep plot, and borrowing costs.</li>
</ul>
<p class="note">Prices are the published figures checked ${esc(buildCosts.updated)}; confirm on the supplier's screen before you pay. The calculator above is pre-set to ${esc(where)}${house ? ` and a ${houseName} house` : ""}.</p>
<h2>Questions</h2>
${faqBlock(faqs)}
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, buildPage: true, rank: false, og: "home", title, description, jsonld: [faqLd(faqs), crumbs(trail), appLd(`House calculator for ${where}`, `${site}/${rel}`, `Estimate a simple house in ${where}.`)], body }));
  urls.push(rel);
}
function writeRegionPages() {
  const sizes = [2, 3, 4].map((n) => buildCosts.houses.find((h) => h.id === String(n))).filter(Boolean);
  for (const cid of Object.keys(buildCosts.countries)) {
    const c = buildCosts.countries[cid];
    for (const h of sizes) regionPage({ cid, c, rel: `cost-to-build/${cid}/${h.id}-bedroom/`, house: h, city: null, factor: 1 });
  }
  for (const cid of Object.keys(regionalFactors.countries || {})) {
    const c = buildCosts.countries[cid];
    if (!c) continue;
    for (const [slug, city] of Object.entries((regionalFactors.countries[cid] || {}).cities || {})) {
      if (!(city.factor > 0)) continue;
      regionPage({ cid, c, rel: `cost-to-build/${cid}/${slug}/`, house: null, city, factor: city.factor });
      for (const h of sizes) regionPage({ cid, c, rel: `cost-to-build/${cid}/${slug}/${h.id}-bedroom/`, house: h, city, factor: city.factor });
    }
  }
}
// /embed/: a free rate widget for diaspora blogs, associations and churches. The configurator builds an
// <iframe> to /embed/widget/ (rendered by the Worker) plus a plain "Powered by SendFair" link outside it.
function writeEmbedPage() {
  const rel = "embed/";
  const prefix = "../";
  const routes = [];
  for (const S of corridors.senders) for (const Rr of corridors.receivers) {
    const k = `${S.id}-${Rr.id}`;
    if ((quotes[k] || []).length) routes.push({ k, label: `${S.label} to ${Rr.name}`, cur: S.currency, def: (config.defaultAmounts || {})[S.currency] || 250 });
  }
  if (!routes.length) return;
  const first = routes.find((r) => r.k === "uk-nigeria") || routes[0];
  const faqs = [
    ["Is the widget free?", "Yes. Copy the code into any page that accepts HTML. Keep the Powered by SendFair line under the widget."],
    ["Does it track my visitors?", "No. The widget loads no third-party scripts, cookies or trackers. SendFair counts how many times the widget loads on each website, from the browser's referrer, so we know who uses it."],
    ["How fresh are the rates?", `The widget shows the same ranking as the route page: the three services that deliver the most money home after fees, with the time the prices were checked. It refreshes at least every ${15} minutes.`],
    ["Can I change the route later?", "Yes. Change route, amount or theme in the address inside the code, or make a new code here."]
  ];
  const opts = routes.map((r) => `<option value="${esc(r.k)}" data-def="${r.def}" data-cur="${esc(r.cur)}"${r.k === first.k ? " selected" : ""}>${esc(r.label)}</option>`).join("");
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, [[config.siteName, ""], ["Rate widget", rel]])}
<h1>Free money transfer rate widget for your website</h1>
<p class="lede">Show your readers which services send the most money home today. The widget lists the top three services for a route and amount, after fees, with the time the prices were checked and a link to compare every service. It is free for blogs, associations, churches and community sites.</p>
<div class="embed-config" id="sf-embed">
  <div class="build-controls">
    <label>Route <select id="em-route">${opts}</select></label>
    <label>Default amount <input id="em-amount" type="number" min="10" max="1000000" step="1" value="${first.def}" inputmode="numeric"></label>
    <label>Theme <select id="em-theme"><option value="light">Light</option><option value="dark">Dark</option></select></label>
    <label>Width (px) <input id="em-width" type="number" min="240" max="600" step="10" value="360" inputmode="numeric"></label>
  </div>
  <h2>Preview</h2>
  <div id="em-preview" style="max-width:360px"></div>
  <h2>Your code</h2>
  <p>Paste this where you want the widget to appear.</p>
  <textarea id="em-code" rows="7" readonly style="width:100%;font:13px/1.4 ui-monospace,Menlo,Consolas,monospace"></textarea>
  <p><button type="button" class="btn" id="em-copy">Copy the code</button> <span id="em-msg" aria-live="polite"></span></p>
</div>
<h2>Questions</h2>
${faqBlock(faqs)}
</div></div></section>
<script>(function(){
var site=${JSON.stringify(site)},H="hr"+"ef",$=function(i){return document.getElementById(i)};
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function clamp(v,a,b,d){v=Math.round(Number(v));return isFinite(v)&&v>=a&&v<=b?v:d}
function code(){
  var o=$("em-route").selectedOptions[0],route=o.value,label=o.textContent,parts=route.split("-");
  var amount=clamp($("em-amount").value,10,1000000,Number(o.getAttribute("data-def"))||250);
  var theme=$("em-theme").value==="dark"?"dark":"light",w=clamp($("em-width").value,240,600,360);
  var src=site+"/embed/widget/?route="+route+"&amount="+amount+"&theme="+theme;
  var page=site+"/send-money/"+parts[0]+"-to-"+parts[1]+"/";
  return {src:src,w:w,html:'<div class="sendfair-widget" style="max-width:'+w+'px">\\n<iframe src="'+esc(src)+'" title="'+esc("Money transfer rates, "+label)+'" width="'+w+'" height="300" loading="lazy" style="border:0;width:100%;max-width:'+w+'px;height:300px"></iframe>\\n<p style="margin:4px 0 0;font:12px/1.4 system-ui,sans-serif">Powered by <a '+H+'="'+esc(page)+'">SendFair</a>: compare money transfers to '+esc(label.split(" to ")[1]||"Africa")+'</p>\\n</div>'};
}
var t;function draw(){clearTimeout(t);t=setTimeout(function(){var c=code();$("em-code").value=c.html;var p=$("em-preview");p.style.maxWidth=c.w+"px";p.innerHTML=c.html;},200)}
$("em-route").addEventListener("change",function(){var o=this.selectedOptions[0];$("em-amount").value=o.getAttribute("data-def")||250;draw()});
["em-amount","em-theme","em-width"].forEach(function(i){$(i).addEventListener("input",draw);$(i).addEventListener("change",draw)});
$("em-copy").addEventListener("click",function(){var v=$("em-code").value;function ok(){$("em-msg").textContent="Copied."}
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(ok).catch(function(){$("em-code").select();document.execCommand("copy");ok()});else{$("em-code").select();document.execCommand("copy");ok()}});
draw();
})();</script>`;
  write(rel + "index.html", page({
    prefix, canonical: rel, rank: false, og: "home",
    title: `Free money transfer rate widget for your website · ${config.siteName}`,
    description: "Add a free widget that shows the three services sending the most money home today, after fees. For diaspora blogs, associations, churches and community sites. No trackers.",
    jsonld: [faqLd(faqs), crumbs([[config.siteName, ""], ["Rate widget", rel]])],
    body
  }));
  urls.push(rel);
}
function pct(v) { return (v * 100).toFixed(2) + "%"; }
function reportBarSvg(sorted) {
  const W = 880, H = 240, padL = 20, padB = 28;
  const step = (W - padL * 2) / sorted.length;
  const max = Math.max(...sorted.map((x) => x.avg)) || 1;
  const bars = sorted.map((x, i) => {
    const h = Math.max(2, (x.avg / max) * (H - padB - 20));
    return `<rect x="${(padL + i * step).toFixed(1)}" y="${(H - padB - h).toFixed(1)}" width="${Math.max(2, step - 1.5).toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${i === 0 ? "#0b6e4f" : i === sorted.length - 1 ? "#b0522a" : "#1b2470"}"><title>${esc(x.name)}: ${pct(x.avg)}</title></rect>`;
  }).join("");
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average best cost by corridor, ranked">${bars}<text x="${padL}" y="${H - 8}" font-size="11" fill="#5c6287">${esc(sorted[0].name)} (cheapest)</text><text x="${W - padL}" y="${H - 8}" text-anchor="end" font-size="11" fill="#5c6287">${esc(sorted[sorted.length - 1].name)} (dearest)</text></svg></figure>`;
}
function reportLineSvg(series) {
  const W = 880, H = 200, pad = 30;
  const vals = series.map((x) => x.index);
  const max = Math.max(...vals), min = Math.min(...vals);
  const y = (v) => H - pad - ((v - min) / Math.max(1e-9, max - min)) * (H - pad * 2);
  const x = (i) => pad + (i / Math.max(1, series.length - 1)) * (W - pad * 2);
  const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.index).toFixed(1)}`).join(" ");
  const dots = series.map((s, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(s.index).toFixed(1)}" r="3" fill="#f6b52b"><title>${esc(s.label)}: ${pct(s.index)}</title></circle>`).join("");
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Index over time"><polyline points="${pts}" fill="none" stroke="#1b2470" stroke-width="2.5"/>${dots}<text x="${pad}" y="${H - 8}" font-size="11" fill="#5c6287">${esc(series[0].label)}</text><text x="${W - pad}" y="${H - 8}" text-anchor="end" font-size="11" fill="#5c6287">${esc(series[series.length - 1].label)}</text></svg></figure>`;
}
function reportCsv(r) {
  const head = ["Route", "From", "To", "Typical amount", "Currency", "Days", "Average best cost %", "Best cost %", "MoM change (pp)", "Cheapest provider", "Times first", "In index"];
  const rows = r.all.map((x) => [x.name, x.from, x.to, x.amount, x.currency, x.days, (x.avg * 100).toFixed(2), (x.best * 100).toFixed(2), x.mom == null ? "" : (x.mom * 100).toFixed(2), x.cheapest ? x.cheapest.name : "", x.cheapest ? x.cheapest.count + "/" + x.days : "", x.thin ? "no (too few days)" : "yes"]);
  const cell = (c) => `"${String(c).replace(/"/g, '""')}"`;
  return "Source: SendFair (sendfair.africa) — CC BY 4.0\n" + [head, ...rows].map((row) => row.map(cell).join(",")).join("\n") + "\n";
}
function writeReports() {
  const currentMonth = process.env.SF_REPORT_MONTH || new Date(NOW).toISOString().slice(0, 7);
  const reports = buildReports({ history, config, quotes, corridors: { senders: corridors.senders, receivers: corridors.receivers }, providers, midmarket, currentMonth });
  const latest = reports[reports.length - 1];
  const series = reports.map((r) => ({ month: r.month, label: r.label, index: r.index }));
  const indexBody = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav("../", [[config.siteName, ""], ["Remittance Cost Index", "reports/"]])}
<h1>SendFair Remittance Cost Index</h1>
<p class="lede">A monthly, citable measure of what a typical transfer to Africa actually costs after the fee and the exchange-rate margin, built from the rates we check every day. Published under CC BY 4.0; please cite “Source: SendFair (sendfair.africa)”.</p>
${latest ? `<h2>Latest: ${esc(latest.label)}</h2><p>${esc(reportSummary(latest))}</p><p><a class="btn" href="${link("../", `reports/${latest.month}/`)}">Open the ${esc(latest.label)} report</a></p>` : "<p>No complete month of data yet. The first report appears on the 1st of the next month.</p>"}
<h2>All months</h2>
<ul class="route-links">${reports.slice().reverse().map((r) => `<li><a href="${link("../", `reports/${r.month}/`)}">${esc(r.label)} — ${pct(r.index)}</a></li>`).join("")}</ul>
${reports.length > 1 ? `<h2>The index over time</h2>${reportLineSvg(series)}` : ""}
<p class="note">The World Bank comparison uses ${esc(latest ? latest.wbLabel : "")}: <a href="https://remittanceprices.worldbank.org/" target="_blank" rel="noopener">remittanceprices.worldbank.org</a>.</p>
</div></div></section>`;
  write("reports/index.html", page({ prefix: "../", canonical: "reports/", rank: false, og: "home", title: `Remittance Cost Index · ${config.siteName}`, description: "A monthly measure of the cost of sending money to Africa, built from SendFair's checked rates. CC BY 4.0.", jsonld: [crumbs([[config.siteName, ""], ["Remittance Cost Index", "reports/"]])], body: indexBody }));
  urls.push("reports/");
  for (const r of reports) {
    const rel = `reports/${r.month}/`;
    const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav("../../", [[config.siteName, ""], ["Remittance Cost Index", "reports/"], [r.label, rel]])}
<h1>SendFair Remittance Cost Index: ${esc(r.label)}</h1>
<p class="lede">${esc(reportSummary(r))}</p>
<div class="facts">
  <div><span class="k">Corridors ranked</span><span class="v num">${r.sorted.length}</span></div>
  <div><span class="k">Average best cost</span><span class="v num">${pct(r.index)}</span></div>
  <div><span class="k">Cheapest</span><span class="v">${r.bestCorridor ? esc(r.bestCorridor.name) + " · " + pct(r.bestCorridor.avg) : "–"}</span></div>
  <div><span class="k">World Bank SSA</span><span class="v num">${pct(r.wbPct)}</span></div>
</div>
<h2>Cost by corridor</h2>
<p class="note">Ranked from cheapest to dearest. Each bar is a corridor's average of the best available total cost on the days we checked.</p>
${reportBarSvg(r.sorted)}
${reports.length > 1 ? `<h2>The index over time</h2>${reportLineSvg(series)}` : ""}
<h2>The 10 cheapest corridors</h2>
<ul class="route-links">${r.cheapest10.map((x) => `<li>${esc(x.name)} — ${pct(x.avg)}</li>`).join("")}</ul>
<h2>The 10 most expensive corridors</h2>
<ul class="route-links">${r.expensive10.map((x) => `<li>${esc(x.name)} — ${pct(x.avg)}</li>`).join("")}</ul>
<h2>Every corridor</h2>
<div class="table-wrap"><table class="rates-table"><thead><tr><th scope="col">Corridor</th><th scope="col" class="num">Avg best</th><th scope="col" class="num">Best day</th><th scope="col" class="num">MoM</th><th scope="col">Cheapest</th><th scope="col" class="num">First</th></tr></thead><tbody>${r.all.map((x) => `<tr><th scope="row">${esc(x.name)}${x.thin ? " *" : ""}</th><td class="num">${pct(x.avg)}</td><td class="num">${pct(x.best)}</td><td class="num">${x.mom == null ? "–" : (x.mom >= 0 ? "+" : "") + (x.mom * 100).toFixed(2)}</td><td>${x.cheapest ? esc(x.cheapest.name) : "–"}</td><td class="num">${x.cheapest ? x.cheapest.count + "/" + x.days : "–"}</td></tr>`).join("")}</tbody></table></div>
<p class="note">${r.all.length > r.sorted.length ? `* Checked on fewer than ${r.minDays} days, so left out of the index, the rankings and the chart. ` : ""}“Avg best” is the average, over the days we checked, of the best total cost for the route's typical amount. “First” counts the days the cheapest service was first or joint first. World Bank comparison: ${esc(r.wbLabel)} — <a href="https://remittanceprices.worldbank.org/" target="_blank" rel="noopener">remittanceprices.worldbank.org</a>. Days covered: ${esc(r.firstDay)} to ${esc(r.lastDay)}.${r.excludedDays ? ` ${r.excludedDays} corridor-day${r.excludedDays === 1 ? "" : "s"} where the best quote came out above our reference mid-market rate were left out: that points to a gap in the reference rate that day, not a real saving.` : ""}</p>
<h2>Download</h2>
<p><a class="btn" href="${link("../../", `reports/${r.month}.csv`)}">Download the table (CSV)</a> · CC BY 4.0 · Source: SendFair (sendfair.africa).</p>
</div></div></section>`;
    const jsonld = [
      { "@context": "https://schema.org", "@type": "Dataset", name: `SendFair Remittance Cost Index ${r.label}`, description: reportSummary(r), temporalCoverage: `${r.firstDay}/${r.lastDay}`, license: "https://creativecommons.org/licenses/by/4.0/", creator: { "@type": "Organization", name: config.siteName, url: site + "/" }, distribution: [{ "@type": "DataDownload", contentUrl: `${site}/reports/${r.month}.csv`, encodingFormat: "text/csv" }] },
      { "@context": "https://schema.org", "@type": "Article", headline: `SendFair Remittance Cost Index: ${r.label}`, datePublished: r.published, dateModified: r.published, author: { "@type": "Organization", name: config.siteName, url: site + "/" }, publisher: { "@type": "Organization", name: config.siteName, url: site + "/" }, mainEntityOfPage: `${site}/${rel}` },
      crumbs([[config.siteName, ""], ["Remittance Cost Index", "reports/"], [r.label, rel]])
    ];
    write(rel + "index.html", page({ prefix: "../../", canonical: rel, rank: false, og: "home", title: `Remittance Cost Index: ${r.label} · ${config.siteName}`, description: `Average and best transfer cost by corridor for ${r.label}, month-on-month change, the cheapest provider per corridor, and the World Bank comparison. CC BY 4.0.`, jsonld, body }));
    write(`reports/${r.month}.csv`, reportCsv(r));
    urls.push(rel);
  }
  return reports;
}
// ---------- French pages ----------
// The same data and ranking as the English pages; only the copy and the money format change.
const FR_RECEIVERS = new Set(["senegal", "ivorycoast", "mali", "cameroon", "drc", "rwanda", "morocco"]);
const frRouteRel = (s, r) => `fr/send-money/${s.id}-to-${r.id}/`;
const frHubRel = (r) => `fr/send-money-to/${r.id}/`;
const frRateRel = (s, r) => `fr/rates/${s.currency.toLowerCase()}-to-${r.currency.toLowerCase()}/`;
const rateFr = (v) => Number(v).toLocaleString("fr-FR", { maximumFractionDigits: 4 });
const frLd = (items) => items.filter(Boolean).map((x) => ({ ...x, inLanguage: "fr" }));
const frPayout = (key) => t("route." + ({ bank: "payoutBank", mobile: "payoutMobile", cash: "payoutCash" }[key] || "payoutBank"));
const frSender = (s) => t(`names.senders.${s.id}`) || s.label;
const frReceiver = (r) => t(`names.receivers.${r.id}`) || r.name;
// "Du Royaume-Uni vers le Sénégal", "De l'Europe vers le Mali": link and breadcrumb labels.
const frPair = (s, r) => capFirst(frGrammar(`de ${frSender(s)} vers ${frReceiver(r)}`));
const frPayoutText = (r, k, v) => t(`names.payout.${r.id}.${k}`) || v;

// French interactive comparer: re-ranks with rank.js (window.SFRank) and the same data files as app.js.
const FR_CMP_JS = "(function(){\nvar C=window.SF_FR_CMP,H=\"hr\"+\"ef\",R,S={},box=document.getElementById(\"sf-fr-cmp\"),inp=document.getElementById(\"sf-fr-amount\"),tb=document.getElementById(\"sf-fr-rows\"),forEl=document.getElementById(\"sf-fr-for\"),msg=document.getElementById(\"sf-fr-msg\"),loading=null,tm;\nif(!C||!box||!inp||!tb)return;\nfunction esc(s){return String(s==null?\"\":s).replace(/[&<>\"']/g,function(c){return{\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]})}\nfunction num(v,d){return Number(v).toLocaleString(\"fr-FR\",{minimumFractionDigits:d,maximumFractionDigits:d}).replace(/[\u202f\u00a0]/g,\" \")}\nfunction money(v,cur,d){if(d==null)d=Math.abs(v)>=1000?0:2;return num(v,d)+\" \"+(C.symbols[cur]||cur)}\nfunction rate(v){return Number(v).toLocaleString(\"fr-FR\",{maximumFractionDigits:4}).replace(/[\u202f\u00a0]/g,\" \")}\nfunction when(iso){var d=new Date(iso);return isNaN(d)?\"\":d.toLocaleDateString(\"fr-FR\",{day:\"numeric\",month:\"short\",hour:\"2-digit\",minute:\"2-digit\",timeZone:\"UTC\"})}\nfunction go(p){return C.track?C.root+\"go/\"+encodeURIComponent(p.id)+\"?r=\"+encodeURIComponent(C.route):String(p.affiliateUrl||p.website||\"\").replace(\"{route}\",C.route)}\nfunction get(p){return fetch(C.root+p,{cache:\"no-cache\"}).then(function(r){if(!r.ok)throw new Error(p);return r.json()})}\nfunction load(){\n  if(loading)return loading;\n  R=window.SFRank;\n  loading=Promise.all([get(\"data/quotes.json\"),get(\"data/wise-feed.json\").catch(function(){return{routes:{}}}),get(\"data/providers.json\"),get(\"data/midmarket.json\")]).then(function(a){\n    S.list=(a[0].quotes||{})[C.route]||[];S.feed=((a[1]||{}).routes||{})[C.route]||null;S.prov={};(a[2].providers||[]).forEach(function(p){S.prov[p.id]=p});S.mid=a[3];\n  });\n  return loading;\n}\nfunction render(amount){\n  var cfg=(window.SF&&SF.config)||{},p=C.route.split(\"-\");\n  var rows=R.rank({list:S.list,feed:S.feed,providers:S.prov,amount:amount,payout:\"all\",payIn:\"all\",promo:false,mid:R.midRate(S.mid,C.sc,C.rc),now:Date.now(),staleH:cfg.staleAfterHours||36,hideH:cfg.hideAfterHours||72,handLockH:cfg.preferAutoAfterHours||cfg.handLockHours||6,refAmount:(cfg.defaultAmounts||{})[C.sc]});\n  var top=null;for(var i=0;i<rows.length;i++)if(!rows[i].stale){top=rows[i];break}\n  tb.innerHTML=rows.map(function(x){return '<tr><th scope=\"row\">'+esc(x.p.name)+'</th><td class=\"num'+(x===top?\" top\":\"\")+'\">'+esc(money(x.gets,C.rc))+'</td><td>'+(x.ev.fee<0.005?esc(C.txt.sansFrais):esc(money(x.ev.fee,C.sc,2)))+'</td><td class=\"num\">'+esc(rate(x.ev.rate))+'</td><td>'+esc(x.stale?C.txt.notRechecked:when(x.q.checkedAt))+'</td><td><a class=\"go\" '+H+'=\"'+esc(go(x.p))+'\" target=\"_blank\" rel=\"sponsored nofollow noopener\" aria-label=\"'+esc(C.txt.goAria.replace(\"{name}\",x.p.name))+'\">'+esc(C.txt.goLabel)+'</a></td></tr>'}).join(\"\");\n  forEl.textContent=C.txt.tableFor.replace(\"{amount}\",money(amount,C.sc,amount%1?2:0));\n}\nfunction update(){\n  var v=parseFloat(String(inp.value).replace(\",\",\".\"));\n  if(!(v>=1&&v<=1000000)){msg.textContent=C.txt.invalid;return}\n  msg.textContent=C.txt.updating;\n  load().then(function(){render(v);msg.textContent=\"\";try{var u=new URL(location.href);if(v===C.amount)u.searchParams.delete(\"montant\");else u.searchParams.set(\"montant\",String(v));history.replaceState(null,\"\",u)}catch(e){}}).catch(function(){msg.textContent=\"\"});\n}\ninp.addEventListener(\"input\",function(){clearTimeout(tm);tm=setTimeout(update,300)});\nbox.addEventListener(\"click\",function(e){var b=e.target.closest(\"[data-amt]\");if(!b)return;inp.value=b.getAttribute(\"data-amt\");update()});\nfunction start(){var q=new URLSearchParams(location.search).get(\"montant\")||new URLSearchParams(location.search).get(\"amount\");if(q&&parseFloat(q)>0&&parseFloat(q)!==C.amount){inp.value=q;update()}}\nif(document.readyState===\"loading\")document.addEventListener(\"DOMContentLoaded\",start);else start();\n})();";
function frRoutePage(s, r, rel) {
  const prefix = "../".repeat(rel.split("/").filter(Boolean).length);
  const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]);
  const fresh = ctx.rows.filter((x) => !x.stale);
  const top = fresh[0] || null;
  const trail = [[config.siteName, ""], [`Envoyer vers ${frReceiver(r)}`, frHubRel(r)], [frPair(s, r), rel]];
  const faqs = [
    [t("route.faqBestQ", { to: frReceiver(r) }), top ? t("route.faqBestA", { date: dateFr(quotesFile.updatedAt), best: top.p.name, gets: moneyFr(top.gets, r.currency), amount: moneyFr(ctx.amount, s.currency, 0) }) : t("route.faqCostA", { to: frReceiver(r) })],
    [t("route.faqCostQ", { to: frReceiver(r) }), t("route.faqCostA", { to: frReceiver(r) })],
    [t("route.faqTimeQ", { to: frReceiver(r) }), t("route.faqTimeA", { to: frReceiver(r) })],
    [t("route.faqSafeQ", { to: frReceiver(r) }), t("route.faqSafeA", { to: frReceiver(r) })]
  ];
  const routeKey = `${s.id}-${r.id}`;
  const goHref = (p) => (config.trackClicks && !DEMO ? `${prefix}go/${encodeURIComponent(p.id)}?r=${encodeURIComponent(routeKey)}` : (p.affiliateUrl || p.website || "").replace("{route}", routeKey));
  const checkedFr = (x) => (x.stale ? t("route.notRechecked") : dateFr(x.q.checkedAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }));
  // Same markup as the French comparer script below renders in the browser.
  const rows = ctx.rows.map((x) => `<tr><th scope="row">${esc(x.p.name)}</th><td class="num${x === top ? " top" : ""}">${esc(moneyFr(x.gets, r.currency))}</td><td>${x.ev.fee < 0.005 ? t("route.sansFrais") : esc(moneyFr(x.ev.fee, s.currency, 2))}</td><td class="num">${esc(rateFr(x.ev.rate))}</td><td>${esc(checkedFr(x))}</td><td><a class="go" href="${esc(goHref(x.p))}" target="_blank" rel="sponsored nofollow noopener" aria-label="${esc(t("route.goAria", { name: x.p.name }))}">${t("route.goLabel")}</a></td></tr>`).join("");
  const quick = ((config.quickAmounts || {})[s.currency] || []);
  const frCmpConf = {
    route: routeKey, sc: s.currency, rc: r.currency, amount: ctx.amount, root: prefix, track: !!(config.trackClicks && !DEMO),
    symbols: FR.money, from: "depuis " + frSender(s),
    txt: { sansFrais: t("route.sansFrais"), notRechecked: t("route.notRechecked"), goLabel: t("route.goLabel"), goAria: t("route.goAria", { name: "{name}" }), tableFor: t("route.tableForLive", { amount: "{amount}", from: "depuis " + frSender(s) }), invalid: t("route.amountInvalid"), updating: t("route.updating") }
  };
  const payouts = Object.entries(r.payout || {}).map(([k, v]) => `<li><span>${esc(frPayout(k))}</span><span>${esc(frPayoutText(r, k, v))}</span></li>`).join("");
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>${esc(t("route.heading", { from: frSender(s), to: frReceiver(r) }))}</h1>
<p class="lede">${esc((fresh.length || ctx.rows.length) === 1 ? t("route.ledeOne", { currency: r.currency }) : t("route.lede", { n: fresh.length || ctx.rows.length, currency: r.currency }))}</p>
${ctx.rows.length ? `<form class="fr-cmp" id="sf-fr-cmp" onsubmit="return false" style="display:flex;flex-wrap:wrap;gap:8px 12px;align-items:end;margin:14px 0">
<label style="display:grid;gap:4px;font-weight:650">${t("route.amountLabel")} <span style="display:flex;align-items:center;gap:6px"><input id="sf-fr-amount" type="number" inputmode="decimal" min="1" max="1000000" step="any" value="${ctx.amount}" aria-describedby="sf-fr-hint" style="font:650 1.1rem inherit;min-height:44px;width:9em;padding:6px 10px;border-radius:12px;border:1.5px solid var(--line)"> <span>${esc(FR.money[s.currency] || s.currency)}</span></span></label>
<span class="chips" style="display:flex;flex-wrap:wrap;gap:6px">${quick.map((a) => `<button type="button" class="chip" data-amt="${a}">${esc(moneyFr(a, s.currency, 0))}</button>`).join("")}</span>
<small id="sf-fr-hint" style="flex-basis:100%;color:var(--muted)">${esc(t("route.amountHint", { sc: s.currency }))}</small>
</form>
<p><span id="sf-fr-for">${esc(t("route.tableForLive", { amount: moneyFr(ctx.amount, s.currency, 0), from: "depuis " + frSender(s) }))}</span> ${esc(t("common.ratesChecked", { date: dateFr(quotesFile.updatedAt) }))} <span id="sf-fr-msg" aria-live="polite"></span></p>` : ""}
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">${t("route.tableService")}</th><th scope="col" class="num">${t("route.tableGets")}</th><th scope="col">${t("route.tableFee")}</th><th scope="col" class="num">${t("route.tableRate")}</th><th scope="col">${t("route.tableChecked")}</th><th scope="col"><span class="sr-only">${t("route.tableGo")}</span></th></tr></thead>
<tbody id="sf-fr-rows">${rows}</tbody></table></div>
${ctx.rows.length ? `<script>window.SF_FR_CMP=${JSON.stringify(frCmpConf).replace(/</g, "\\u003c")};</script>
<script>${FR_CMP_JS}</script>` : ""}
<p class="note">${esc(t("route.staleNote"))}</p>
<h2>${esc(t("route.howToSend", { from: frSender(s), to: frReceiver(r) }))}</h2>
<ol class="howto">
<li><strong>${t("route.howTo1Title")}</strong> ${esc(t("route.howTo1Text", { currency: r.currency }))}</li>
<li><strong>${t("route.howTo2Title")}</strong> ${esc(t("route.howTo2Text"))}</li>
<li><strong>${t("route.howTo3Title")}</strong> ${esc(t("route.howTo3Text"))}</li>
<li><strong>${t("route.howTo4Title")}</strong> ${esc(t("route.howTo4Text"))}</li>
</ol>
<h2>${esc(t("route.receiveHeading", { to: frReceiver(r) }))}</h2>
<ul class="payout-list">${payouts}</ul>
<h2>${esc(t("route.tipsHeading"))}</h2>
<ul class="tips"><li>${esc(t("route.tip1"))}</li><li>${esc(t("route.tip2"))}</li><li>${esc(t("route.tip3"))}</li><li>${esc(t("route.tip4"))}</li></ul>
<h2>${esc(t("route.faqHeading", { to: frReceiver(r) }))}</h2>
${faqBlock(faqs)}
${config.whatsappNumber ? `<p class="wa"><a class="btn" href="https://wa.me/${esc(String(config.whatsappNumber).replace(/[^\d]/g, ""))}?text=${encodeURIComponent(`Bonjour SendFair, ${s.currency} vers ${r.name} ${ctx.amount}`)}" target="_blank" rel="noopener">Écrivez-nous sur WhatsApp</a></p>` : ""}
<h2>${esc(t("route.otherRoutes"))}</h2>
<ul class="route-links">${corridors.receivers.filter((x) => FR_RECEIVERS.has(x.id) && x.id !== r.id).map((x) => `<li><a href="${link(prefix, frRouteRel(s, x))}">${esc(frPair(s, x))}</a></li>`).join("")}${corridors.senders.filter((x) => x.id !== s.id).map((x) => `<li><a href="${link(prefix, frRouteRel(x, r))}">${esc(frPair(x, r))}</a></li>`).join("")}</ul>
<p><a class="btn" href="${link(prefix, frHubRel(r))}">${t("route.compareAll")}</a></p>
</div></div></section>`;
  write(rel + "index.html", page({
    prefix, canonical: rel, lang: "fr", og: "home",
    title: frGrammar(top ? t("route.titleBest", { from: frSender(s), to: frReceiver(r), sc: s.currency, rc: r.currency }) : t("route.titleCompare", { from: frSender(s), to: frReceiver(r) })),
    description: t("route.description", { from: frSender(s), to: frReceiver(r), date: dateFr(quotesFile.updatedAt) }),
    jsonld: frLd([faqLd(faqs), crumbs(trail), rankItemList(ctx)]),
    alternates: [{ lang: "en", href: `${site}/${corridorPath(s, r)}` }, { lang: "fr", href: `${site}/${rel}` }, { lang: "x-default", href: `${site}/${corridorPath(s, r)}` }],
    noindex: !top, body
  }));
  if (top) urls.push(rel);
}

function frHubPage(r) {
  const rel = frHubRel(r);
  const prefix = "../".repeat(rel.split("/").filter(Boolean).length);
  const lines = corridors.senders.map((s) => { const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]); return { s, ctx, top: ctx.rows.filter((x) => !x.stale)[0] || null }; });
  const trail = [[config.siteName, ""], [`Envoyer vers ${frReceiver(r)}`, rel]];
  const faqs = [
    [t("route.faqCostQ", { to: frReceiver(r) }), t("route.faqCostA", { to: frReceiver(r) })],
    [t("route.faqSafeQ", { to: frReceiver(r) }), t("route.faqSafeA", { to: frReceiver(r) })]
  ];
  const rows = lines.map((l) => `<tr><th scope="row"><a href="${link(prefix, frRouteRel(l.s, r))}">${esc(capFirst(frSender(l.s)))}</a></th><td class="num">${esc(moneyFr(l.ctx.amount, l.s.currency, 0))}</td><td>${l.top ? esc(l.top.p.name) : t("hub.beingChecked")}</td><td class="num top">${l.top ? esc(moneyFr(l.top.gets, r.currency)) : "—"}</td><td><a href="${link(prefix, frRouteRel(l.s, r))}">${t("hub.tableCompare")}</a></td></tr>`).join("");
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>${esc(t("hub.heading", { to: frReceiver(r) }))}</h1>
<p class="lede">${esc(t("hub.lede", { to: frReceiver(r) }))}</p>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">${t("hub.tableFrom")}</th><th scope="col" class="num">${t("hub.tablePay")}</th><th scope="col">${t("hub.tableBest")}</th><th scope="col" class="num">${t("hub.tableGets")}</th><th scope="col"></th></tr></thead>
<tbody>${rows}</tbody></table></div>
<h2>${esc(t("hub.receiveHeading", { to: frReceiver(r) }))}</h2>
<ul class="payout-list">${Object.entries(r.payout || {}).map(([k, v]) => `<li><span>${esc(frPayout(k))}</span><span>${esc(frPayoutText(r, k, v))}</span></li>`).join("")}</ul>
<h2>${esc(t("hub.faqHeading"))}</h2>
${faqBlock(faqs)}
<h2>${esc(t("hub.compareRoute"))}</h2>
<ul class="route-links">${corridors.senders.map((s) => `<li><a href="${link(prefix, frRouteRel(s, r))}">${esc(frPair(s, r))}</a></li>`).join("")}</ul>
</div></div></section>`;
  write(rel + "index.html", page({
    prefix, canonical: rel, lang: "fr", og: "home",
    title: t("hub.title", { to: frReceiver(r) }), description: t("hub.lede", { to: frReceiver(r) }),
    jsonld: frLd([faqLd(faqs), crumbs(trail)]),
    alternates: [{ lang: "en", href: `${site}/${hubPath(r)}` }, { lang: "fr", href: `${site}/${rel}` }, { lang: "x-default", href: `${site}/${hubPath(r)}` }],
    body
  }));
  urls.push(rel);
}

function frRatePage(s, r) {
  const rel = frRateRel(s, r);
  const prefix = "../".repeat(rel.split("/").filter(Boolean).length);
  const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]);
  if (!ctx.mid) return;
  const fresh = ctx.rows.filter((x) => !x.stale);
  const amts = [1, ...(STEP_AMOUNTS[s.currency] || [])];
  const bestAt = (a) => { let b = null; for (const x of fresh) { const ev = R.evaluate(x.q, a); if (ev && (!b || ev.gets > b.gets)) b = { gets: ev.gets, p: x.p }; } return b; };
  const trail = [[config.siteName, ""], [`${s.currency} vers ${r.currency}`, rel]];
  const faqs = [
    [`Quel est le taux ${s.currency} vers ${r.currency} aujourd'hui ?`, `Le taux du marché est 1 ${s.currency} = ${rateFr(ctx.mid)} ${r.currency} (${dateFr(quotesFile.updatedAt)}). Les services de transfert versent un peu moins après leur marge et leurs frais ; le tableau montre ce qui arrive avec le meilleur service vérifié.`],
    [t("rates.midVsHeading"), t("rates.midVsText", { rc: r.currency, to: frReceiver(r) })]
  ];
  const rows = amts.map((a) => { const b = bestAt(a); return `<tr><th scope="row">${esc(moneyFr(a, s.currency, a < 10 ? 2 : 0))}</th><td class="num">${esc(moneyFr(a * ctx.mid, r.currency))}</td><td class="num top">${b ? esc(moneyFr(b.gets, r.currency)) : t("common.noOnlinePrices")}</td><td>${b ? esc(b.p.name) : "—"}</td></tr>`; }).join("");
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>${esc(t("rates.heading", { sc: s.currency, rc: r.currency, rate: rateFr(ctx.mid) }))}</h1>
<p class="lede">${esc(t("rates.lede", { sc: s.currency, rc: r.currency, to: frReceiver(r), from: frSender(s), date: dateFr(quotesFile.updatedAt), hasData: "" }))}</p>
<div class="converter" id="sf-conv-fr" data-mid="${ctx.mid}" data-cur="${esc(r.currency)}">
  <label>${esc(t("rates.converterAmount", { sc: s.currency }))} <input type="number" inputmode="decimal" min="0" step="any" value="${config.defaultAmounts[s.currency]}" id="sf-conv-fr-in"></label>
  <div class="conv-out"><span class="k">${esc(t("rates.converterMid"))}</span><span class="v num" id="sf-conv-fr-mid">${esc(moneyFr(config.defaultAmounts[s.currency] * ctx.mid, r.currency))}</span></div>
  <a class="btn" href="${link(prefix, frHubRel(r))}">${esc(t("hub.heading", { to: frReceiver(r) }))}</a>
</div>
<h2>${esc(t("rates.arriveHeading", { to: frReceiver(r) }))}</h2>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">${t("rates.youSend")}</th><th scope="col" class="num">${t("rates.atMid")}</th><th scope="col" class="num">${t("rates.bestGives")}</th><th scope="col">${t("rates.service")}</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<p class="note">${esc(t("rates.tableNote", { from: frSender(s), amount: moneyFr(ctx.amount, s.currency, 0), sc: s.currency }))}</p>
<h2>${esc(t("rates.midVsHeading"))}</h2>
<p>${esc(t("rates.midVsText", { rc: r.currency, to: frReceiver(r) }))}</p>
<h2>${esc(t("rates.faqHeading"))}</h2>
${faqBlock(faqs)}
<h2>${esc(t("rates.sendHeading", { from: frSender(s), to: frReceiver(r) }))}</h2>
<p><a class="btn" href="${link(prefix, frRouteRel(s, r))}">${esc(t("rates.compareAll", { from: frSender(s), to: frReceiver(r) }))}</a></p>
</div></div></section>`;
  const histDays = Object.keys(history.days || {}).sort();
  const rateLd = { "@context": "https://schema.org", "@type": "ExchangeRateSpecification", inLanguage: "fr", currency: r.currency, currentExchangeRate: { "@type": "UnitPriceSpecification", price: +ctx.mid.toPrecision(6), priceCurrency: r.currency, validFrom: midmarket.updatedAt || quotesFile.updatedAt } };
  const dsLd = { "@context": "https://schema.org", "@type": "Dataset", inLanguage: "fr", name: `Historique du taux ${s.currency}/${r.currency}`, variableMeasured: `Taux du marché ${s.currency}/${r.currency}`, temporalCoverage: histDays.length ? `${histDays[0]}/${histDays[histDays.length - 1]}` : String(midmarket.updatedAt || "").slice(0, 10), creator: { "@type": "Organization", name: config.siteName, url: site + "/" }, license: "https://creativecommons.org/licenses/by/4.0/" };
  write(rel + "index.html", page({
    prefix, canonical: rel, lang: "fr", og: "home",
    title: t("rates.title", { sc: s.currency, rc: r.currency, rate: rateFr(ctx.mid) }),
    description: `Taux ${s.currency} vers ${r.currency} aujourd'hui : 1 ${s.currency} = ${rateFr(ctx.mid)} ${r.currency}. Convertisseur, montant reçu avec le meilleur service et historique.`,
    jsonld: frLd([faqLd(faqs), crumbs(trail), rateLd, dsLd]),
    alternates: [{ lang: "en", href: `${site}/${ratePath(s, r)}` }, { lang: "fr", href: `${site}/${rel}` }, { lang: "x-default", href: `${site}/${ratePath(s, r)}` }],
    noindex: !fresh.length, body
  }));
  if (fresh.length) urls.push(rel);
}

function writeFrenchPages() {
  for (const r of corridors.receivers.filter((x) => FR_RECEIVERS.has(x.id))) {
    for (const s of corridors.senders) frRoutePage(s, r, frRouteRel(s, r));
    frHubPage(r);
  }
  for (const { s, r } of ratePairs) {
    if (!FR_RECEIVERS.has(r.id)) continue;
    if (!["EUR", "CAD", "USD"].includes(s.currency)) continue;
    frRatePage(s, r);
  }
}
// ---- Partners: house-calculator sponsors, flights home, eSIMs (data/partners.json) ----
const TRACK_PARTNERS = !!config.trackClicks && !DEMO;
const sponsorHref = (prefix, sp, cid) => TRACK_PARTNERS ? `${prefix}go/${encodeURIComponent(sp.id)}?r=build-${cid}` : sp.url;
const flightHref = (prefix, r, o, d) => TRACK_PARTNERS
  ? `${prefix}go/flights?o=${o}&d=${d}&r=fly-${r.id}`
  : flightTarget(partners, { origin: o, dest: d, receiver: r.id, route: `fly-${r.id}` });
const esimHref = (prefix, r) => TRACK_PARTNERS ? `${prefix}go/esim?r=fly-${r.id}` : esimTarget(partners, { countryName: r.name, route: `fly-${r.id}` });
const flightsTracked = !!(partners.travel || {}).flightsWrap;
const esimTracked = !!(partners.travel || {}).esimWrap;
const relFor = (tracked) => tracked ? "sponsored nofollow noopener" : "nofollow noopener";
const hasFlyPage = (r) => ((partners.airports || {})[r.id] || []).length > 0;
const flyPath = (r) => `flying-home/${r.id}/`;

// Paid listing under the house calculator. Labelled, outside the receipt, and only between its dates.
function sponsorBox(cid, prefix, lang) {
  const c = buildCosts.countries[cid];
  if (!c) return "";
  const list = sponsorsFor(partners, cid, NOW).slice(0, 3);
  if (lang === "fr") {
    const nom = t(`names.receivers.${cid}`) || c.name;
    if (!list.length) return `<aside class="sponsor-box empty" aria-label="Publicité"><p><strong>Constructeurs, quincailleries, banques et coopératives :</strong> cet espace est vu par les familles de la diaspora qui chiffrent leur maison avant d'envoyer l'argent. <a href="${link(prefix, "advertise/")}">Annoncer ici</a></p></aside>`;
    return `<aside class="sponsor-box" aria-label="Sponsorisé">
<p class="sponsor-head"><span class="sponsor-tag">Sponsorisé</span> ${esc(capFirst(nom))}</p>
<div class="sponsor-cards">${list.map((sp) => `<a class="sponsor-card" href="${esc(sponsorHref(prefix, sp, cid))}" target="_blank" rel="sponsored noopener"><span class="k">${esc(sp.category)}${sp.badge ? ` · ${esc(sp.badge)}` : ""}</span><strong>${esc(sp.name)}</strong><span class="s">${esc(sp.blurb)}</span>${sp.phone ? `<span class="s">${esc(sp.phone)}</span>` : ""}</a>`).join("")}</div>
<p class="note">Annonces payantes. Elles ne font pas partie du devis et ne changent aucun prix de cette page. Vérifiez l'immatriculation d'un constructeur et demandez des références avant de payer. <a href="${link(prefix, "advertise/")}">Annoncer ici</a></p>
</aside>`;
  }
  if (!list.length) {
    return `<aside class="sponsor-box empty" aria-label="Advertising"><p><strong>Builders, hardware suppliers, SACCOs and banks in ${esc(c.name)}:</strong> this space is seen by families abroad who are pricing a house in ${esc(c.name)} before they send the money. <a href="${link(prefix, "advertise/")}">Advertise here</a></p></aside>`;
  }
  return `<aside class="sponsor-box" aria-label="Sponsored">
<p class="sponsor-head"><span class="sponsor-tag">Sponsored</span> Featured in ${esc(c.name)}</p>
<div class="sponsor-cards">${list.map((sp) => `<a class="sponsor-card" href="${esc(sponsorHref(prefix, sp, cid))}" target="_blank" rel="sponsored noopener"><span class="k">${esc(sp.category)}${sp.badge ? ` · ${esc(sp.badge)}` : ""}</span><strong>${esc(sp.name)}</strong><span class="s">${esc(sp.blurb)}</span>${sp.phone ? `<span class="s">${esc(sp.phone)}</span>` : ""}</a>`).join("")}</div>
<p class="note">Sponsored listings are paid for. They are not part of the receipt and do not change any price on this page. Check a builder's registration and ask for references and receipts before you pay anyone. <a href="${link(prefix, "advertise/")}">Advertise here</a></p>
</aside>`;
}

// Short pointer from transfer pages to the flying-home page for that country.
function flyNote(r, prefix) {
  if (!hasFlyPage(r)) return "";
  return `<p class="fly-note">Flying home to ${esc(r.name)}? <a href="${link(prefix, flyPath(r))}">Compare flights, get a travel eSIM and plan the money you'll need on arrival</a>.</p>`;
}

const FLY_TIPS = [
  "Search early for December. Fares for the weeks around Christmas and New Year usually climb as seats sell, so start comparing in September or October and set a price alert on the search page.",
  "Move your dates by a day or two. Midweek departures and returns in the first days of January are often cheaper than the weekend before Christmas; the date grid on the search page shows the difference.",
  "Count the stops, not just the price. A one-stop trip through a Gulf, Istanbul, Addis Ababa, Nairobi or European hub can be much cheaper than a direct flight, but check the layover length and whether the transit country needs a visa for you.",
  "Price the luggage before you book. Families flying home carry gifts, so compare the fare with the bags you will really check in. Extra bags booked online are usually cheaper than paying at the airport.",
  "Check your passport and entry rules on the official government site: many countries want at least six months left on your passport, and some need an e-visa or electronic travel authorisation before you fly."
];
const ARRIVE_TIPS = [
  "A travel eSIM gives you data the moment you land, before you can buy and register a local SIM. Your phone must support eSIM and be unlocked. Local SIM cards usually need registration with your passport at an official shop.",
  "Avoid swapping a big sum at an airport exchange counter. Sending money ahead to your family's mobile money wallet or bank account, at the rate on SendFair, usually leaves more in hand.",
  "If you're visiting a building site, take the itemised house receipt with you and compare it with the bags, blocks and days actually on site."
];

function writeFlyingHome() {
  const rs = corridors.receivers.filter(hasFlyPage);
  if (!rs.length) return;
  const senders = corridors.senders.filter((s) => ((partners.origins || {})[s.id] || []).length);
  const travelDisclosure = (flightsTracked || esimTracked)
    ? `Some flight and eSIM links are affiliate links: if you book, we may earn a commission at no extra cost to you. It never changes the advice on this page.`
    : `Flight and eSIM links open the search sites directly. SendFair earns nothing from them.`;
  for (const r of rs) {
    const rel = flyPath(r), prefix = "../../";
    const ports = partners.airports[r.id];
    const nets = networks(r);
    const portNames = joinList(ports.map(([code, name]) => `${name} (${code})`));
    const trail = [[config.siteName, ""], ["Flying home", "flying-home/"], [r.name, rel]];
    const faqs = [
      [`Which airports do people fly into in ${r.name}?`, `The main international airports are ${ports.map(([code, name]) => `${name} (${code})`).join(" and ")}. Use the search buttons on this page to compare flights from the UK, the US, Canada, Europe and Australia.`],
      [`When should I book flights home to ${r.name} for December?`, `Start comparing in September or October. Fares for the weeks around Christmas and New Year usually rise as seats sell, and moving your dates by a day or two can make a large difference.`],
      [`How do I get mobile data when I land in ${r.name}?`, `A travel eSIM works as soon as you land if your phone supports eSIM and is unlocked. A local SIM is usually cheaper for a long stay but needs registration with your passport at an official shop.`],
      [`What's the cheapest way to have money ready when I arrive in ${r.name}?`, `Send it ahead to a family member's ${nets.length ? `mobile money wallet (${joinList(nets)}) or ` : ""}bank account using the best rate on SendFair, rather than exchanging cash at the airport.`]
    ];
    const fromBlocks = senders.map((s) => {
      const origins = partners.origins[s.id];
      return `<h3>From ${esc(s.short)}</h3><ul class="route-links fly-links">${origins.flatMap(([o, oName]) => ports.map(([d, dName]) => `<li><a href="${esc(flightHref(prefix, r, o, d))}" target="_blank" rel="${relFor(flightsTracked)}">${esc(oName)} to ${esc(dName)}</a></li>`)).join("")}</ul>`;
    }).join("\n");
    const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>Flying home to ${esc(r.name)}</h1>
<p class="lede">Compare flights into ${esc(portNames)}, get mobile data for when you land, and send the money you'll need ahead of you at a fair rate. Planning for December? Read the booking tips first.</p>
<h2>Search flights to ${esc(r.name)}</h2>
<p>Pick your nearest city. Each button opens a flight search for that route, where you choose your dates and compare airlines.</p>
${fromBlocks}
<h2>Booking tips for the December rush</h2>
<ul class="tips">${FLY_TIPS.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<h2>When you land</h2>
<ul class="tips">${ARRIVE_TIPS.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<p><a class="btn" href="${esc(esimHref(prefix, r))}" target="_blank" rel="${relFor(esimTracked)}">Get a travel eSIM for ${esc(r.name)}</a></p>
<h2>Send money ahead to ${esc(r.name)}</h2>
<p>Compare what arrives${nets.length ? ` by ${esc(joinList(nets))}, bank or cash pickup` : ""} before you travel:</p>
<ul class="route-links">${corridors.senders.filter((s) => s.region !== "gulf").map((s) => `<li><a href="${link(prefix, corridorPath(s, r))}">${esc(s.label)} to ${esc(r.name)}</a></li>`).join("")}</ul>
${buildCosts.countries[r.id] ? `<p>Visiting a building site? <a href="${link(prefix, `cost-to-build/${r.id}/`)}">Open the ${esc(r.name)} house calculator</a> and take the itemised receipt with you.</p>` : ""}
<p class="note">${esc(travelDisclosure)} Fares and availability are set by the airlines and booking sites; check the final price before you pay.</p>
<h2>Questions</h2>
${faqBlock(faqs)}
<h2>Flying home to another country</h2>
<ul class="route-links">${rs.filter((x) => x.id !== r.id).map((x) => `<li><a href="${link(prefix, flyPath(x))}">${esc(x.name)}</a></li>`).join("")}</ul>
</div></div></section>`;
    write(rel + "index.html", page({ prefix, canonical: rel, rank: false, og: "home",
      title: fitTitle([`Flights home to ${r.name}: fares, eSIM and money`, `Flights home to ${r.name}`], 49) + ` · ${config.siteName}`,
      description: fitDescription([`Compare flights to ${portNames} from the UK, US, Canada, Europe and Australia.`, `December booking tips, a travel eSIM and the cheapest way to have money ready when you land.`]),
      jsonld: [faqLd(faqs), crumbs(trail)], body }));
    urls.push(rel);
  }
  const trail = [[config.siteName, ""], ["Flying home", "flying-home/"]];
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav("../", trail)}
<h1>Flying home</h1>
<p class="lede">Compare flights home to ${rs.length} African countries from the UK, the US, Canada, Europe and Australia, with booking tips for the December rush, a travel eSIM for when you land, and the cheapest way to have money waiting for you.</p>
<ul class="route-links big">${rs.map((r) => `<li><a href="${link("../", flyPath(r))}">${esc(r.name)}</a></li>`).join("")}</ul>
<h2>Booking tips for the December rush</h2>
<ul class="tips">${FLY_TIPS.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<p class="note">${esc(travelDisclosure)}</p>
</div></div></section>`;
  write("flying-home/index.html", page({ prefix: "../", canonical: "flying-home/", rank: false, og: "home",
    title: `Flying home to Africa: flights, eSIM and money · ${config.siteName}`,
    description: `Compare flights home to ${rs.length} African countries, with December booking tips, a travel eSIM and the cheapest way to have money ready when you land.`,
    jsonld: [crumbs(trail)], body }));
  urls.push("flying-home/");
}

function writeAdvertisePage() {
  const countries = Object.values(buildCosts.countries).map((c) => c.name);
  const trail = [[config.siteName, ""], ["Advertise", "advertise/"]];
  const body = `<section class="block page"><div class="wrap"><article class="prose">
${crumbNav("../", trail)}
<h1>Advertise on SendFair</h1>
<p class="lede">SendFair is used by Africans living in the UK, the US, Canada, Europe and Australia to compare money transfers home and to price a house before they send the money for it. If you build, supply materials, lend or sell property in ${esc(joinList(countries.slice(0, 3)))} or another of the ${countries.length} countries we cover, this is the moment they are deciding who to trust.</p>
<h2>Featured listing on the house calculator</h2>
<p>Your business appears under the house calculator for the country you choose: the country page, the 2-, 3- and 4-bedroom pages and the city pages. Up to three listings per country, so yours is never lost in a crowd. Each listing has your name, what you do, a short description, a phone number if you like, and a link to your site or WhatsApp.</p>
<p>It suits contractors and builders, hardware and materials suppliers, quantity surveyors and architects, SACCOs and banks with diaspora mortgages or building loans, land and title-search services, and real-estate developers.</p>
<h2>The rules</h2>
<ul class="tips">
<li>Every listing is labelled <strong>Sponsored</strong> and sits outside the receipt. Paying never changes a price, a quantity or the total.</li>
<li>Listings never appear inside the money-transfer rankings, which are sorted only by how much arrives.</li>
<li>We check that your business is registered${countries.includes("Kenya") ? " (for contractors in Kenya, your NCA registration)" : ""} and may decline a listing that our readers could be harmed by.</li>
<li>You get a monthly report of the clicks your listing received.</li>
</ul>
<h2>Founding sponsors</h2>
<p>We are taking our first sponsors now, at founding rates that stay fixed for as long as you renew. Email <span class="email">${esc(config.contactEmail)}</span> with your business name, registration number, the country and towns you serve, a description of up to 30 words, and the link you want people to open. We reply with the rate and a start date.</p>
<p class="note">See <a href="${link("../", "disclosure/")}">how we make money</a> for how sponsorship, referrals and advertising are kept apart from the rankings.</p>
</article></div></section>`;
  write("advertise/index.html", page({ prefix: "../", canonical: "advertise/", rank: false,
    title: `Advertise on SendFair: reach the diaspora building home`,
    description: `Featured listings for builders, suppliers, SACCOs and banks on SendFair's house calculator, seen by Africans abroad pricing a house in ${countries.length} countries.`,
    jsonld: [crumbs(trail)], body }));
  urls.push("advertise/");
}

function writeBuildPages() {
  const intro = `A receipt check for a simple house, including the finish, the plot works and the building permit: structure, block walls, roof, windows, doors, plaster, floor and wall tiles, a framed ceiling, paint, kitchen cupboards, wardrobes, wiring, plumbing, a basin, a shower, a kitchen sink, a septic tank, a boundary wall and a gate. The permit is that country's own published fee. On each line you can switch to another published type. Bungalow and maisonette are one floor and two floors of the same floor area. Standard finish is the listed price. Where a published whole-house band exists, it sits beside the receipt and includes a contractor. The plot of land and the contractor's fee are not in the receipt.`;
  const faqs = [
    ["What does this cost include?", "Cement, steel, ballast, sand, blocks, roof sheets or a concrete slab, upper-floor formwork where there is a suspended slab, roof timber, gutters, windows, doors, floor tiles, wall tiles in the wet rooms, ceiling boards and their metal frame, primer and two coats of paint, kitchen cupboards, a fitted wardrobe in each bedroom, wiring, plumbing, a WC, a basin, a shower, a kitchen sink, a water tank, a septic tank, a boundary wall, a gate, the building permit published for that country, and the mason, labourer, carpenter, painter, electrician and plumber days. Materials use the same quantities everywhere. The permit does not: each country keeps its own fee, and a country with no published tariff is left unpriced rather than copied from somewhere else. Where a published list has more than one type, the menu on that line switches the price."],
    ["Can I choose the type of roof, windows or tiles?", "Yes. Roof sheets, blocks, windows, doors, tiles, ceiling boards, paint and several other lines have a menu. The first choice is the figure this page was checked with. Other choices are named types, or the ends of a published price range. A guide tag means the figure was scaled from another country, or that a box or sheet was turned into a price per square metre. Economy and luxury move only the finish lines. A line you pick yourself stays as you picked it."],
    ["What is a bungalow and a maisonette here?", "A bungalow is one floor. A maisonette is two floors of the same total floor area, so the footprint and the roof are smaller and the upper slab and staircase are included. The two prices are not double."],
    ["What is left out?", "The plot of land and the contractor's own fee stay out of the receipt. Appliances stay out. A 10% contingency, a contractor margin where one is published, and the architect's or engineer's fee sit under the receipt and stay off until you include them. A permit with no published tariff is shown and not guessed. Where a published whole-house rate is shown, that band includes a builder and the receipt does not."],
    ["Why might a contractor still quote more?", "Their fee, haulage and a contingency sit on top of this list. Paste their lump sum and the page sets it against the receipt and, where we have one, the published band. If the gap is large, ask which line it pays for. A round sum with no bags, blocks or days is the usual way a quote gets inflated."],
    ["How current are the prices?", `The lists were checked on ${buildCosts.updated}. We refresh them monthly. A town away from the city on the page can pay more, especially for sand, ballast and haulage. The steep-or-far switch adds a planning allowance to sand and ballast only. It is not a soil test.`],
    ["Is this a structural design?", "No. The quantities are for a simple rectangular family house so you can budget and check receipts. A structural engineer sizes the steel for your soil and your drawing."]
  ];
  const bodyFor = (id, prefix) => `<section class="block page"><div class="wrap"><div class="prose wide">
<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="${link(prefix, "")}">SendFair</a></li><li><a href="${link(prefix, "cost-to-build/")}">Build a house</a></li>${id ? `<li aria-current="page">${esc(buildCosts.countries[id].name)}</li>` : `<li aria-current="page">Calculator</li>`}</ol></nav>
<h1>${id ? `Cost to build a house in ${esc(buildCosts.countries[id].name)}` : "House cost calculator"}</h1>
<p class="lede">${esc(intro)}</p>
${buildWidget(prefix, id || "kenya")}
${quoteCheckInlineCta(prefix, id)}
${id ? sponsorBox(id, prefix) : ""}
<p class="build-links"><a href="${link(prefix, "cost-to-build/material-prices/")}">Material prices</a> <a href="${link(prefix, "cost-to-build/same-house/")}">The same 3-bedroom bungalow in every country</a> <a href="${link(prefix, "cost-to-build/what-this-receipt-is/")}">What this receipt prices</a></p>
${id && ["senegal", "ivorycoast", "mali", "cameroon", "drc", "rwanda"].includes(id) ? `<p><a href="${link(prefix, `fr/cost-to-build/${id}/`)}">Lire cette page en français</a></p>` : ""}
${id ? `<h2>By size</h2><ul class="route-links">${[2, 3, 4].map((n) => `<li><a href="${link(prefix, `cost-to-build/${id}/${n}-bedroom/`)}">${n}-bedroom house</a></li>`).join("")}</ul>` : ""}
${id ? (() => { const rc = regionalFactors.countries[id]; const filled = rc ? Object.entries(rc.cities || {}).filter(([, city]) => city.factor > 0) : []; return filled.length ? `<h2>By city</h2><ul class="route-links">${filled.map(([slug, city]) => `<li><a href="${link(prefix, `cost-to-build/${id}/${slug}/`)}">${esc(city.name)}</a></li>`).join("")}</ul>` : ""; })() : ""}
${id ? peopleAlsoAsk({ prefix, country: id, topic: "build" }) : ""}
<h2>Other countries</h2>
<ul class="route-links">${Object.keys(buildCosts.countries).map((cid) => `<li><a href="${link(prefix, `cost-to-build/${cid}/`)}">${esc(buildCosts.countries[cid].name)}</a></li>`).join("")}</ul>
<h2>Questions</h2>
${faqBlock(faqs)}
</div></div></section>`;
  write("cost-to-build/index.html", page({
    prefix: "../", canonical: "cost-to-build/", buildPage: true, rank: false, og: "home",
    title: `House cost calculator · ${config.siteName}`,
    description: "Estimate a house in Nigeria, Kenya, Ghana and 14 other African countries. Switch roof sheets, windows, doors, tiles, ceiling and paint. No land or contractor's fee.",
    jsonld: [faqLd(faqs), crumbs([[config.siteName, ""], ["Cost to build a house", "cost-to-build/"]]), appLd("SendFair house calculator", `${site}/cost-to-build/`, "Estimate the materials, trade days, finish, plot works and permit for a simple house.")],
    body: bodyFor(null, "../")
  }));
  urls.push("cost-to-build/");
  for (const id of Object.keys(buildCosts.countries)) {
    const c = buildCosts.countries[id];
    const rel = `cost-to-build/${id}/`;
    const alts = ["senegal", "ivorycoast", "mali", "cameroon", "drc", "rwanda"].includes(id)
      ? [{ lang: "en", href: `${site}/${rel}` }, { lang: "fr", href: `${site}/fr/${rel}` }, { lang: "x-default", href: `${site}/${rel}` }]
      : [];
    write(rel + "index.html", page({
      prefix: "../../", canonical: rel, buildPage: true, rank: false, og: "home", alternates: alts,
      title: `Cost to build a house in ${c.name} · ${config.siteName}`,
      description: `What a house costs to build in ${c.name}, with a choice of roof sheets, windows, doors, tiles, ceiling and paint. No land or contractor's fee. Checked ${buildCosts.updated}.`,
      jsonld: [faqLd(faqs), crumbs([[config.siteName, ""], ["Cost to build a house", "cost-to-build/"], [c.name, rel]]), appLd(`House calculator for ${c.name}`, `${site}/${rel}`, `Estimate a simple house in ${c.name}, with that country's prices and permit fee.`)],
      body: bodyFor(id, "../../")
    }));
    urls.push(rel);
  }
  writeMaterialPrices();
  writeSameHouse();
  writeReceiptPage();
  writeFrenchHouses();
  writeRegionPages();
  quoteCheckPage(null);
  for (const id of Object.keys(buildCosts.countries)) quoteCheckPage(id);
}

function writeReceiptPage() {
  const en = "cost-to-build/what-this-receipt-is/";
  const fr = "fr/cost-to-build/what-this-receipt-is/";
  const alts = [
    { lang: "en", href: `${site}/${en}` },
    { lang: "fr", href: `${site}/${fr}` },
    { lang: "x-default", href: `${site}/${en}` }
  ];
  write(en + "index.html", page({
    prefix: "../../", canonical: en, buildPage: false, rank: false, og: "home", alternates: alts,
    title: `What this receipt prices · ${config.siteName}`,
    description: "The house receipt prices a block-and-sheet house built with site trades. Factory systems are a different product, and this page states no saving.",
    jsonld: [crumbs([[config.siteName, ""], ["Cost to build a house", "cost-to-build/"], ["What this receipt prices", en]])],
    body: `<section class="block page"><div class="wrap"><article class="prose wide">
<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="${link("../../", "")}">SendFair</a></li><li><a href="${link("../../", "cost-to-build/")}">Build a house</a></li><li aria-current="page">What this receipt prices</li></ol></nav>
<h1>What this receipt prices</h1>
<p class="lede">A simple house of block walls, a sheet roof or a concrete slab where that is the local roof, site-mixed concrete, and the trade days on the list. It is the list to match against deliveries.</p>
<p>These are different products. This receipt does not price them:</p>
<ul>
<li>Precast panels cast in a factory and lifted into place.</li>
<li>Light-gauge steel frames.</li>
<li>Volumetric modules, finished rooms delivered whole.</li>
<li>Buildings made from shipping containers.</li>
<li>Walls printed on site.</li>
</ul>
<p>A contractor who proposes one of those should price that system on its own drawing. Their lump sum and this receipt are not the same house. This page states no saving, because a difference depends on the drawing, the factory and the road to the plot.</p>
<p>The receipt also leaves out the plot of land, the contractor's fee, and the architect's or engineer's fee. <a href="${link("../../", "cost-to-build/")}">Open the calculator</a>.</p>
<p><a href="${link("../../", fr)}">Lire cette page en français</a></p>
</article></div></section>`
  }));
  urls.push(en);
  write(fr + "index.html", page({
    prefix: "../../../", canonical: fr, buildPage: false, rank: false, og: "home", lang: "fr", alternates: alts,
    title: `Ce que ce reçu chiffre · ${config.siteName}`,
    description: "Le reçu chiffre une maison en blocs et en tôles, bâtie avec les corps de métier sur le chantier. Un système d'usine est un autre produit. Cette page n'annonce aucune économie.",
    jsonld: [crumbs([[config.siteName, ""], ["Construire", "cost-to-build/"], ["Ce que ce reçu chiffre", fr]])],
    body: `<section class="block page"><div class="wrap"><article class="prose wide">
<nav class="crumbs" aria-label="Fil d'Ariane"><ol><li><a href="${link("../../../", "")}">SendFair</a></li><li><a href="${link("../../../", "cost-to-build/")}">Construire une maison</a></li><li aria-current="page">Ce que ce reçu chiffre</li></ol></nav>
<h1>Ce que ce reçu chiffre</h1>
<p class="lede">Une maison simple : murs en blocs, toiture en tôles ou dalle béton là où c'est la toiture locale, béton préparé sur place, et les jours de métier de la liste. C'est la liste à rapprocher des livraisons.</p>
<p>Ce sont d'autres produits. Ce reçu ne les chiffre pas :</p>
<ul>
<li>Des panneaux préfabriqués coulés en usine et posés à la grue.</li>
<li>Une ossature en acier léger.</li>
<li>Des modules volumétriques, des pièces finies livrées entières.</li>
<li>Un bâtiment fait de conteneurs.</li>
<li>Des murs imprimés sur le chantier.</li>
</ul>
<p>Un entrepreneur qui en propose un doit chiffrer ce système sur son propre plan. Sa somme et ce reçu ne décrivent pas la même maison. Cette page n'annonce aucune économie : l'écart dépend du plan, de l'usine et de la route jusqu'au terrain.</p>
<p>Le reçu laisse aussi de côté le terrain, la marge de l'entrepreneur, et les honoraires de l'architecte ou de l'ingénieur. <a href="${link("../../../", "cost-to-build/senegal/")}">Ouvrir le calculateur</a>.</p>
<p><a href="${link("../../../", en)}">Read this page in English</a></p>
</article></div></section>`
  }));
  urls.push(fr);
}

function writeFrenchHouses() {
  const ids = ["senegal", "ivorycoast", "mali", "cameroon", "drc", "rwanda"];
  const nameIn = { senegal: "au Sénégal", ivorycoast: "en Côte d'Ivoire", mali: "au Mali", cameroon: "au Cameroun", drc: "en RD Congo", rwanda: "au Rwanda" };
  const intro = "Un reçu pour une maison simple : structure, murs en blocs, toiture, fenêtres, portes, carrelage, plafond, peinture, cuisine, placards, électricité, plomberie, fosse septique, mur de clôture et portail. Le permis est le tarif publié dans le pays. Le terrain et la marge de l'entrepreneur ne sont pas dans le reçu. Le standard est le prix affiché. Économie et luxe ne changent que les finitions.";
  const faqs = [
    ["Que contient ce reçu ?", "Le ciment, l'acier, le sable, le gravier, les blocs, la toiture, les menuiseries, le carrelage, la peinture, la cuisine, les placards, les réseaux, une fosse, un mur de clôture, un portail, le permis publié et les jours de métier. Les quantités sont les mêmes partout. Le permis garde le tarif du pays."],
    ["Qu'est-ce qui reste dehors ?", "Le terrain, la marge de l'entrepreneur, les imprévus et les honoraires. Ils peuvent s'afficher sous le reçu sans le modifier. Une étude de sol, un bornage, l'eau au-delà du réservoir, l'électricité, un mur de soutènement, le mouvement des prix et les intérêts d'un prêt restent aussi dehors, sans chiffre."],
    ["Comment envoyer l'argent ?", "Chaque groupe du reçu a un lien vers la comparaison de transfert pour cette étape. La somme mensuelle sur douze mois est une répartition égale. Un chantier paie le gros œuvre d'abord."]
  ];
  for (const id of ids) {
    const c = buildCosts.countries[id];
    if (!c) continue;
    const rel = `fr/cost-to-build/${id}/`;
    const en = `cost-to-build/${id}/`;
    const alts = [{ lang: "fr", href: `${site}/${rel}` }, { lang: "en", href: `${site}/${en}` }, { lang: "x-default", href: `${site}/${en}` }];
    write(rel + "index.html", page({
      prefix: "../../../", canonical: rel, buildPage: true, rank: false, og: "home", lang: "fr", alternates: alts,
      title: `Coût pour construire une maison ${nameIn[id]} · ${config.siteName}`,
      description: `Reçu pour une maison simple ${nameIn[id]}, avec les quantités, le permis publié et le lien pour envoyer chaque étape. Sans le terrain ni la marge de l'entrepreneur.`,
      jsonld: [faqLd(faqs), crumbs([[config.siteName, ""], ["Construire", "cost-to-build/"], [c.name, rel]])],
      body: `<section class="block page"><div class="wrap"><div class="prose wide">
<nav class="crumbs" aria-label="Fil d'Ariane"><ol><li><a href="${link("../../../", "")}">SendFair</a></li><li><a href="${link("../../../", "cost-to-build/")}">Construire une maison</a></li><li aria-current="page">${esc(nameIn[id].replace(/^(au|en) /, ""))}</li></ol></nav>
<h1>Coût pour construire une maison ${esc(nameIn[id])}</h1>
<p class="lede">${esc(intro)}</p>
<p>La navigation du site est en anglais. Cette page et le reçu sont en français. <a href="${link("../../../", en)}">Read this page in English</a>.</p>
${buildWidget("../../../", id, "fr")}
${sponsorBox(id, "../../../", "fr")}
<p class="build-links"><a href="${link("../../../", "cost-to-build/material-prices/")}">Prix des matériaux</a> <a href="${link("../../../", "cost-to-build/same-house/")}">La même maison</a> <a href="${link("../../../", "fr/cost-to-build/what-this-receipt-is/")}">Ce que ce reçu chiffre</a></p>
<h2>Autres pays en français</h2>
<ul class="route-links">${ids.filter((x) => x !== id).map((x) => `<li><a href="${link("../../../", `fr/cost-to-build/${x}/`)}">${esc(nameIn[x])}</a></li>`).join("")}</ul>
<h2>Questions</h2>
${faqBlock(faqs)}
</div></div></section>`
    }));
    urls.push(rel);
  }
}

function moneyPlain(n, cur) {
  return esc(plain(R.money(n, cur)));
}

function writeMaterialPrices() {
  const rates = midmarket.rates || {};
  const materials = [
    ["cement", "Cement, 50kg", "per bag"],
    ["steel", "Steel", "per kg"],
    ["blocks", "Blocks", "each"],
    ["sand", "Sand", "per m³"],
    ["mason", "Mason", "per day"]
  ];
  const rows = Object.keys(buildCosts.countries).map((id) => {
    const c = buildCosts.countries[id];
    const cells = materials.map(([key, label]) => {
      const priced = BC.priceOf(buildCosts, id, key, rates);
      const choices = BC.choicesFor(buildCosts, id, key, rates);
      if (!priced) return `<tr><td>${esc(label)}</td><td>No price this month</td><td></td><td></td></tr>`;
      const distinct = choices.map((o) => o.price).filter((n, i, a) => a.indexOf(n) === i);
      const range = distinct.length > 1 ? `${moneyPlain(Math.min(...distinct), c.currency)} – ${moneyPlain(Math.max(...distinct), c.currency)}` : "One listed price";
      const lead = priced.quoted ? "Listed price. " : "";
      return `<tr><td>${esc(label)}</td><td class="num">${moneyPlain(priced.price, c.currency)}</td><td>${range}</td><td>${esc(lead + priced.source)}</td></tr>`;
    }).join("");
    return `<h2>${esc(c.name)}</h2><p>${esc(c.city)}. Checked ${esc(buildCosts.updated)}.</p><div class="table-wrap"><table class="rates-table price-sheet"><thead><tr><th>Material</th><th>Price in the receipt</th><th>Published range</th><th>Source</th></tr></thead><tbody>${cells}</tbody></table></div>`;
  }).join("");
  const rel = "cost-to-build/material-prices/";
  write(rel + "index.html", page({
    prefix: "../../", canonical: rel, buildPage: false, rank: false, og: "home",
    title: `Construction material prices · ${config.siteName}`,
    description: `Cement, steel, blocks, sand and a mason's day in each country SendFair prices, with the source and the date. Checked ${buildCosts.updated}.`,
    jsonld: [crumbs([[config.siteName, ""], ["Cost to build a house", "cost-to-build/"], ["Material prices", rel]])],
    body: `<section class="block page"><div class="wrap"><article class="prose wide">
<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="${link("../../", "")}">SendFair</a></li><li><a href="${link("../../", "cost-to-build/")}">Build a house</a></li><li aria-current="page">Material prices</li></ol></nav>
<h1>Material prices inside the house receipt</h1>
<p class="lede">Cement, steel, blocks, sand and a mason's day. The price is the one the house calculator uses. A range appears only when that line publishes more than one type. A guide was scaled from another country's figure, or read from a single list. Checked ${esc(buildCosts.updated)}.</p>
${rows}
<p><a href="${link("../../", "cost-to-build/")}">Open the house calculator</a> to see these prices turned into bags, bars and days.</p>
</article></div></section>`
  }));
  urls.push(rel);
}

function writeSameHouse() {
  const rates = midmarket.rates || {};
  const rows = Object.keys(buildCosts.countries).map((id) => {
    const est = BC.estimate(buildCosts, id, 110, 1, rates);
    if (!est) return "";
    const per = est.total / 110;
    const band = est.band ? `${moneyPlain(est.band.perLow, est.currency)} – ${moneyPlain(est.band.perHigh, est.currency)} a m², includes a contractor` : "No published band in this check";
    const why = est.country.why || "No separate published reason in this check. The receipt is materials, labour and the permit.";
    return `<tr><th scope="row"><a href="${link("../../", `cost-to-build/${id}/`)}">${esc(est.country.name)}</a></th><td>${esc(est.country.city)}</td><td class="num">${moneyPlain(est.total, est.currency)}</td><td class="num">${moneyPlain(per, est.currency)}</td><td>${band}</td><td>${esc(why)}</td></tr>`;
  }).join("");
  const rel = "cost-to-build/same-house/";
  write(rel + "index.html", page({
    prefix: "../../", canonical: rel, buildPage: false, rank: false, og: "home",
    title: `What the same 3-bedroom bungalow costs · ${config.siteName}`,
    description: "One 3-bedroom bungalow, 110 square metres, one floor, priced in every country SendFair covers. The receipt leaves out land and the contractor's fee.",
    jsonld: [crumbs([[config.siteName, ""], ["Cost to build a house", "cost-to-build/"], ["The same house", rel]])],
    body: `<section class="block page"><div class="wrap"><article class="prose wide">
<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="${link("../../", "")}">SendFair</a></li><li><a href="${link("../../", "cost-to-build/")}">Build a house</a></li><li aria-current="page">The same house</li></ol></nav>
<h1>The same 3-bedroom bungalow in every country</h1>
<p class="lede">110 m², one floor, standard finish, the same quantities. The receipt is materials, trade days, the finish, the plot works and that country's permit. Land and the contractor's fee are not in it. A published band, where we have one, is a whole-house rate and includes a contractor. Checked ${esc(buildCosts.updated)}.</p>
<p>Heirstone's 2026 note, <a href="https://www.heirstoneconsulting.com/pages/report-africa-construction-costs">Nine cities, one square metre</a>, finds a different expensive layer in each city. In Lagos it is the contractor's margin and the cost of a slow loan. In Nairobi and Dar es Salaam it is duty and VAT on imported cement. In Kinshasa it is haulage. In Casablanca the cost of borrowing is the low end of that set, about 5% of the hard cost on a two-year loan. Those notes explain the city. They are not added to the receipt.</p>
<div class="table-wrap"><table class="rates-table same-house"><caption>3-bedroom bungalow, 110 m², one floor</caption><thead><tr><th>Country</th><th>City on the price list</th><th class="num">Receipt</th><th class="num">Receipt a m²</th><th>Published band</th><th>Why the city costs what it does</th></tr></thead><tbody>${rows}</tbody></table></div>
<p>Compare a receipt with another receipt. A band is a different kind of number. <a href="${link("../../", "cost-to-build/")}">Open the calculator</a> to change the size, the finish or the floors.</p>
</article></div></section>`
  }));
  urls.push(rel);
}

function corridorGrid(prefix) {
  const col = (s) => {
    const amount = config.defaultAmounts[s.currency];
    const rows = corridors.receivers.map((r) => {
      const c = routeContext(s, r, prefix, amount);
      const top = c.rows.find((x) => !x.stale), lead = R.leaders(c.rows);
      return `<li><a href="${link(prefix, corridorPath(s, r))}"><span class="b-country">${esc(r.name)}</span>${top
        ? `<span class="b-amt num">${R.moneyHtml(top.gets, r.currency)}</span><span class="b-prov">${lead.length > 1 ? `${lead.length}-way tie: ${esc(lead.map((x) => x.p.name).join(", "))}` : `with ${esc(top.p.name)}`}</span>`
        : `<span class="b-amt b-wait">${c.anyQuotes ? "Being rechecked" : "Prices in apps only"}</span><span class="b-prov">${s.currency} to ${r.currency}</span>`}</a></li>`;
    }).join("");
    return `<div class="board-col"><h3>From ${esc(s.short)}</h3><p class="board-sub">Best result for <span class="num">${esc(R.money(amount, s.currency, 0))}</span></p><ul>${rows}</ul></div>`;
  };
  const groups = REGION_IDS.map((id) => ({ id, reg: (corridors.regions || {})[id] || {}, list: corridors.senders.filter((s) => (s.region || "west") === id) })).filter((g) => g.list.length);
  return `<section class="block" id="corridors"><div class="wrap">
<div class="section-head"><h2>Today's best on every route</h2><p class="lede">What arrives for a typical transfer, from the service that delivers the most. Open a route to compare every service and enter your own amount.</p></div>
${groups.map((g) => !g.list.some((s) => corridors.receivers.some((r) => (quotes[`${s.id}-${r.id}`] || []).length)) ? `<div class="board-group" id="from-${g.id}"><h3>${esc(g.reg.heading || "")}</h3>${g.reg.guide ? `<a href="${link(prefix, g.reg.guide)}">How exchange houses, apps, banks and wallets compare</a>` : ""}</div><p class="board-soon">Rates from ${esc(joinList(g.list.map((s) => s.short)))} are being added. Until then, <a href="${link(prefix, g.reg.guide || GULF_GUIDE)}">the guide</a> explains each way of sending and what a fair deal looks like.</p>` : `${groups.length > 1 ? `<div class="board-group" id="from-${g.id}"><h3>${esc(g.reg.heading || "")}</h3>${g.reg.guide ? `<a href="${link(prefix, g.reg.guide)}">Compare exchange houses, apps, banks and wallets</a>` : ""}</div>` : ""}<div class="board${g.list.length % 3 === 0 && g.list.length > 4 ? " board-3" : ""}">${g.list.map(col).join("")}</div>`).join("")}
</div></section>`;
}

function page({ prefix, title, description, canonical, body, jsonld, noindex, init, bodyOnly, og, ogType, buildPage, lang = "en", alternates = [], rank = true, extraCss = [], extraJs = "" }) {
  if (alternates.length && canonical) sitemapAlts[canonical] = alternates;
  const sf = {
    root: prefix, siteUrl: site, disclosureHref: link(prefix, "disclosure/"),
    routeUrl: link(prefix, "send-money/{from}-to-{to}/"),
    config: { quickAmounts: STEP_AMOUNTS, amountPages: AMOUNT_PAGES, defaultAmounts: config.defaultAmounts, staleAfterHours: staleH, hideAfterHours: hideH, preferAutoAfterHours: config.preferAutoAfterHours, handLockHours: config.handLockHours, regionalAverageCost: config.regionalAverageCost,
      trackClicks: !!config.trackClicks && !DEMO, reportsEnabled: !!config.reportsEnabled && !DEMO, demo: DEMO,
      ga4: config.ga4MeasurementId || "", gtm: config.gtmContainerId || "", clarity: config.clarityProjectId || "",
      impactSrc: config.impactSrc || "", adsenseClient: config.adsenseClient || "",
      // Travelpayouts Drive runs only on the flying-home pages, never near the transfer rankings.
      driveSrc: !DEMO && String(canonical || "").startsWith("flying-home/") ? (config.travelpayoutsDriveSrc || "") : "",
      translateLanguages: config.translateLanguages || "en,fr,ar,sw,pt,ha,yo,am,so",
      newsletter: config.newsletterFormAction || "" },
    ...(init || {})
  };
  const translate = `<script>(function(){var b=document.getElementById("sf-lang"),box=document.getElementById("sf-lang-box"),loaded=false;if(!b)return;
function load(){if(loaded)return;loaded=true;window.sfTranslateInit=function(){new google.translate.TranslateElement({pageLanguage:"${lang === "fr" ? "fr" : "en"}",autoDisplay:false},"google_translate_element");};var s=document.createElement("script");s.src="https://translate.google.com/translate_a/element.js?cb=sfTranslateInit";s.async=true;document.head.appendChild(s);}
b.addEventListener("click",function(){var open=box.hidden;box.hidden=!open;b.setAttribute("aria-expanded",String(open));if(open)load();});
var m=document.cookie.match(/googtrans=.en.([a-zA-Z-]+)/);if(m&&m[1]!=="en")load();})();</script>`;
  const scripts = translate + adBoot() + `<script>window.SF=${JSON.stringify(sf)};</script>` +
    (rank ? `<script src="${prefix}assets/rank.js?v=${V.rank}" defer></script>` : "") +
    `<script src="${prefix}assets/app.js?v=${V.app}" defer></script>` +
    (buildPage ? `<script src="${prefix}assets/build-cost.js?v=${V.build}" defer></script>` : "") +
    (extraJs ? `<script src="${prefix}assets/${extraJs}?v=${V[extraJs === "quote-check.js" ? "qcjs" : extraJs.replace(".js", "")] || ""}" defer></script>` : "") +
    (PREVIEW || DEMO ? "" : `<script>if("serviceWorker" in navigator&&location.protocol==="https:")addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})});addEventListener("beforeinstallprompt",function(e){e.preventDefault();var b=document.getElementById("sf-install");if(!b)return;b.hidden=false;b.onclick=function(){b.hidden=true;e.prompt();};});</script>`);
  const headStr = head({ title, description, canonical, prefix, jsonld, noindex, og, ogType, alternates, extraCss });
  const bodyStr = `<a class="skip" href="#content">${lang === "fr" ? "Aller au contenu" : "Skip to content"}</a>\n${header(prefix, lang, alternates)}\n<main id="content" tabindex="-1">${body}</main>\n${footer(prefix, lang)}\n${scripts}`;
  if (bodyOnly) return `${headStr}\n${bodyStr}`;
  return `<!doctype html>\n<html lang="${lang === "fr" ? "fr" : "en"}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${headStr}\n</head>\n<body>\n${bodyStr}\n</body>\n</html>\n`;
}

function write(rel, content) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f);
    const d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---------- asset versions ----------
// Each page asks for style.css?v=<hash> etc., so browsers fetch new files as soon as they change.
import crypto from "node:crypto";
const ver = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "src", f))).digest("hex").slice(0, 10);
const V = { css: ver("style.css"), app: ver("app.js"), rank: ver("rank.js"), fonts: ver("fonts.css"), build: ver("build-cost.js"), qccss: ver("quote-check.css"), qcjs: ver("quote-check.js"), qcreport: ver("quote-check-report.js") };
const sitemapAlts = {};

// ---------- SEO helpers ----------
const joinList = (a) => a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : a.join("");
const CURNAME = { GBP: "British pounds", USD: "US dollars", CAD: "Canadian dollars", AUD: "Australian dollars", AED: "UAE dirhams", SAR: "Saudi riyals", QAR: "Qatari riyals", KWD: "Kuwaiti dinars", BHD: "Bahraini dinars", OMR: "Omani rials", EUR: "euros", EGP: "Egyptian pounds", MAD: "Moroccan dirhams", XOF: "West African CFA francs", XAF: "Central African CFA francs", ETB: "Ethiopian birr", ZAR: "South African rand", TZS: "Tanzanian shillings", RWF: "Rwandan francs", KES: "Kenyan shillings", NGN: "Nigerian naira", GHS: "Ghanaian cedis", UGX: "Ugandan shillings", ZMW: "Zambian kwacha" };
const STEP_AMOUNTS = { GBP: [100, 250, 500, 1000], EUR: [100, 300, 500, 1000], USD: [100, 300, 500, 1000], CAD: [200, 400, 1000, 2000], AUD: [200, 450, 1000, 2000],
  AED: [500, 1000, 2000, 5000], SAR: [500, 1000, 2000, 5000], QAR: [500, 1000, 2000, 5000], KWD: [50, 100, 200, 500], BHD: [50, 100, 200, 500], OMR: [50, 100, 200, 500] };
// Amount-specific landing pages: /send-money/<route>/<amount>/. Only the five main sending currencies
// have a defined list; the values are the ones people search for.
const AMOUNT_PAGES = { GBP: [100, 200, 250, 500, 1000, 2000], USD: [100, 200, 300, 500, 1000, 2000], CAD: [100, 250, 500, 1000, 2000], AUD: [100, 250, 500, 1000, 2000], EUR: [100, 250, 500, 1000, 2000] };
const CUR_SYM = { GBP: "£", USD: "$", EUR: "€", CAD: "C$", AUD: "A$" };
const amountLabel = (a, cur) => (CUR_SYM[cur] || (cur + " ")) + a;
const amountPath = (s, r, a) => `${corridorPath(s, r)}${a}/`;
// Lower is faster. The feed's speed strings are "Minutes", "Same day", "1–2 days", "2 days", or blank.
const speedRank = (sp) => { const t = String(sp || "").toLowerCase(); if (/minute|instant|second|now/.test(t)) return 0; if (/same day|today|within 24|hour/.test(t)) return 1; if (/1.{0,3}2/.test(t)) return 2; if (/2.{0,3}3/.test(t)) return 3; if (/day/.test(t)) return 4; return 9; };
const REGION_IDS = ["west", "gulf"];
const GULF_GUIDE = ((corridors.regions || {}).gulf || {}).guide || "send-money-from-the-gulf/";
const gulfSenders = corridors.senders.filter((x) => x.region === "gulf");
const allSendersText = joinList(corridors.senders.filter((x) => x.region !== "gulf").map((x) => x.label)) + (gulfSenders.length ? " and the Gulf" : "");
const regulatorText = (list) => joinList([...new Set(list.map((x) => REGULATOR[x.id]).filter(Boolean))]);
const REGULATOR = { uk: "the FCA (UK)", us: "FinCEN (US)", canada: "FINTRAC (Canada)", australia: "AUSTRAC (Australia)", europe: "your country's financial regulator (for example ACPR in France, BaFin in Germany, Banca d'Italia or Banco de España)", uae: "the Central Bank of the UAE", saudi: "the Saudi Central Bank (SAMA)", qatar: "Qatar Central Bank", kuwait: "the Central Bank of Kuwait", bahrain: "the Central Bank of Bahrain", oman: "the Central Bank of Oman" };
const dateLong = new Date(quotesFile.updatedAt || NOW).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const hubPath = (r) => `send-money-to/${r.id}/`;
const provPath = (p) => `providers/${p.id}/`;
const networks = (r) => (r.payout.mobile || "").replace(/^Wallets such as /, "").split(/,| and /).map((x) => x.trim()).filter(Boolean);
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const providersWithQuotes = () => Object.values(providers).filter((p) => Object.values(quotes).some((list) => (list || []).some((q) => q.provider === p.id)));
const crumbs = (items) => ({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([name, rel], i) => ({ "@type": "ListItem", position: i + 1, name, item: `${site}/${rel}` })) });
const crumbNav = (prefix, items) => `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items.map(([name, rel], i) => i === items.length - 1 ? `<li aria-current="page">${esc(name)}</li>` : `<li><a href="${link(prefix, rel)}">${esc(name)}</a></li>`).join("")}</ol></nav>`;
const faqBlock = (faqs) => `<div class="faq">${faqs.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>`;
const faqLd = (faqs) => ({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });
const howToLd = (name, description, steps) => ({
  "@context": "https://schema.org", "@type": "HowTo", name, description,
  step: steps.map((s, i) => ({ "@type": "HowToStep", position: i + 1, name: s.name, text: s.text }))
});
const appLd = (name, url, description) => ({
  "@context": "https://schema.org", "@type": "SoftwareApplication", name, url, description,
  applicationCategory: "FinanceApplication", operatingSystem: "Web", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }
});
function adSlot(name, sticky) {
  const id = config.adsenseSlots && config.adsenseSlots[name];
  if (!config.adsenseClient || !id || DEMO) return "";
  return `<aside class="ad-slot${sticky ? " is-sticky" : ""}" aria-label="Advertisement"><span class="ad-label">Advertisement</span><ins class="adsbygoogle" style="display:block;min-height:${sticky ? "90px" : "250px"}" data-ad-client="${esc(config.adsenseClient)}" data-ad-slot="${esc(id)}" data-ad-format="auto" data-full-width-responsive="true"></ins></aside>`;
}
function insertContentAds(html) {
  let out = html;
  const top = adSlot("afterIntro");
  const mid = adSlot("midPage");
  const foot = adSlot("sticky", true);
  if (top) {
    const at = out.indexOf("</p>");
    out = at >= 0 ? out.slice(0, at + 4) + top + out.slice(at + 4) : out + top;
  }
  if (mid) {
    const first = out.indexOf("</h2>");
    const second = first >= 0 ? out.indexOf("</h2>", first + 5) : -1;
    out = second >= 0 ? out.slice(0, second + 5) + mid + out.slice(second + 5) : out + mid;
  }
  return out + foot + adManagerHtml();
}
function adManagerHtml() {
  const net = config.adManagerNetwork;
  const slot = config.adManagerSlot;
  if (!net || !slot || DEMO) return "";
  const id = "sf-gam";
  return `<aside class="ad-slot" aria-label="Advertisement"><span class="ad-label">Advertisement</span><div id="${id}"></div></aside>
<script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
<script>window.googletag=window.googletag||{cmd:[]};googletag.cmd.push(function(){googletag.defineSlot(${JSON.stringify("/" + String(net).replace(/^\//, "") + "/" + String(slot).replace(/^\//, ""))},[[300,250],[336,280],"fluid"],${JSON.stringify(id)}).addService(googletag.pubads());googletag.enableServices();googletag.display(${JSON.stringify(id)});});</script>`;
}
function adBoot() {
  if (!config.adsenseClient || DEMO) return "";
  return `<script>(function(){var done=false;function start(){if(done||!document.querySelector(".ad-slot ins"))return;done=true;document.querySelectorAll(".ad-slot ins").forEach(function(){(window.adsbygoogle=window.adsbygoogle||[]).push({})})}addEventListener("scroll",start,{once:true,passive:true});addEventListener("pointerdown",start,{once:true});addEventListener("load",function(){setTimeout(start,5000)});})();</script>`;
}

// Practical tips per receiving country, plus general ones for every route.
const TIPS = {
  kenya: ["M-Pesa limits: KES 250,000 per transaction and KES 500,000 per day, with a wallet balance cap of KES 500,000. For more, send to a bank account or split it over several days.", "Enter the recipient's number in +254 format and check the registered name the provider shows before you confirm."],
  nigeria: ["Most transfers go to a bank account: you need the 10-digit account number and the bank's name. The provider shows the account holder's name before you pay; check it matches.", "Wallets such as OPay and PalmPay have limits that depend on how fully the recipient's account is verified."],
  ghana: ["Mobile money wallets (MTN MoMo, Telecel Cash, AT Money) must be registered to the recipient; their verification level sets how much they can receive.", "Check the registered name the provider shows before you confirm."],
  uganda: ["MTN Mobile Money and Airtel Money wallets have daily and balance limits set by how fully the account is registered. For large amounts, send to a bank account.", "Enter the number in +256 format and check the registered name before you confirm."],
  zambia: ["MTN, Airtel and Zamtel wallets have limits that depend on registration level; banks suit larger amounts.", "Check the registered name the provider shows before you confirm."],
  egypt: ["Banks and wallets such as Vodafone Cash need the recipient's name exactly as on their national ID.", "Egypt has had official and parallel exchange rates; only use licensed services, which pay at the official rate."],
  morocco: ["Cash pickup at Wafacash, Cash Plus and the post office is very common; the recipient needs their national ID card (CIN).", "For bank deposits you need the 24-digit RIB account number."],
  senegal: ["Wave and Orange Money are the most used wallets; check the number is registered in the recipient's name.", "Money arrives in West African CFA francs, which are pegged to the euro, so the rate from Europe barely moves."],
  ivorycoast: ["Wave, Orange Money and MTN MoMo are the main wallets; wallet limits depend on how fully the account is registered.", "The CFA franc is pegged to the euro, so services compete on fees and margins rather than market moves."],
  mali: ["Orange Money is the most widespread wallet; cash pickup remains common outside Bamako.", "The CFA franc is pegged to the euro."],
  cameroon: ["MTN MoMo and Orange Money are the main wallets; enter the number in +237 format.", "Money arrives in Central African CFA francs, pegged to the euro."],
  ethiopia: ["Ethiopia moved to a market exchange rate in 2024; compare carefully, as rates can differ a lot between services.", "telebirr and bank accounts are the most common ways to receive."],
  southafrica: ["Most transfers go to bank accounts; some services also pay out at retailers like Shoprite.", "Large or repeated transfers may need the recipient to explain the source of funds to their bank."],
  tanzania: ["M-Pesa, Tigo Pesa and Airtel Money wallets have limits set by registration level; enter the number in +255 format.", "Check the registered name the provider shows before you confirm."],
  drc: ["Most services pay out in US dollars, by mobile money or cash pickup.", "For cash pickup, the name must match the recipient's ID exactly."],
  rwanda: ["MTN MoMo and Airtel Money are the main wallets; enter the number in +250 format.", "Check the registered name the provider shows before you confirm."],
  zimbabwe: ["Money arrives in US dollars, by cash pickup or mobile wallet such as EcoCash, depending on the service.", "For cash pickup, the name must match the recipient's ID exactly."]
};
const TIPS_ALL = [
  "Once mobile money or a bank deposit is paid out, it usually can't be reversed. Double-check the number or account first.",
  "Pay by bank transfer or debit card where you can. Card issuers can treat credit-card payments as cash advances, with extra fees and interest.",
  "Your first transfer may take longer while the provider checks your ID. Large amounts can need proof of where the money came from.",
  "Bank deposits sent at weekends or on public holidays may wait until the next working day; mobile money usually arrives any day.",
  "Never send money to someone you've only met online, or because someone urgently asks you to. Genuine providers never ask you to move money to 'protect' it."
];

// Tips that depend on where the money is sent from.
const TIPS_FROM = {
  west: ["Sending money to family is generally not taxed for the sender in the UK, US, Europe, Canada or Australia, though very large gifts can have reporting rules. Check with a tax adviser if unsure."],
  gulf: [
    "Gulf states do not tax money you send home, but VAT is added to the transfer fee in some: 5% in the UAE and Oman, 10% in Bahrain and 15% in Saudi Arabia. Fees shown here include it.",
    "Use only a service licensed by the country's central bank. Informal hawala agents are cheap until something goes wrong: there is no receipt, no refund and, in the UAE and elsewhere, operating unregistered is a crime.",
    "Gulf currencies are pegged to the US dollar, so day-to-day moves in your rate come from the African currency, not the dirham, riyal or dinar."
  ]
};
const tipsFor = (s, r) => [...(TIPS[r.id] || []), ...(TIPS_FROM[s.region || "west"] || []), ...TIPS_ALL];

// Daily history chart: mid-market rate (line) and the best rate a service gave (dots), server-drawn SVG.
function histSvg(ctx, days) {
  const all = ctx.hist.filter((h) => h.mid || h.best);
  const pts = days ? all.slice(-days) : all;
  const effective = (h) => (h.best && h.amount ? h.best / h.amount : null);
  if (!pts.length) return `<p class="note">No checks in the last ${days} days yet.</p>`;
  const vals = pts.flatMap((h) => [h.mid, effective(h)]).filter(Boolean);
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.15 || hi * 0.002;
  const fmtD = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  // Drawn twice: wide for laptops, narrow for phones, so labels stay readable at both sizes.
  const draw = (W, H, cls) => {
    const L = 8, Rr = 8, T = 14, B = 28;
    const x = (i) => L + (pts.length === 1 ? (W - L - Rr) / 2 : (i * (W - L - Rr)) / (pts.length - 1));
    const y = (v) => T + (H - T - B) * (1 - (v - (lo - pad)) / (hi - lo + 2 * pad));
    const line = pts.map((h, i) => (h.mid ? `${i && pts[i - 1].mid ? "L" : "M"}${x(i).toFixed(1)} ${y(h.mid).toFixed(1)}` : "")).join(" ");
    return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily ${ctx.s.currency} to ${ctx.r.currency} rates since ${fmtD(pts[0].d)}">
<line x1="${L}" x2="${W - Rr}" y1="${H - B}" y2="${H - B}" class="axis"/>
<path d="${line}" class="mid-line"/>${pts.map((h, i) => (h.mid ? `<circle cx="${x(i).toFixed(1)}" cy="${y(h.mid).toFixed(1)}" r="2.5" class="mid-dot"><title>${h.d}: mid-market ${R.rateStr(h.mid)}</title></circle>` : "")).join("")}
<g class="best-dot">${pts.map((h, i) => (effective(h) ? `<circle cx="${x(i).toFixed(1)}" cy="${y(effective(h)).toFixed(1)}" r="4"><title>${h.d}: best ${R.rateStr(effective(h))}</title></circle>` : "")).join("")}</g>
<text x="${L}" y="${H - 8}" class="lbl">${fmtD(pts[0].d)}</text><text x="${W - Rr}" y="${H - 8}" class="lbl" text-anchor="end">${fmtD(pts[pts.length - 1].d)}</text>
<text x="${W - Rr}" y="${T + 2}" class="lbl" text-anchor="end">${R.rateStr(hi)}</text><text x="${W - Rr}" y="${H - B - 4}" class="lbl" text-anchor="end">${R.rateStr(lo)}</text>
</svg>`;
  };
  return `<figure class="hchart">${draw(960, 210, "hc-wide")}${draw(380, 200, "hc-narrow")}
<figcaption><span class="key mid">Mid-market rate</span><span class="key best">Best rate a service gave, for ${esc(plain(R.money(ctx.amount, ctx.s.currency, 0)))}</span>${pts.length < 7 ? `<span class="key-note">History began ${fmtD(pts[0].d)}; one point is added after each daily check.</span>` : ""}</figcaption></figure>`;
}

function histChart(ctx) {
  const all = ctx.hist.filter((h) => h.mid || h.best);
  if (!all.length) return `<p class="note">History starts with the next rate check.</p>`;
  const windows = [7, 30, 90];
  const tabs = windows.map((d, i) => `<button type="button" class="hr-tab${i === 1 ? " is-on" : ""}" data-days="${d}">${d} days</button>`).join("");
  const panels = windows.map((d, i) => `<div class="hr-panel" data-days="${d}"${i === 1 ? "" : " hidden"}>${histSvg(ctx, d)}</div>`).join("");
  return `<div class="hist-range" data-hr>
<div class="hr-tabs" role="tablist" aria-label="Rate history range">${tabs}</div>
${panels}
</div>
<script>(function(){var r=document.querySelector('[data-hr]');if(!r)return;var t=r.querySelectorAll('.hr-tab'),p=r.querySelectorAll('.hr-panel');function s(d){for(var i=0;i<t.length;i++){t[i].classList.toggle('is-on',t[i].getAttribute('data-days')===d);p[i].hidden=p[i].getAttribute('data-days')!==d;}}for(var j=0;j<t.length;j++)t[j].addEventListener('click',function(){s(this.getAttribute('data-days'));});})();</script>`;
}

// Rate alert sign-up for one route.
function alertForm(ctx) {
  const top = ctx.rows.find((x) => !x.stale);
  const target = top ? Math.ceil((top.gets * 1.01) / (top.gets >= 1000 ? 100 : 1)) * (top.gets >= 1000 ? 100 : 1) : "";
  return `<form class="alert-form" id="sf-alert-route" data-route="${ctx.key}" novalidate>
<div class="af-row"><label>When <span class="af-cur">${ctx.s.currency}</span> <input name="amount" type="number" min="1" step="any" inputmode="decimal" value="${ctx.amount}" required aria-label="Amount you send"></label>
<label>delivers at least <span class="af-cur">${ctx.r.currency}</span> <input name="target" type="number" min="1" step="any" inputmode="decimal" value="${target}" required aria-label="Amount you want them to receive"></label></div>
<div class="af-row"><label class="af-email">email me at <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required></label><button type="submit" class="btn">Set alert</button></div>
${config.turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${esc(config.turnstileSiteKey)}"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}
<p class="note">We check once after each daily rate check and email you once when the best service reaches your target. One email to confirm, an unsubscribe link in every email, and nothing else. <a href="../../privacy/">Privacy</a></p>
<p class="af-msg" id="sf-alert-msg" role="status"></p></form>`;
}

// Head-to-head pairs and exchange-rate pairs (used by the home page, footer and their own pages).
const vsPath = (a, b) => `compare/${a.id}-vs-${b.id}/`;
const vsPairs = () => {
  const ps = providersWithQuotes(), out = [];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const shared = Object.keys(quotes).filter((k) => (quotes[k] || []).some((q) => q.provider === ps[i].id) && (quotes[k] || []).some((q) => q.provider === ps[j].id));
    if (shared.length) out.push([ps[i], ps[j]]);
  }
  return out;
};
const vsRoutePath = (a, b, s, r) => `compare/${a.id}-vs-${b.id}/${slug(s, r)}/`;
const vsList = vsPairs();
// The route's typical amount plus two other common amounts, for the "who wins by amount" table.
const cmpAmounts = (s) => { const base = config.defaultAmounts[s.currency]; return [base, ...(STEP_AMOUNTS[s.currency] || []).filter((a) => a !== base).slice(0, 2)]; };
const ratePairs = [];
for (const s of corridors.senders) for (const r of corridors.receivers) if (s.currency !== r.currency && !ratePairs.some((x) => x.s.currency === s.currency && x.r.currency === r.currency)) ratePairs.push({ s, r });
const ratePath = (s, r) => `rates/${s.currency.toLowerCase()}-to-${r.currency.toLowerCase()}/`;

// What a provider's quote delivers for several common amounts, best figure per column marked.
function amountsTable(ctx) {
  const amts = STEP_AMOUNTS[ctx.s.currency] || [ctx.amount];
  const rows = ctx.rows.filter((x) => !x.stale);
  if (!rows.length) return "";
  const vals = rows.map((x) => amts.map((a) => { const ev = R.evaluate(x.q, a); return ev ? ev.gets : 0; }));
  const best = amts.map((_, j) => Math.max(...vals.map((v) => v[j])));
  return `<div class="table-wrap"><table class="rates-table">
<caption>What arrives in ${esc(ctx.r.name)} for common amounts, ${esc(dateLong)}</caption>
<thead><tr><th scope="col">Service</th><th scope="col">Rate</th><th scope="col">Fee</th>${amts.map((a) => `<th scope="col" class="num">${esc(plain(R.money(a, ctx.s.currency, 0)))}</th>`).join("")}</tr></thead>
<tbody>${rows.map((x, i) => `<tr><th scope="row"><a href="${link("../../", provPath(x.p))}">${esc(x.p.name)}</a>${x.q.variant ? ` <span class="variant">${esc(x.q.variant)}</span>` : ""}</th><td class="num">${R.rateStr(x.ev.rate)}</td><td>${esc(R.feeStr(x.q, ctx.s.currency).replace(/^Fee /, ""))}</td>${vals[i].map((v, j) => `<td class="num${v === best[j] && v > 0 ? " top" : ""}">${v > 0 ? esc(plain(R.money(v, ctx.r.currency))) : "–"}</td>`).join("")}</tr>`).join("")}</tbody>
</table></div>
<p class="note">Rates and fees were checked for ${esc(plain(R.money(ctx.amount, ctx.s.currency, 0)))}. Some providers change their rate for much larger or smaller amounts, so confirm on their site. The highest figure in each column is in bold.</p>`;
}

// ---------- build ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
for (const f of ["style.css", "app.js", "rank.js", "fonts.css", "build-cost.js", "quote-check.css", "quote-check.js", "quote-check-report.js"]) fs.copyFileSync(path.join(ROOT, "src", f), path.join(OUT, "assets", f));
function minifyCss(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{}:;,])\s*/g, "$1").replace(/;}/g, "}").trim();
}
for (const f of ["style.css", "fonts.css", "quote-check.css"]) {
  const file = path.join(OUT, "assets", f);
  fs.writeFileSync(file, minifyCss(fs.readFileSync(file, "utf8")));
}
copyDir(path.join(ROOT, "src/fonts"), path.join(OUT, "assets/fonts"));
copyDir(path.join(ROOT, "src/og"), path.join(OUT, "og"));
copyDir(path.join(ROOT, "src/logos"), path.join(OUT, "logos"));
copyDir(path.join(ROOT, "src/icons"), OUT);
copyDir(path.join(ROOT, "src/social"), path.join(OUT, "social"));
write("data/corridors.json", JSON.stringify(corridors));
write("data/providers.json", JSON.stringify(providersFile));
write("data/quotes.json", JSON.stringify(quotesFile));
write("data/midmarket.json", JSON.stringify(midmarket));
write("data/build-costs.json", JSON.stringify(buildCosts));
write("data/partners.json", JSON.stringify(partners));
// Published city factors only (null = not published), for saved plans priced by the Worker.
write("data/regional-factors.json", JSON.stringify({ countries: Object.fromEntries(Object.entries(regionalFactors.countries || {}).map(([cid, rc]) => [cid, { cities: Object.fromEntries(Object.entries(rc.cities || {}).filter(([, c]) => c.factor > 0).map(([slug, c]) => [slug, { name: c.name, factor: c.factor }])) }])) }));
write("data/history.json", JSON.stringify(history));
const wiseFeed = path.join(ROOT, "data/wise-feed.json");
if (fs.existsSync(wiseFeed) && !DEMO) fs.copyFileSync(wiseFeed, path.join(OUT, "data/wise-feed.json"));
if (demoReports) write("data/reports-demo.json", JSON.stringify(demoReports));
write("data/site.json", JSON.stringify({ siteName: config.siteName, siteUrl: site, priorityRoutes: config.priorityRoutes || [], defaultAmounts: config.defaultAmounts, staleAfterHours: staleH, hideAfterHours: hideH, preferAutoAfterHours: config.preferAutoAfterHours, handLockHours: config.handLockHours, regionalAverageCost: config.regionalAverageCost, ga4MeasurementId: config.ga4MeasurementId || "", quoteCheckEnabled: QC_ON, quoteCheckAssets: { siteCss: V.css, qccss: V.qccss, app: V.app, report: V.qcreport, fonts: V.fonts } }));
write("data/quote-check/config.json", JSON.stringify({ ...QC, enabled: QC_ON }, null, 2));
write("data/quote-check/synonyms.json", JSON.stringify(QC_SYNONYMS, null, 2));
if (fs.existsSync(path.join(ROOT, "data/quote-check/fixtures"))) copyDir(path.join(ROOT, "data/quote-check/fixtures"), path.join(OUT, "data/quote-check/fixtures"));

const urls = [];
const S0 = corridors.senders.find((s) => s.id === "uk") || corridors.senders[0];
const R0 = corridors.receivers.find((r) => r.id === "kenya") || corridors.receivers[0];

// Home
const quotedRoutes = Object.keys(quotesFile.quotes || {}).filter((k) => (quotesFile.quotes[k] || []).length).length;
const quotedProviders = new Set(Object.values(quotesFile.quotes || {}).flat().map((q) => q.provider).filter((id) => providers[id])).size;
const homeProof = quotedProviders > 1
  ? `${quotedProviders} services on ${quotedRoutes} routes, updated through the day.`
  : "Commissions never change the order.";
const yourRoutesHtml = `<section class="block your-routes" id="sf-your-routes" hidden><div class="wrap"><h2>Your routes</h2><div id="sf-your-routes-list"></div><p class="savings" id="sf-savings" hidden></p></div></section>`;
const homeCtx = routeContext(S0, R0, "", config.defaultAmounts[S0.currency]);
const homeFaqs = [
  ["What does SendFair do?", "Two things. It compares money transfer services to Africa by the amount that arrives, after the fee and the exchange-rate markup. It also estimates what it costs to build a simple house in the country you send to, so a lump-sum quote can be checked against materials and trade days."],
  ["Does SendFair send the money or build the house?", "No. We do not send, hold or exchange money, and we do not build houses. The ranking sends you to the provider to complete the transfer. The house figure is a receipt check, not a contractor's quote."],
  ["How much does it cost to build a house back home?", "Open the house calculator, pick the country and the size, then choose the type of roof sheet, windows, doors, tiles, ceiling and paint. Land and the contractor's fee are not included, and every line shows its quantity and its source."],
  ["Do commissions change which service ranks first?", "No. The transfer ranking is sorted only by how much your family receives."]
];
write("index.html", page({
  prefix: "", canonical: "", bodyOnly: PREVIEW, og: "home",
  title: PREVIEW ? config.siteName : `Compare transfers to Africa and house-build costs | ${config.siteName}`,
  description: `Compare money transfers to ${corridors.receivers.length} African countries by what arrives, price a house back home, and get a free morning rate alert. Independent, from Nairobi.`,
  jsonld: [{ "@context": "https://schema.org", "@type": "WebSite", name: config.siteName, url: site + "/", description: "Free tools for the African diaspora: compare money transfers to Africa by what arrives, estimate the cost to build a house back home, check a builder's quote, get daily rate alerts and plan the trip home." },
    { "@context": "https://schema.org", "@type": "Organization", name: config.siteName, url: site + "/", logo: `${site}/icon-512.png`, email: config.contactEmail,
      ...(socialProfiles.length ? { sameAs: socialProfiles.map((s) => s.url) } : {}),
      ...(config.legalName || config.businessName ? { legalName: config.legalName || config.businessName } : {}), ...(config.founderName ? { founder: { "@type": "Person", name: config.founderName } } : {}), areaServed: [...corridors.senders, ...corridors.receivers].map((x) => x.iso2) },
    faqLd(homeFaqs),
    appLd("SendFair transfer and house-build comparison", site + "/", "Compare money transfers to Africa by the amount that arrives, and estimate the cost to build a house back home."),
    howToLd("How the SendFair ranking works", "How a transfer is checked, calculated and ranked.", [
      { name: "We check each provider", text: "We record the rate and fee each service quotes on every route, how the money can be received, and when we checked." },
      { name: "We do the maths for your amount", text: "Fees come off what you pay and the rest converts at the provider's rate. That gives the amount that actually arrives." },
      { name: "Most money home ranks first", text: "Commissions never change the order. A service that pays us nothing can rank first." }
    ])],
  body: yourRoutesHtml + tool({
    ctx: homeCtx,
    heading: "Send money home. Build a house back home.",
    sub: `Free tools for the diaspora: compare money transfers to Africa by what your family actually receives, price a house back home, check a builder's quote${QC_ON ? "," : " (opening soon)"} and get a morning rate alert for your route. ${homeProof}`
  }) + servicesHub("") + buildTeaser("") + quoteCheckCard("", null) + guideTeaser("") + corridorGrid("") + `
<section class="block steps-block"><div class="wrap">
<div class="section-head"><h2>How the ranking works</h2></div>
<ol class="steps">
<li><h3>We check each provider</h3><p>We record the rate and fee each service quotes on every route, how the money can be received, and when we checked.</p></li>
<li><h3>We do the maths for your amount</h3><p>Fees come off what you pay and the rest converts at the provider's rate. That gives the amount that actually arrives.</p></li>
<li><h3>Most money home ranks first</h3><p>Commissions never change the order. A service that pays us nothing can rank first.</p></li>
</ol></div></section>
<section class="block"><div class="wrap"><div class="section-head"><h2>Send money to</h2></div>
<ul class="route-links big">${corridors.receivers.map((r) => `<li><a href="${link("", hubPath(r))}">${esc(r.name)}</a></li>`).join("")}</ul>
<div class="section-head" style="margin-top:32px"><h2>Compare by route</h2></div>
${corridors.senders.map((s) => { const rs = corridors.receivers.filter((r) => routeContext(s, r, "", config.defaultAmounts[s.currency]).rows.some((x) => !x.stale)); return rs.length ? `<h3 class="route-from">From ${esc(s.short)}</h3><ul class="route-links">${rs.map((r) => `<li><a href="${link("", corridorPath(s, r))}">${esc(s.label)} to ${esc(r.name)}</a></li>`).join("")}</ul>` : ""; }).join("")}
<div class="section-head" style="margin-top:32px"><h2>Services we compare</h2></div>
<ul class="route-links big">${providersWithQuotes().map((p) => `<li><a class="with-badge" href="${link("", provPath(p))}">${R.badge(p)}${esc(p.name)} review</a></li>`).join("")}</ul>
<div class="section-head" style="margin-top:32px"><h2>Head to head</h2></div>
<ul class="route-links">${vsPairs().map(([a, b]) => `<li><a href="${link("", vsPath(a, b))}">${esc(a.name)} vs ${esc(b.name)}</a></li>`).join("")}</ul>
<div class="section-head" style="margin-top:32px" id="rates-today"><h2>Exchange rates today</h2></div>
<ul class="route-links">${ratePairs.map(({ s, r }) => `<li><a href="${link("", ratePath(s, r))}">${s.currency} to ${r.currency}</a></li>`).join("")}</ul>
<p><a class="btn btn-ghost" href="${link("", "rates/")}">All exchange rates</a></p>
<div class="section-head" style="margin-top:32px"><h2>Questions</h2></div>
${faqBlock(homeFaqs)}
</div></section>` + alerts()
}));
urls.push("");

// Route pages
for (const s of corridors.senders) {
  for (const r of corridors.receivers) {
    const rel = corridorPath(s, r), prefix = "../../";
    const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]);
    const fresh = ctx.rows.filter((x) => !x.stale);
    const top = fresh[0], last = fresh[fresh.length - 1], lead = R.leaders(ctx.rows);
    const who = lead.length > 1 ? `${R.names(lead)} tie for the most` : top ? `${top.p.name} delivers the most` : "";
    const names = [...new Set(ctx.rows.map((x) => x.p.name))];
    const nets = networks(r);
    const rCur = CURNAME[r.currency] || r.currency, sCur = CURNAME[s.currency] || s.currency;
    const amt = plain(R.money(ctx.amount, s.currency, 0));
    const title = cap(routeTitle(s, r, top));
    const description = top ? fitDescription([
      `${who} today: ${plain(R.money(top.gets, r.currency))} for ${amt}. Compare ${joinList(names.slice(0, 4))} by what arrives in ${r.name}${nets.length ? ` via ${joinList(nets.slice(0, 2))}, bank or cash pickup` : ""}.`,
      `${who} today: ${plain(R.money(top.gets, r.currency))} for ${amt}. Compare ${joinList(names.slice(0, 3))} by what arrives in ${r.name}${nets.length ? ` via ${nets[0]}, bank or cash` : ""}.`,
      `${who} today: ${plain(R.money(top.gets, r.currency))} for ${amt}. Compare ${joinList(names.slice(0, 3))} by what arrives in ${r.name}.`,
      `${who} today: ${plain(R.money(top.gets, r.currency))} for ${amt}. Compare ${names.length} services by what arrives in ${r.name}.`
    ]) : `Compare money transfer services from ${s.short} to ${r.name} by what actually arrives in ${rCur}, after fees and the exchange-rate markup.`;
    const lede = `Compare ${names.length > 1 ? names.length + " services" : "transfer services"} by how many ${esc(rCur)} arrive${nets.length ? ` by ${esc(joinList(nets))}, bank or cash pickup` : ""}. ${top ? `Rates checked ${esc(dateLong)}.` : "No service publishes online prices for this route yet."}`;
    const mobileProv = [...new Set(fresh.filter((x) => (x.q.payout || []).includes("mobile")).map((x) => x.p.name))];
    const midTxt = ctx.mid && s.currency !== r.currency ? `1 ${s.currency} = ${R.rateStr(ctx.mid)} ${r.currency}` : "";
    const summary = top ? `<p>On ${esc(dateLong)}, ${lead.length > 1 ? `<strong>${esc(R.names(lead))}</strong> tie for the most` : `<strong>${esc(top.p.name)}</strong> delivers the most`} from ${esc(s.short)} to ${esc(r.name)}: <strong>${esc(plain(R.money(top.gets, r.currency)))}</strong> for ${esc(amt)}${lead.length > 1 ? "" : `, at a rate of ${R.rateStr(top.ev.rate)} with ${esc(R.feeStr(top.q, s.currency).replace(/^Fee /, "a fee of ").replace(/^No fee$/, "no fee"))}`}.${last && last !== top ? ` The lowest of the ${fresh.length} services we checked, ${esc(last.p.name)}, delivers ${esc(plain(R.money(last.gets, r.currency)))}, so choosing well is worth ${esc(plain(R.money(top.gets - last.gets, r.currency)))} on this one transfer.` : ""}${midTxt ? ` The mid-market rate is ${esc(midTxt)}.` : ""}</p>` : "";
    const faqs = [
      [`What is the cheapest way to send money from ${s.short} to ${r.name} today?`, top ? `Today ${who}: ${plain(R.money(top.gets, r.currency))} for ${amt}, after fees and exchange-rate margins. The order changes from day to day, so check the ranking on this page before each transfer.` : `It changes from day to day. The ranking on this page shows which service delivers the most ${rCur} for the amount you enter, after the transfer fee and the exchange-rate markup.`],
      ...(ctx.mid && s.currency !== r.currency ? [[`What is the ${s.currency} to ${r.currency} exchange rate today?`, `The mid-market rate is ${midTxt}.${top ? ` The best rate a transfer service offers today is ${R.rateStr(Math.max(...fresh.map((x) => x.ev.rate)))}, but the fee matters too, which is why we rank by the amount that arrives.` : ""}`]] : []),
      ...(ctx.mid && s.currency !== r.currency ? [[`How much is ${amt} in ${rCur}?`, `At the mid-market rate, ${amt} is ${plain(R.money(ctx.amount * ctx.mid, r.currency))}.${top ? ` After fees and margins, the best transfer service today delivers ${plain(R.money(top.gets, r.currency))}.` : ""}`]] : []),
      ...(nets.length ? [[`Can I send money from ${s.short} to ${nets[0]} in ${r.name}?`, mobileProv.length ? `Yes. Of the services we checked today, ${joinList(mobileProv)} pay out to mobile money in ${r.name}${nets.length > 1 ? `, which covers ${joinList(nets)}` : ""}. Choose "Mobile money" above the ranking to compare only those.` : `Several services pay out to mobile money in ${r.name}. Choose "Mobile money" above the ranking to see which ones were checked today.`]] : []),
      [`How long does a transfer from ${s.short} to ${r.name} take?`, `Mobile money transfers usually arrive within minutes once the provider has verified your payment. Bank deposits take from a few minutes to two working days, and cash pickup is usually ready the same day. Your first transfer can take longer while the provider checks your identity.`],
      [`How can people in ${r.name} receive the money?`, Object.entries(r.payout).map(([k, v]) => `${R.LABEL[k]}: ${v}`).join(". ") + "."],
      [`Why compare against the mid-market rate?`, `The mid-market rate is the midpoint between buying and selling prices on currency markets. Providers add a margin on top of it, so the gap between their rate and the mid-market rate is a hidden cost, even when the fee says zero.`],
      [`Is ${config.siteName} a money transfer service?`, `No. We compare services and send you to the provider to complete your transfer. We never hold your money or your card details. SendFair also estimates what it costs to build a house in ${r.name}.`],
      ...(() => {
        const est = BC.estimate(buildCosts, r.id, 110, 1, midmarket.rates || {});
        if (!est || !(est.total > 0)) return [];
        return [[`How much does it cost to build a house in ${r.name}?`, `A 3-bedroom bungalow, one floor, comes to about ${plain(R.money(est.total, est.currency))} for materials and trade days on prices checked ${buildCosts.updated}, without land or the contractor's fee. You can switch the roof sheet, windows, doors, tiles, ceiling and paint. The full list is on the Cost to build a house in ${r.name} page.`]];
      })()
    ];
    const trail = [[config.siteName, ""], [`Send money to ${r.name}`, hubPath(r)], [`${s.label} to ${r.name}`, rel]];
    const body = tool({
      ctx,
      heading: `Send money from ${esc(s.short)} to ${esc(r.name)}`,
      sub: lede
    }) + `
<nav class="secnav" aria-label="On this page"><div class="wrap"><a href="#rates">Rates by amount</a><a href="#history">Rate history</a><a href="#alert">Rate alert</a><a href="#tips">Good to know</a><a href="#faq">Questions</a></div></nav>
<section class="block"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h2 id="rates">${s.currency === r.currency ? esc(s.currency) + " transfer services compared" : esc(s.currency) + " to " + esc(r.currency) + ": today's rates by service"}</h2>
${summary}
${amountsTable(ctx)}
${AMOUNT_PAGES[s.currency] ? `<h2 id="popular-amounts">Popular amounts</h2><ul class="route-links">${AMOUNT_PAGES[s.currency].map((a) => `<li><a href="${link(prefix, rel + a + "/")}">Send ${esc(amountLabel(a, s.currency))} to ${esc(r.name)}</a></li>`).join("")}</ul>` : ""}
<h2 id="history">${esc(s.currency)} to ${esc(r.currency)} rate history</h2>
${histChart(ctx)}
${(() => { const w = winsFor(ctx.key); if (w.days < 3) return ""; return `<h3>Who delivered the most, day by day</h3><p>Over the last ${w.days} days we checked this route, ${esc(joinList(w.wins.slice(0, 4).map(([id, c]) => `${(providers[id] || { name: id }).name} on ${c}`)))}. Ties count for each service.</p>`; })()}
${s.currency !== r.currency ? `<p class="note"><a href="${link(prefix, `rates/${s.currency.toLowerCase()}-to-${r.currency.toLowerCase()}/`)}">${esc(s.currency)} to ${esc(r.currency)} converter and today's rate</a></p>` : ""}
<h2 id="alert">Get a rate alert</h2>
${alertForm(ctx)}
<h2>How to send money from ${esc(s.short)} to ${esc(r.name)}</h2>
<ol class="howto">
<li><strong>Compare today's options.</strong> Enter the amount you will pay above. The service at the top delivers the most ${esc(rCur)} after its fee and exchange-rate margin.</li>
<li><strong>Open an account with the provider.</strong> ${s.region === "gulf" ? `Services in ${esc(s.short)} must check your identity, so have your ${esc(s.idDoc || "residence ID")} ready. At an exchange house branch you can do this at the counter; apps check it on your phone.` : "Providers must check your identity, so have photo ID ready."} Your first transfer may take longer while this is done.</li>
<li><strong>Add your recipient.</strong> For mobile money${nets.length ? ` (${esc(joinList(nets))})` : ""}, you need their phone number registered for the wallet. For a bank deposit, their account number and bank. For cash pickup, their full name exactly as on their ID.</li>
<li><strong>Pay and track the transfer.</strong> ${s.region === "gulf" ? "Pay by bank transfer, debit card, wallet balance or cash at a branch, depending on the service." : "Bank transfers are often cheapest to pay with; cards can add a fee."} Check the final amount on the provider's screen before you confirm.</li>
</ol>
<h2>Ways to receive money in ${esc(r.name)}</h2>
<ul class="payout-list">${Object.entries(r.payout).map(([k, v]) => `<li><span>${R.LABEL[k]}</span><span>${esc(v)}</span></li>`).join("")}</ul>
${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
${houseNote(r, prefix)}
${flyNote(r, prefix)}
<h2 id="tips">Good to know before you send</h2>
<ul class="tips">${tipsFor(s, r).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
${s.region === "gulf" ? `<p class="note"><a href="${link(prefix, GULF_GUIDE)}">Exchange house, bank, wallet or app? How the ways of sending from the Gulf compare</a></p>` : ""}
<h2 id="faq">Questions about sending money to ${esc(r.name)}</h2>
${faqBlock(faqs)}
${(() => { const ids = new Set(fresh.map((x) => x.p.id)); const links = vsList.filter(([CA, CB]) => ids.has(CA.id) && ids.has(CB.id)).map(([CA, CB]) => `<li><a href="${link(prefix, vsRoutePath(CA, CB, s, r))}">${esc(CA.name)} vs ${esc(CB.name)} on ${esc(s.label)} to ${esc(r.name)}</a></li>`); return links.length ? `<h2>Compare two services on this route</h2><ul class="route-links">${links.join("")}</ul>` : ""; })()}
${config.whatsappNumber ? `<p class="wa"><a class="btn" href="https://wa.me/${esc(String(config.whatsappNumber).replace(/[^\d]/g, ""))}?text=${encodeURIComponent(`Hi SendFair, ${s.currency} to ${r.name} ${ctx.amount}`)}" target="_blank" rel="noopener">Ask us on WhatsApp</a></p>` : ""}
${peopleAlsoAsk({ prefix, country: r.id, sender: s.id, topic: "send" })}
<h2>Other routes</h2>
<ul class="route-links">${corridors.receivers.filter((x) => x.id !== r.id).map((x) => `<li><a href="${link(prefix, corridorPath(s, x))}">${esc(s.label)} to ${esc(x.name)}</a></li>`).join("")}${corridors.senders.filter((x) => x.id !== s.id).map((x) => `<li><a href="${link(prefix, corridorPath(x, r))}">${esc(x.label)} to ${esc(r.name)}</a></li>`).join("")}</ul>
</div></div></section>` + reportSection(ctx) + alerts();
    // A route with no fresh quotes stays reachable but is kept out of search results and the sitemap until it is filled.
    write(rel + "index.html", page({
      prefix, canonical: rel, title, description, og: slug(s, r), noindex: !top,
      jsonld: [faqLd(faqs), crumbs(trail), rankItemList(ctx)],
      alternates: FR_RECEIVERS.has(r.id) ? [{ lang: "en", href: `${site}/${rel}` }, { lang: "fr", href: `${site}/${frRouteRel(s, r)}` }, { lang: "x-default", href: `${site}/${rel}` }] : [],
      init: { from: s.id, to: r.id, pageUrl: `${site}/${rel}` }, body
    }));
    if (top) urls.push(rel);
  }
}

// Amount-specific landing pages: /send-money/<route>/<amount>/. Same data and ranking as the route
// page, pre-filled with the amount; a page with no live quotes is written but kept out of search.
for (const s of corridors.senders) {
  const pageAmounts = AMOUNT_PAGES[s.currency];
  if (!pageAmounts) continue;
  for (const r of corridors.receivers) {
    const routeRel = corridorPath(s, r), prefix = "../../../";
    const rCur = CURNAME[r.currency] || r.currency;
    for (const amount of pageAmounts) {
      const rel = amountPath(s, r, amount);
      const ctx = routeContext(s, r, prefix, amount);
      ctx.shareUrl = `${site}/${rel}`;
      const fresh = ctx.rows.filter((x) => !x.stale);
      const top = fresh[0], low = fresh.length > 1 ? fresh[fresh.length - 1] : null, lead = R.leaders(ctx.rows);
      const amtSym = amountLabel(amount, s.currency);
      const trail = [[config.siteName, ""], [`Send money to ${r.name}`, hubPath(r)], [`${s.label} to ${r.name}`, routeRel], [amtSym, rel]];
      const noindex = !top;
      let title, description, body, jsonld = [crumbs(trail)];
      if (top) {
        const feeNum = top.ev.fee > 0.004 ? plain(R.money(top.ev.fee, s.currency, 2)) : "";
        const feeTxt = feeNum ? `a ${feeNum} fee` : "no fee";
        const fast = fresh.filter((x) => x.q.speed).sort((a, b) => speedRank(a.q.speed) - speedRank(b.q.speed))[0];
        const bestName = lead.length > 1 ? R.names(lead) : top.p.name;
        const summary = `<p>On ${esc(dateLong)}, <strong>${esc(bestName)}</strong> ${lead.length > 1 ? "tie for the most" : "delivers the most"} for ${esc(amtSym)} from ${esc(s.short)} to ${esc(r.name)}: <strong>${esc(plain(R.money(top.gets, r.currency)))}</strong>, ${esc(feeTxt)}, at a rate of ${R.rateStr(top.ev.rate)}.</p>`;
        const vs = low && low !== top ? `<p>${esc(plain(R.money(top.gets - low.gets, r.currency)))} more arrives with ${esc(top.p.name)} than with ${esc(low.p.name)} for the same ${esc(amtSym)}.</p>` : "";
        const breakdown = `<h2>How the best option adds up</h2><p>${esc(top.p.name)} takes ${esc(amtSym)}${feeNum ? `, takes off ${esc(feeNum)}` : ""}, converts ${esc(plain(R.money(top.ev.sent, s.currency)))} at ${R.rateStr(top.ev.rate)}, and your family receives ${esc(plain(R.money(top.gets, r.currency)))}. The fee is only part of the price: the exchange rate is the other part.</p>`;
        const faqs = [
          [`What is the cheapest way to send ${amtSym} to ${r.name} today?`, `Today ${lead.length > 1 ? R.names(lead) + " tie for the most" : top.p.name + " delivers the most"}: ${plain(R.money(top.gets, r.currency))} for ${amtSym}, after fees and the exchange-rate margin. The order changes from day to day, so check this page before each transfer.`],
          [`Which service is fastest for ${amtSym} to ${r.name}?`, fast ? `${fast.p.name} is the quickest of the services checked for ${amtSym}, with a delivery time of ${fast.q.speed}. Others take longer; trust the time on the provider's own screen.` : `Delivery times vary by service and payout method. Mobile money is usually fastest; the provider's screen shows the time for your transfer.`],
          [`How much is the fee to send ${amtSym} to ${r.name}?`, `${top.p.name} charges ${feeNum ? feeNum : "no fee"} on ${amtSym}, then converts the rest at ${R.rateStr(top.ev.rate)}. Confirm the final amount on the provider's screen before you pay.`]
        ];
        title = fitTitle([
          `Send ${amtSym} (${s.currency}) to ${r.name}: ${plain(R.money(top.gets, r.currency))} with ${top.p.name}`,
          `Send ${amtSym} to ${r.name}: ${plain(R.money(top.gets, r.currency))} with ${top.p.name} today`,
          `Send ${amtSym} to ${r.name}: best ${s.currency} to ${r.currency} rate today`,
          `Send ${amtSym} to ${r.name}: compare ${s.currency} to ${r.currency} transfers`
        ]);
        description = fitDescription([
          `${amtSym} to ${r.name} today: ${top.p.name} delivers ${plain(R.money(top.gets, r.currency))}, the most of ${fresh.length} services checked. Compare fees and rates by what actually arrives.`,
          `${amtSym} to ${r.name}: ${top.p.name} delivers ${plain(R.money(top.gets, r.currency))} today, the most of ${fresh.length} services. Compare what actually arrives after fees.`,
          `Send ${amtSym} to ${r.name}: ${top.p.name} delivers ${plain(R.money(top.gets, r.currency))} today. Compare ${s.currency} to ${r.currency} services by what arrives.`
        ]);
        jsonld = [faqLd(faqs), crumbs(trail), rankItemList(ctx)];
        body = tool({ ctx, heading: `Send ${esc(amtSym)} to ${esc(r.name)}: who delivers the most today`, sub: `Compare ${fresh.length} services by how many ${esc(rCur)} arrive for ${esc(amtSym)} today. Rates checked ${esc(dateLong)}.` }) + `
<nav class="secnav" aria-label="On this page"><div class="wrap"><a href="#amounts">Other amounts</a><a href="#faq">Questions</a></div></nav>
<section class="block"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
${summary}
${vs}
${breakdown}
<h2 id="faq">Questions about sending ${esc(amtSym)} to ${esc(r.name)}</h2>
${faqBlock(faqs)}
<h2 id="amounts">Other amounts from ${esc(s.short)} to ${esc(r.name)}</h2>
<ul class="route-links">${pageAmounts.filter((a) => a !== amount).map((a) => `<li><a href="${link(prefix, amountPath(s, r, a))}">Send ${esc(amountLabel(a, s.currency))} to ${esc(r.name)}</a></li>`).join("")}</ul>
<p><a href="${link(prefix, routeRel)}">Compare all services from ${esc(s.short)} to ${esc(r.name)}</a></p>
</div></div></section>` + alerts();
        urls.push(rel);
      } else {
        title = `Send ${amtSym} to ${r.name}: ${s.currency} to ${r.currency} transfer services`;
        description = `Compare ${s.currency} to ${r.currency} transfer services from ${s.short} to ${r.name} by what actually arrives. No online price for ${amtSym} is published yet.`;
        body = tool({ ctx, heading: `Send ${esc(amtSym)} to ${esc(r.name)}: who delivers the most today`, sub: ctx.anyQuotes ? `Quotes for ${esc(amtSym)} from ${esc(s.short)} to ${esc(r.name)} are being rechecked.` : `No service publishes an online price for ${esc(amtSym)} from ${esc(s.short)} to ${esc(r.name)} yet.` }) + `
<section class="block"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<p>${ctx.anyQuotes ? "The last check is older than three days, so it is hidden until we recheck it." : `The services on this route show their rates only in their apps or at their branches. There is no ranking to use until an online quote for ${esc(amtSym)} is published.`}</p>
<p><a href="${link(prefix, routeRel)}">See the ${esc(s.label)} to ${esc(r.name)} route page</a></p>
</div></div></section>`;
      }
      write(rel + "index.html", page({ prefix, canonical: rel, title, description, noindex, jsonld, init: { from: s.id, to: r.id, amount, pageUrl: `${site}/${rel}` }, body }));
    }
  }
}

// Country pages: "Send money to Kenya"
for (const r of corridors.receivers) {
  const rel = hubPath(r), prefix = "../../";
  const nets = networks(r), rCur = CURNAME[r.currency] || r.currency;
  const lines = corridors.senders.map((s) => {
    const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]);
    return { s, ctx, top: ctx.rows.find((x) => !x.stale), lead: R.leaders(ctx.rows) };
  });
  const names = [...new Set(lines.flatMap((l) => l.ctx.rows.map((x) => x.p.name)))];
  const faqs = [
    [`What is the cheapest way to send money to ${r.name}?`, `It depends on where you send from and how much. Today: ${lines.filter((l) => l.top).map((l) => `from ${l.s.short}, ${l.lead.length > 1 ? R.names(l.lead) + " (tied)" : l.top.p.name} (${plain(R.money(l.top.gets, r.currency))} for ${plain(R.money(l.ctx.amount, l.s.currency, 0))})`).join("; ") || "rates are being checked"}.`],
    [`How can people in ${r.name} receive money from abroad?`, Object.entries(r.payout).map(([k, v]) => `${R.LABEL[k]}: ${v}`).join(". ") + "."],
    [`Which services send money to ${r.name}?`, names.length ? `We compare ${joinList(names)} on routes to ${r.name}, ranked by the amount that arrives.` : `Several international services send to ${r.name}; we are checking today's rates.`],
    ...(() => {
      const est = BC.estimate(buildCosts, r.id, 110, 1, midmarket.rates || {});
      if (!est || !(est.total > 0)) return [];
      return [[`How much does a house cost to build in ${r.name}?`, `A 3-bedroom bungalow, one floor, comes to about ${plain(R.money(est.total, est.currency))} for materials and trade days on prices checked ${buildCosts.updated}, without land or the contractor's fee. SendFair is a transfer comparison and a house-cost check. Open Cost to build a house in ${r.name} to switch the roof sheet, windows, doors, tiles, ceiling and paint.`]];
    })()
  ];
  const trail = [[config.siteName, ""], [`Send money to ${r.name}`, rel]];
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>Send money to ${esc(r.name)}</h1>
<p class="lede">Compare what arrives in ${esc(r.name)} from the UK, the US, Europe, Canada, Australia and the Gulf states, in ${esc(rCur)}${nets.length ? ` by ${esc(joinList(nets))}, bank or cash pickup` : ""}. Ranked by the amount your family receives, rates checked ${esc(dateLong)}. If the money is for a house, the calculator further down prices the build in ${esc(r.name)}.</p>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">Sending from</th><th scope="col">You pay</th><th scope="col">Best today</th><th scope="col" class="num">They get</th><th scope="col"></th></tr></thead>
<tbody>${lines.filter((l) => l.s.region !== "gulf" || lines.some((m) => m.s.region === "gulf" && m.ctx.anyQuotes)).map((l, i, arr) => `${i && l.s.region !== arr[i - 1].s.region ? `<tr class="group"><th scope="rowgroup" colspan="5">From the Gulf · <a href="${link(prefix, GULF_GUIDE)}">ways of sending compared</a></th></tr>` : ""}<tr><th scope="row">${esc(l.s.name)}</th><td class="num">${esc(plain(R.money(l.ctx.amount, l.s.currency, 0)))}</td><td>${l.top ? esc(l.lead.length > 1 ? l.lead.map((x) => x.p.name).join(", ") + " (tie)" : l.top.p.name) : "Being checked"}</td><td class="num top">${l.top ? esc(plain(R.money(l.top.gets, r.currency))) : "–"}</td><td><a href="${link(prefix, corridorPath(l.s, r))}">Compare all</a></td></tr>`).join("")}${lines.some((m) => m.s.region === "gulf") && !lines.some((m) => m.s.region === "gulf" && m.ctx.anyQuotes) ? `<tr class="group"><th scope="rowgroup" colspan="5">From the Gulf: rates are being added · <a href="${link(prefix, GULF_GUIDE)}">ways of sending compared</a></th></tr>` : ""}</tbody>
</table></div>
<h2>Ways to receive money in ${esc(r.name)}</h2>
<ul class="payout-list">${Object.entries(r.payout).map(([k, v]) => `<li><span>${R.LABEL[k]}</span><span>${esc(v)}</span></li>`).join("")}</ul>
${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
${houseNote(r, prefix)}
${flyNote(r, prefix)}
<h2>Good to know before you send to ${esc(r.name)}</h2>
<ul class="tips">${[...(TIPS[r.id] || []), ...TIPS_ALL].map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
<h2>Questions</h2>
${faqBlock(faqs)}
<h2>Compare a route</h2>
<ul class="route-links">${corridors.senders.map((s) => `<li><a href="${link(prefix, corridorPath(s, r))}">${esc(s.label)} to ${esc(r.name)}</a></li>`).join("")}</ul>
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, og: "home",
    title: `Send money to ${r.name}: today's best rates compared`,
    description: `Compare every service that sends money to ${r.name}, ranked by what actually arrives after fees and the exchange-rate margin. Updated automatically.`,
    jsonld: [faqLd(faqs), crumbs(trail)],
    alternates: FR_RECEIVERS.has(r.id) ? [{ lang: "en", href: `${site}/${rel}` }, { lang: "fr", href: `${site}/${frHubRel(r)}` }, { lang: "x-default", href: `${site}/${rel}` }] : [],
    body }));
  urls.push(rel);
}

// Provider lines: every route a provider has a quote on, with its rank there.
const providerLines = (p, prefix) => {
  const lines = [];
  for (const s of corridors.senders) for (const r of corridors.receivers) {
    const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]);
    const i = ctx.rows.findIndex((x) => x.p.id === p.id);
    if (i >= 0) lines.push({ s, r, ctx, x: ctx.rows[i], pos: ctx.rows[i].pos || i + 1, of: ctx.rows.length });
  }
  return lines;
};
function rankItemList(ctx) {
  const rows = ctx.rows.filter((x) => !x.stale).slice(0, 10);
  if (!rows.length) return null;
  return {
    "@context": "https://schema.org", "@type": "ItemList",
    name: `Services ranked by the amount that arrives for ${ctx.s.label} to ${ctx.r.name}`,
    itemListElement: rows.map((x, i) => ({
      "@type": "ListItem", position: i + 1,
      item: {
        "@type": "FinancialProduct",
        name: x.p.name,
        ...(x.p.website ? { url: x.p.website } : {}),
        additionalProperty: { "@type": "PropertyValue", name: "Amount received", value: Math.round(x.gets), unitText: ctx.r.currency },
        offers: { "@type": "Offer", price: Math.round(x.ev.fee * 100) / 100, priceCurrency: ctx.s.currency, ...(x.q.checkedAt ? { validFrom: x.q.checkedAt } : {}) }
      }
    }))
  };
}
function providerOrgLd(p) {
  const sameAs = [p.website, p.rating && p.rating.url].filter(Boolean);
  const ld = { "@context": "https://schema.org", "@type": "Organization", name: p.name, ...(p.website ? { url: p.website } : {}), ...(sameAs.length ? { sameAs } : {}) };
  // No aggregateRating: the scores are Trustpilot's, and Google's review-snippet rules forbid marking up
  // ratings gathered from other websites. The Trustpilot profile is linked through sameAs instead.
  return ld;
}
const ratingLine = (p) => p.rating ? `<a href="${esc(p.rating.url)}" target="_blank" rel="noopener">Trustpilot ${p.rating.score}/5</a> (${esc(p.rating.label)}, ${Number(p.rating.reviews).toLocaleString("en")} reviews)` : "Not rated yet";

// Provider review pages: "Wise review: rates, fees and ratings for sending money to Africa"
for (const p of providersWithQuotes()) {
  const rel = provPath(p), prefix = "../../";
  const lines = providerLines(p, prefix);
  const fresh = lines.filter((l) => !l.x.stale);
  const firsts = fresh.filter((l) => l.pos === 1).length;
  const noFee = fresh.filter((l) => l.x.ev.fee < 0.005).length;
  const avgCost = fresh.filter((l) => l.x.cost != null);
  const costPct = avgCost.length ? avgCost.reduce((a, l) => a + Math.max(0, l.x.cost), 0) / avgCost.length * 100 : null;
  const countries = [...new Set(lines.map((l) => l.r.name))];
  const senders = [...new Set(lines.map((l) => l.s.short))];
  const missing = corridors.receivers.filter((r) => !countries.includes(r.name)).map((r) => r.name);
  const payouts = [...new Set(lines.flatMap((l) => l.x.q.payout || []))].map((m) => R.LABEL[m]);
  const notes = [...new Set(lines.map((l) => l.x.q.note).filter(Boolean))];
  const trail = [[config.siteName, ""], [`${p.name} review`, rel]];
  const strengths = [], watch = [];
  if (firsts) strengths.push(`Delivers the most on ${firsts} of ${fresh.length} routes we checked today.`);
  if (noFee) strengths.push(`No transfer fee on ${noFee} of ${fresh.length} routes (the cost is in the exchange rate).`);
  if (p.rating && p.rating.score >= 4.5) strengths.push(`Highly rated by customers: ${p.rating.score}/5 on Trustpilot from ${Number(p.rating.reviews).toLocaleString("en")} reviews.`);
  if (payouts.length > 2) strengths.push(`Pays out by ${joinList(payouts.map((x) => x.toLowerCase()))}.`);
  if (costPct != null && costPct > 1.5) watch.push(`Average total cost of ${costPct.toFixed(1)}% against the mid-market rate on our routes, so check the alternatives.`);
  if (missing.length) watch.push(`We don't have ${p.name} rates for ${joinList(missing)}.`);
  if ((p.payIn || []).length === 1) watch.push(`Payment by ${p.payIn[0].toLowerCase()} only.`);
  if (p.rating && p.rating.score < 4.3) watch.push(`Customer rating of ${p.rating.score}/5 on Trustpilot is below most services here.`);
  const faqs = [
    [`Is ${p.name} the cheapest way to send money to Africa?`, `On the routes we checked on ${dateLong}, ${p.name} delivers the most on ${firsts} of ${fresh.length}. Which service is cheapest depends on the route and the amount, so compare before each transfer.`],
    [`Which countries does ${p.name} send to that SendFair compares?`, `${joinList(countries)}, from ${joinList(senders)}.`],
    [`How do I pay ${p.name}?`, (p.payIn || []).length ? `${joinList(p.payIn)}. Card payments can cost more than a bank transfer.` : `See ${p.name}'s website for payment options.`],
    [`Is ${p.name} safe?`, `${p.name} is a licensed money transfer service in the countries it operates in. Before sending, you can check its licence with the regulator where you live: ${regulatorText([...new Set(lines.map((l) => l.s))])}.${p.rating ? ` Customers rate it ${p.rating.score}/5 on Trustpilot.` : ""}`]
  ];
  const others = providersWithQuotes().filter((o) => o.id !== p.id);
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1 class="with-badge">${R.badge(p, "b-lg")}<span>${esc(p.name)} review: rates, fees and ratings for Africa</span></h1>
<p class="lede">How ${esc(p.name)} compares on ${lines.length} routes to ${esc(joinList(countries))}, using rates checked on ${esc(dateLong)}.</p>
<div class="facts">
  <div><span class="k">Customer rating</span><span class="v">${ratingLine(p)}</span></div>
  <div><span class="k">Most money home</span><span class="v">${firsts} of ${fresh.length} routes today</span></div>
  ${(() => { let days = 0, won = 0; for (const l of lines) { const w = winsFor(l.ctx.key); days += w.days; won += (w.wins.find(([id]) => id === p.id) || [0, 0])[1]; } return days >= 6 ? `<div><span class="k">Last 30 days</span><span class="v">Most money home on ${won} of ${days} route-days</span></div>` : ""; })()}
  <div><span class="k">Average cost vs mid-market</span><span class="v">${costPct == null ? "–" : costPct.toFixed(1) + "%"}</span></div>
  <div><span class="k">Ways to pay</span><span class="v">${esc(joinList(p.payIn || []) || "See provider")}</span></div>
  <div><span class="k">Ways to receive</span><span class="v">${esc(joinList(payouts) || "–")}</span></div>
</div>
${strengths.length ? `<h2>Strengths</h2><ul class="tips">${strengths.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
${watch.length ? `<h2>Worth knowing</h2><ul class="tips">${watch.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
<h2>${esc(p.name)} rates on every route</h2>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">Route</th><th scope="col">Rate</th><th scope="col">Fee</th><th scope="col">You pay</th><th scope="col" class="num">They get</th><th scope="col">Rank</th></tr></thead>
<tbody>${lines.map((l) => `<tr><th scope="row"><a href="${link(prefix, corridorPath(l.s, l.r))}">${esc(l.s.label)} to ${esc(l.r.name)}</a></th><td class="num">${R.rateStr(l.x.ev.rate)}</td><td>${esc(R.feeStr(l.x.q, l.s.currency).replace(/^Fee /, ""))}</td><td class="num">${esc(plain(R.money(l.ctx.amount, l.s.currency, 0)))}</td><td class="num${l.pos === 1 ? " top" : ""}">${esc(plain(R.money(l.x.gets, l.r.currency)))}</td><td>${l.x.stale ? "Not rechecked" : `${l.x.tied ? "Joint " : ""}${ordinal(l.pos)} of ${l.of}`}</td></tr>`).join("")}</tbody>
</table></div>
${notes.length ? `<p class="note">${notes.map(esc).join(" ")}</p>` : ""}
<p><a class="btn" href="${esc(hrefFor(prefix)(p, "provider-page"))}" target="_blank" rel="sponsored nofollow noopener">Go to ${esc(p.name)}</a></p>
<p class="note">Sending the money to build? <a href="${link(prefix, "cost-to-build/")}">Estimate the cost of a house back home</a>, then come back here to see which service delivers the most of it.</p>
<h2>${esc(p.name)} compared with</h2>
<ul class="route-links">${others.filter((o) => vsPairs().some(([a, b]) => (a.id === p.id && b.id === o.id) || (b.id === p.id && a.id === o.id))).map((o) => { const [a, b] = vsPairs().find(([a, b]) => (a.id === p.id && b.id === o.id) || (b.id === p.id && a.id === o.id)); return `<li><a href="${link(prefix, vsPath(a, b))}">${esc(p.name)} vs ${esc(o.name)}</a></li>`; }).join("")}</ul>
<h2>Questions about ${esc(p.name)}</h2>
${faqBlock(faqs)}
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, og: "home",
    title: `${p.name} review: rates, fees and ratings for Africa`,
    description: `${p.name} on ${lines.length} routes to Africa: today's rates and fees, how often it delivers the most, ways to pay and receive, and its ${p.rating ? `${p.rating.score}/5 Trustpilot rating` : "customer rating"}.`,
    jsonld: [faqLd(faqs), crumbs(trail), providerOrgLd(p)], body }));
  urls.push(rel);
}

// Head-to-head pages: "Wise vs Remitly"
for (const [A, B] of vsPairs()) {
  const rel = vsPath(A, B), prefix = "../../";
  const rows = [];
  for (const s of corridors.senders) for (const r of corridors.receivers) {
    const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]);
    const a = ctx.rows.find((x) => x.p.id === A.id && !x.stale), b = ctx.rows.find((x) => x.p.id === B.id && !x.stale);
    if (a && b) rows.push({ s, r, ctx, a, b });
  }
  if (!rows.length) {
    write(rel + "index.html", page({ prefix, canonical: rel, og: "home",
      title: compareTitle(A, B),
      description: `${A.name} vs ${B.name} compared on cost, fees, ways to pay and Trustpilot ratings.`,
      jsonld: [crumbs([[config.siteName, ""], [`${A.name} vs ${B.name}`, rel]])],
      body: `<section class="block page"><div class="wrap"><article class="prose wide">${crumbNav(prefix, [[config.siteName, ""], [`${A.name} vs ${B.name}`, rel]])}<h1>${esc(A.name)} vs ${esc(B.name)}</h1><p>We don't have a current head-to-head for these two on any route we've checked recently. Try again after the next rate check, or read the reviews below.</p><p><a href="${link(prefix, provPath(A))}">${esc(A.name)} review</a> · <a href="${link(prefix, provPath(B))}">${esc(B.name)} review</a></p></article></div></section>` }));
    urls.push(rel);
    continue;
  }
  const winsA = rows.filter((x) => Math.round(x.a.gets) > Math.round(x.b.gets)).length, winsB = rows.filter((x) => Math.round(x.b.gets) > Math.round(x.a.gets)).length;
  const ties = rows.length - winsA - winsB;
  const lead = winsA === winsB ? null : winsA > winsB ? A : B;
  const trail = [[config.siteName, ""], [`${A.name} vs ${B.name}`, rel]];
  const verdict = lead ? `On the ${rows.length} routes both cover, ${lead.name} delivers more on ${Math.max(winsA, winsB)} and ${lead === A ? B.name : A.name} on ${Math.min(winsA, winsB)}${ties ? `, with ${ties} tied` : ""} (rates checked ${dateLong}).` : `On the ${rows.length} routes both cover, they each deliver more on ${winsA}${ties ? `, with ${ties} tied` : ""} (rates checked ${dateLong}).`;
  const faqs = [
    [`Is ${A.name} or ${B.name} cheaper for sending money to Africa?`, verdict + " The answer changes by route and amount, so compare on the day you send."],
    [`Which is rated better, ${A.name} or ${B.name}?`, A.rating && B.rating ? `On Trustpilot, ${A.name} has ${A.rating.score}/5 from ${Number(A.rating.reviews).toLocaleString("en")} reviews and ${B.name} has ${B.rating.score}/5 from ${Number(B.rating.reviews).toLocaleString("en")} reviews.` : "We show Trustpilot ratings where available."],
    [`How do you pay ${A.name} and ${B.name}?`, `${A.name}: ${joinList(A.payIn || ["see provider"])}. ${B.name}: ${joinList(B.payIn || ["see provider"])}.`]
  ];
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>${esc(A.name)} vs ${esc(B.name)}: which sends more to Africa?</h1>
<p class="lede">${esc(verdict)}</p>
<div class="vs-cards">${[A, B].map((P) => `<div class="vs-card"><h2 class="with-badge">${R.badge(P, "b-md")}${esc(P.name)}</h2><dl>
<div><dt>Delivers more</dt><dd>${P === A ? winsA : winsB} of ${rows.length} shared routes</dd></div>
<div><dt>Rating</dt><dd>${ratingLine(P)}</dd></div>
<div><dt>Ways to pay</dt><dd>${esc(joinList(P.payIn || []) || "See provider")}</dd></div></dl>
<a class="btn" href="${esc(hrefFor(prefix)(P, "compare"))}" target="_blank" rel="sponsored nofollow noopener">Go to ${esc(P.name)}</a> <a href="${link(prefix, provPath(P))}">Full review</a></div>`).join("")}</div>
<h2>Route by route</h2>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">Route</th><th scope="col">You pay</th><th scope="col" class="num">${esc(A.name)}</th><th scope="col" class="num">${esc(B.name)}</th><th scope="col" class="num">Difference</th></tr></thead>
<tbody>${rows.map((x) => `<tr><th scope="row"><a href="${link(prefix, corridorPath(x.s, x.r))}">${esc(x.s.label)} to ${esc(x.r.name)}</a></th><td class="num">${esc(plain(R.money(x.ctx.amount, x.s.currency, 0)))}</td><td class="num${Math.round(x.a.gets) > Math.round(x.b.gets) ? " top" : ""}">${esc(plain(R.money(x.a.gets, x.r.currency)))}</td><td class="num${Math.round(x.b.gets) > Math.round(x.a.gets) ? " top" : ""}">${esc(plain(R.money(x.b.gets, x.r.currency)))}</td><td class="num">${Math.round(x.a.gets) === Math.round(x.b.gets) ? "Tie" : esc(plain(R.money(Math.abs(x.a.gets - x.b.gets), x.r.currency, Math.max(x.a.gets, x.b.gets) >= 1000 ? 0 : 2)))}</td></tr>`).join("")}</tbody>
</table></div>
<p class="note">Amounts are what arrives for a typical transfer, after fees and exchange-rate margins. The higher figure on each route is in bold. Other services may beat both: open a route to see the full ranking.</p>
<h2>Compare on your route</h2>
<ul class="route-links">${rows.map((x) => `<li><a href="${link(prefix, vsRoutePath(A, B, x.s, x.r))}">${esc(A.name)} vs ${esc(B.name)} on ${esc(x.s.label)} to ${esc(x.r.name)}</a></li>`).join("")}</ul>
<h2>What sets them apart</h2>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col"></th><th scope="col">${esc(A.name)}</th><th scope="col">${esc(B.name)}</th></tr></thead>
<tbody>${[
  ["Routes we compare", (P) => String(providerLines(P, prefix).length)],
  ["Ways to receive", (P) => joinList([...new Set(providerLines(P, prefix).flatMap((l) => l.x.q.payout || []))].map((m) => R.LABEL[m])) || "–"],
  ["Ways to pay", (P) => joinList(P.payIn || []) || "See provider"],
  ["Delivery time", (P) => [...new Set(providerLines(P, prefix).map((l) => l.x.q.speed).filter(Boolean))].slice(0, 3).join("; ") || "Not shown by the provider"],
  ["Typical cost vs mid-market", (P) => { const c = providerLines(P, prefix).filter((l) => !l.x.stale && l.x.cost != null).map((l) => Math.max(0, l.x.cost)); return c.length ? (c.reduce((a, b) => a + b, 0) / c.length * 100).toFixed(1) + "%" : "–"; }],
  ["Trustpilot", (P) => P.rating ? `${P.rating.score}/5 (${Number(P.rating.reviews).toLocaleString("en")} reviews)` : "Not rated yet"]
].map(([k, f]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(f(A))}</td><td>${esc(f(B))}</td></tr>`).join("")}</tbody></table></div>
<p>${esc(winsA === winsB ? `Neither is cheaper across the board. Pick by route: on each line above, the bold figure is the one that delivers more today.` : `${lead.name} delivers more on most shared routes today, but ${lead === A ? B.name : A.name} wins on ${Math.min(winsA, winsB)}, so check your own route.`)} Speed, the ways your family can collect the money and how you can pay also matter: a slightly lower amount can be worth it if it reaches a mobile wallet in minutes.</p>
<h2>Questions</h2>
${faqBlock(faqs)}
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, og: "home",
    title: compareTitle(A, B),
    description: `${A.name} vs ${B.name} on ${rows.length} routes to Africa: today's amounts delivered, fees, ways to pay and Trustpilot ratings, side by side.`,
    jsonld: [faqLd(faqs), crumbs(trail)], body }));
  urls.push(rel);
}

// Route-specific head-to-head pages: /compare/<a>-vs-<b>/<from>-to-<country>/. Only generated where
// both providers have a live quote on that route.
{
  const cache = new Map();
  for (const s of corridors.senders) {
    for (const r of corridors.receivers) {
      const prefix = "../../../";
      const key = `${s.id}-${r.id}`;
      if (!cache.has(key)) cache.set(key, routeContext(s, r, prefix, config.defaultAmounts[s.currency]));
      const ctx = cache.get(key);
      const fresh = ctx.rows.filter((x) => !x.stale);
      if (fresh.length < 2) continue;
      const sCur = CURNAME[s.currency] || s.currency, rCur = CURNAME[r.currency] || r.currency;
      const amt = config.defaultAmounts[s.currency];
      const amtSym = amountLabel(amt, s.currency);
      const amts = cmpAmounts(s);
      const delivery = (x) => { const rep = ctx.reports && ctx.reports[x.p.id]; return rep && rep.n >= 3 ? `${rep.typical} (from ${rep.n} user reports)` : (x.q.speed || "Not shown by the provider"); };
      const payout = (x) => (x.q.payout || []).map((m) => R.LABEL[m]).join(", ") || "Not stated";
      for (const [A, B] of vsList) {
        const a = fresh.find((x) => x.p.id === A.id), b = fresh.find((x) => x.p.id === B.id);
        if (!a || !b) continue;
        const rel = vsRoutePath(A, B, s, r);
        const at = (x, amt2) => { const ev = R.evaluate(x.q, amt2); return ev ? ev.gets : 0; };
        const win = (g1, g2) => { const hi = Math.max(g1, g2), lo = Math.min(g1, g2); if (!(hi > 0)) return null; return (hi - lo) / hi < 0.005 ? null : (g1 > g2 ? A : B); };
        const aGets = a.gets, bGets = b.gets, wTop = win(aGets, bGets);
        const verdict = wTop
          ? `On ${dateLong}, ${wTop.name} delivers more than ${wTop === A ? B.name : A.name} for ${amtSym} on ${s.label} to ${r.name}: ${plain(R.money(wTop === A ? aGets : bGets, r.currency))} vs ${plain(R.money(wTop === A ? bGets : aGets, r.currency))}.`
          : `On ${dateLong}, ${A.name} and ${B.name} are about the same for ${amtSym} on ${s.label} to ${r.name}: ${plain(R.money(aGets, r.currency))} vs ${plain(R.money(bGets, r.currency))}.`;
        const amtRows = amts.map((amt2) => {
          const ga = at(a, amt2), gb = at(b, amt2), w = win(ga, gb);
          return `<tr><th scope="row">${esc(plain(R.money(amt2, s.currency, 0)))}</th><td class="num${w === A ? " top" : ""}">${esc(plain(R.money(ga, r.currency)))}</td><td class="num${w === B ? " top" : ""}">${esc(plain(R.money(gb, r.currency)))}</td><td>${w ? esc(w.name) : "About the same"}</td></tr>`;
        }).join("");
        const faqs = [
          [`Which is cheaper, ${A.name} or ${B.name}, for ${amtSym} to ${r.name} today?`, `${verdict} The answer can change with the amount and the day, so check before each transfer.`],
          [`What fees do ${A.name} and ${B.name} charge from ${s.label} to ${r.name}?`, `${A.name}: ${R.feeStr(a.q, s.currency)}. ${B.name}: ${R.feeStr(b.q, s.currency)}. Fees are only part of the price; the exchange rate is the other part.`],
          [`How fast do ${A.name} and ${B.name} deliver to ${r.name}?`, `${A.name}: ${delivery(a)}. ${B.name}: ${delivery(b)}. Delivery times are the provider's own estimate; trust the time on their screen.`]
        ];
        const trail = [[config.siteName, ""], [`${A.name} vs ${B.name}`, vsPath(A, B)], [`${s.label} to ${r.name}`, rel]];
        const title = fitTitle([
          `${A.name} vs ${B.name} on ${s.label} to ${r.name}: who delivers more?`,
          `${A.name} vs ${B.name}: ${s.label} to ${r.name} comparison`,
          `${A.name} vs ${B.name} to ${r.name}: which delivers more?`
        ]);
        const description = fitDescription([
          `${verdict} Compare fees, rates, delivery and payout for this route.`,
          `${A.name} vs ${B.name} on ${s.label} to ${r.name}: what arrives for ${amtSym}, fees, rates and delivery, checked ${dateLong}.`,
          `${A.name} vs ${B.name} for ${amtSym} to ${r.name}, compared on what arrives after fees and the exchange-rate margin.`
        ]);
        const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>${esc(A.name)} vs ${esc(B.name)} on ${esc(s.label)} to ${esc(r.name)}: which delivers more?</h1>
<p class="lede">${esc(verdict)}</p>
<div class="vs-cards">${[A, B].map((P) => { const x = P === A ? a : b; return `<div class="vs-card"><h2 class="with-badge">${R.badge(P, "b-md")}${esc(P.name)}</h2><dl>
<div><dt>For ${esc(amtSym)} they get</dt><dd>${esc(plain(R.money(x.gets, r.currency)))}</dd></div>
<div><dt>Fee</dt><dd>${esc(R.feeStr(x.q, s.currency))}</dd></div>
<div><dt>Rating</dt><dd>${ratingLine(P)}</dd></div></dl>
<a class="btn" href="${esc(hrefFor(prefix)(P, "compare-route"))}" target="_blank" rel="sponsored nofollow noopener">Go to ${esc(P.name)}</a> <a href="${link(prefix, provPath(P))}">Full review</a></div>`; }).join("")}</div>
<h2 id="by-amount">Who wins by amount</h2>
<div class="table-wrap"><table class="rates-table">
<caption>What arrives in ${esc(r.name)}, ${esc(dateLong)}</caption>
<thead><tr><th scope="col">You send</th><th scope="col" class="num">${esc(A.name)}</th><th scope="col" class="num">${esc(B.name)}</th><th scope="col">Winner</th></tr></thead>
<tbody>${amtRows}</tbody>
</table></div>
<h2>Fees, rates and delivery</h2>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col"></th><th scope="col">${esc(A.name)}</th><th scope="col">${esc(B.name)}</th></tr></thead>
<tbody>
<tr><th scope="row">Fee for ${esc(amtSym)}</th><td>${esc(R.feeStr(a.q, s.currency))}</td><td>${esc(R.feeStr(b.q, s.currency))}</td></tr>
<tr><th scope="row">Exchange rate</th><td class="num">${R.rateStr(a.ev.rate)}</td><td class="num">${R.rateStr(b.ev.rate)}</td></tr>
<tr><th scope="row">Ways to receive</th><td>${esc(payout(a))}</td><td>${esc(payout(b))}</td></tr>
<tr><th scope="row">Typical delivery</th><td>${esc(delivery(a))}</td><td>${esc(delivery(b))}</td></tr>
<tr><th scope="row">Trustpilot</th><td>${ratingLine(A)}</td><td>${ratingLine(B)}</td></tr>
</tbody></table></div>
<p class="note">Amounts are what arrives for each transfer, after the fee and exchange-rate margin, on quotes checked ${esc(dateLong)}. The higher figure in each row is in bold. Other services may beat both: <a href="${link(prefix, corridorPath(s, r))}">see the full ranking for ${esc(s.label)} to ${esc(r.name)}</a>.</p>
<h2>Questions</h2>
${faqBlock(faqs)}
</div></div></section>`;
        write(rel + "index.html", page({ prefix, canonical: rel, og: "home", title, description, jsonld: [faqLd(faqs), crumbs(trail)], body }));
        urls.push(rel);
      }
    }
  }
}

// Exchange-rate index: every pair grouped by the sending country.
function writeRatesIndex() {
  const rel = "rates/", prefix = "../";
  const trail = [[config.siteName, ""], ["Exchange rates", rel]];
  const groups = [];
  for (const s of corridors.senders) {
    const pairs = ratePairs.filter((x) => x.s.id === s.id);
    if (!pairs.length) continue;
    const rows = pairs.map(({ s: ss, r }) => {
      const ctx = routeContext(ss, r, prefix, config.defaultAmounts[ss.currency]);
      if (!ctx.mid) return null;
      const sum = historySummary(ctx.hist, { mid: ctx.mid });
      const ch = sum.lines.find((l) => l.id === "change7");
      return { rel: ratePath(ss, r), label: `${ss.currency} to ${r.currency}`, mid: ctx.mid, change: ch ? ch.change : null };
    }).filter(Boolean);
    if (rows.length) groups.push({ s, rows });
  }
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>Exchange rates today</h1>
<p class="lede">The mid-market rate for every currency pair SendFair covers, with the 7-day change. A pair links to its converter, its 30-day history and the service that delivers the most for your amount. Rates checked ${esc(dateLong)}.</p>
${groups.map((g) => `<h2>From ${esc(g.s.short)}</h2><div class="table-wrap"><table class="rates-table"><thead><tr><th scope="col">Pair</th><th scope="col" class="num">Today</th><th scope="col" class="num">7-day change</th></tr></thead><tbody>${g.rows.map((row) => `<tr><th scope="row"><a href="${link(prefix, row.rel)}">${esc(row.label)}</a></th><td class="num">${esc(rateText(row.mid))}</td><td class="num">${row.change == null ? "—" : `${row.change >= 0 ? "+" : ""}${row.change.toFixed(1)}%`}</td></tr>`).join("")}</tbody></table></div>`).join("")}
<p class="note">The 7-day change compares today's mid-market rate with the latest check on or before seven days ago. A dash means we do not have a full week of checks yet.</p>
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, og: "home", title: `Exchange rates today: every currency pair | ${config.siteName}`, description: "Today's mid-market rate for every currency pair SendFair covers, with the 7-day change and a link to the converter, history and best service.", jsonld: [crumbs(trail)], body }));
  urls.push(rel);
}

// Exchange-rate pages: "GBP to KES today" with a converter, for every sending and receiving currency.
for (const { s, r } of ratePairs) {
  const rel = ratePath(s, r), prefix = "../../";
  const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]);
  if (!ctx.mid) continue;
  const fresh = ctx.rows.filter((x) => !x.stale);
  const sCur = CURNAME[s.currency] || s.currency, rCur = CURNAME[r.currency] || r.currency;
  const amts = [1, ...(STEP_AMOUNTS[s.currency] || [])];
  // Several sending countries can share a currency pair; the page has data if any of them does.
  const pairHasData = fresh.length > 0;
  const bestAt = (a) => { let b = null; for (const x of fresh) { const ev = R.evaluate(x.q, a); if (ev && (!b || ev.gets > b.gets)) b = { gets: ev.gets, p: x.p }; } return b; };
  const trail = [[config.siteName, ""], [`${s.currency} to ${r.currency}`, rel]];
  const faqs = [
    [`What is the ${s.currency} to ${r.currency} rate today?`, `The mid-market rate is 1 ${s.currency} = ${R.rateStr(ctx.mid)} ${r.currency} (${dateLong}). Transfer services pay a little less after their margin and fee; the table shows what arrives with the best service we checked.`],
    ...(STEP_AMOUNTS[s.currency] || []).slice(0, 3).map((a) => [`How much is ${plain(R.money(a, s.currency, 0))} in ${rCur}?`, `At the mid-market rate, ${plain(R.money(a * ctx.mid, r.currency))}.${bestAt(a) ? ` Sent from ${s.short} to ${r.name} today, the most that arrives is ${plain(R.money(bestAt(a).gets, r.currency))} with ${bestAt(a).p.name}.` : ""}`]),
    [`Why is the rate I get lower than the mid-market rate?`, `Transfer services add a margin to the mid-market rate and may charge a fee. The difference is their price, which is why SendFair ranks services by the amount that actually arrives.`]
  ];
  const histDays = Object.keys(history.days || {}).sort();
  const histSummary = historySummary(ctx.hist, { mid: ctx.mid });
  const historyBlock = histSummary.lines.length ? `<div class="facts">${histSummary.lines.map((l) => l.id === "change7" ? `<div><span class="k">Today vs 7 days ago</span><span class="v">${l.change >= 0 ? "+" : ""}${l.change.toFixed(1)}%</span></div>` : l.id === "best30" ? `<div><span class="k">Best day in the last 30 days</span><span class="v">${new Date(l.date + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} (${esc(plain(R.money(l.amount, r.currency)))}${l.sent ? ` for ${esc(s.currency)} ${Number(l.sent).toLocaleString("en")}` : ""})</span></div>` : l.id === "range30" ? `<div><span class="k">Mid-market range, last 30 days</span><span class="v">${R.rateStr(l.low)}–${R.rateStr(l.high)}</span></div>` : "").join("")}</div>` : "";
  const rateLd = { "@context": "https://schema.org", "@type": "ExchangeRateSpecification", currency: s.currency, currentExchangeRate: { "@type": "UnitPriceSpecification", price: +ctx.mid.toPrecision(6), priceCurrency: r.currency, unitText: `1 ${s.currency}`, validFrom: midmarket.updatedAt || quotesFile.updatedAt } };
  const dsLd = { "@context": "https://schema.org", "@type": "Dataset", name: `${s.currency} to ${r.currency} mid-market rate history`, description: `Daily ${s.currency} to ${r.currency} mid-market exchange rate recorded by SendFair, with the amount the best money transfer service delivered from ${s.name} to ${r.name} on each day it was checked.`, url: `${site}/${rel}`, isAccessibleForFree: true, variableMeasured: `${s.currency}/${r.currency} mid-market rate`, temporalCoverage: histDays.length ? `${histDays[0]}/${histDays[histDays.length - 1]}` : String(midmarket.updatedAt || "").slice(0, 10), creator: { "@type": "Organization", name: config.siteName, url: site + "/" }, license: "https://creativecommons.org/licenses/by/4.0/" };
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>${esc(s.currency)} to ${esc(r.currency)} today: 1 ${esc(s.currency)} = ${R.rateStr(ctx.mid)} ${esc(r.currency)}</h1>
<p class="lede">The mid-market rate for ${esc(sCur)} to ${esc(rCur)}${pairHasData ? `, and what actually arrives in ${esc(r.name)} when you send money from ${esc(s.short)} with the best service we checked on ${esc(dateLong)}` : `. No transfer service publishes online prices from ${esc(s.short)} to ${esc(r.name)} yet`}.</p>
${historyBlock}
<div class="converter" id="sf-conv" data-mid="${ctx.mid}" data-from="${s.currency}" data-to="${r.currency}">
  <label>Amount in ${esc(s.currency)} <input type="number" inputmode="decimal" min="0" step="any" value="${config.defaultAmounts[s.currency]}" id="sf-conv-in"></label>
  <div class="conv-out"><span class="k">At the mid-market rate</span><span class="v num" id="sf-conv-mid">${esc(plain(R.money(config.defaultAmounts[s.currency] * ctx.mid, r.currency)))}</span></div>
  <a class="btn" href="${link(prefix, corridorPath(s, r))}">See what arrives with each service</a>
</div>
<h2>What arrives in ${esc(r.name)} today</h2>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">You send</th><th scope="col" class="num">At mid-market</th><th scope="col" class="num">Best service gives</th><th scope="col">Service</th></tr></thead>
<tbody>${amts.map((a) => { const b = bestAt(a); return `<tr><th scope="row">${esc(plain(R.money(a, s.currency, a < 10 ? 2 : 0)))}</th><td class="num">${esc(plain(R.money(a * ctx.mid, r.currency)))}</td><td class="num top">${b ? esc(plain(R.money(b.gets, r.currency))) : "–"}</td><td>${b ? esc(b.p.name) : "No online prices"}</td></tr>`; }).join("")}</tbody>
</table></div>
<p class="note">"Best service gives" is for sending from ${esc(s.short)}, after fees and margins, using rates checked for ${esc(plain(R.money(ctx.amount, s.currency, 0)))}. For 1 ${esc(s.currency)}, a fixed fee can outweigh the transfer.</p>
<h2>${esc(s.currency)} to ${esc(r.currency)} rate history</h2>
${histChart(ctx)}
<h2>Mid-market rate vs the rate you get</h2>
<p>The mid-market rate above is the midpoint between what banks pay to buy and sell ${esc(rCur)} on the currency market. No transfer service gives exactly this rate for long: each adds a margin, and some also charge a fee. A service advertising "zero fees" can still cost more than one with a small fee, if its rate is lower. That is why SendFair ranks services by the amount that actually arrives in ${esc(r.name)}.</p>
<p>${s.region === "gulf" ? `The ${esc(sCur.replace(/s$/, ""))} is pegged to the US dollar, so day-to-day moves come from the ${esc(rCur.replace(/s$/, ""))} itself.` : `Both currencies float, so the rate moves through the day with the markets.`} Our copy of the mid-market rate is refreshed every few hours; service rates are updated through the day, so compare on the day you send.</p>
<p class="note">If this transfer is for a house, <a href="${link(prefix, `cost-to-build/${r.id}/`)}">see what it costs to build in ${esc(r.name)}</a>. SendFair compares transfer rates and house-build costs.</p>
<h2>Questions</h2>
${faqBlock(faqs)}
<h2>Send money from ${esc(s.short)} to ${esc(r.name)}</h2>
<p><a class="btn" href="${link(prefix, corridorPath(s, r))}">Compare all services for ${esc(s.label)} to ${esc(r.name)}</a></p>
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, og: slug(s, r), noindex: !pairHasData,
    title: `${s.currency} to ${r.currency} today: rate, 30-day history and best service | ${config.siteName}`,
    description: `${s.currency} to ${r.currency} today: 1 ${s.currency} = ${R.rateStr(ctx.mid)} ${r.currency}, the 30-day range and the best service for your amount. Checked ${dateLong}.`,
    jsonld: [faqLd(faqs), crumbs(trail), rateLd, dsLd],
    alternates: FR_RECEIVERS.has(r.id) ? [{ lang: "en", href: `${site}/${rel}` }, { lang: "fr", href: `${site}/${frRateRel(s, r)}` }, { lang: "x-default", href: `${site}/${rel}` }] : [],
    body }));
  if (pairHasData) urls.push(rel);
}

writeRatesIndex();

// Question pages from data/questions.json: only live entries with data at build time.
const questionDeps = { config, corridors, buildCosts, midmarket, quotes: quotesFile, providers, feed: wiseFeedData.routes, now: NOW, site, questions };
for (const q of questions) {
  if (q.status !== "live") continue;
  const data = questionPage(q, questionDeps);
  if (!data) { console.log(`Question skipped (no data): ${q.slug}`); continue; }
  write(data.canonical + "index.html", page({ prefix: data.prefix, canonical: data.canonical, title: data.title, description: data.description, jsonld: data.jsonld, body: data.body }));
  urls.push(data.canonical);
}
const questionsIdx = questionsIndex(questions, questionDeps);
write("questions/index.html", page({ prefix: "../", canonical: "questions/", title: questionsIdx.title, description: questionsIdx.description, jsonld: questionsIdx.jsonld, noindex: questionsIdx.noindex, body: questionsIdx.body }));
if (questionsIdx.liveCount) urls.push("questions/");

// Gulf guide: every Gulf route at a glance, and how the ways of sending compare (exchange houses, banks, wallets, apps, cash networks).
if (gulfSenders.length) {
  const rel = GULF_GUIDE, prefix = "../";
  const grid = gulfSenders.map((s) => ({ s, cells: corridors.receivers.map((r) => { const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]); return { r, ctx, top: ctx.rows.find((x) => !x.stale), lead: R.leaders(ctx.rows) }; }) }));
  // Cost against the mid-market rate for every fresh quote on a Gulf route, grouped by kind of service.
  const byType = {};
  for (const g of grid) for (const c of g.cells) for (const x of c.ctx.rows) {
    if (x.stale || x.cost == null) continue;
    const t = x.p.type || "app";
    (byType[t] = byType[t] || []).push({ cost: Math.max(0, x.cost), p: x.p, s: g.s, r: c.r, gets: x.gets });
  }
  const median = (a) => { const v = a.map((x) => x.cost).sort((m, n) => m - n); const h = Math.floor(v.length / 2); return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2; };
  const pct = (v) => (v * 100).toFixed(1) + "%";
  const gulfProv = Object.values(providers).filter((p) => (p.sendsFrom || []).some((id) => gulfSenders.some((x) => x.id === id)));
  const named = (t) => joinList(gulfProv.filter((p) => (p.type || "app") === t).map((p) => `${p.name} (${joinList(p.sendsFrom.filter((id) => gulfSenders.some((x) => x.id === id)).map((id) => corridors.senders.find((x) => x.id === id).label))})`));
  const ways = [
    ["exchange", "The counter most workers know: a licensed money exchange with branches in malls and labour areas, and usually an app too.", "Cash at the branch, or bank transfer and debit card in the app", "Bank, mobile money or cash pickup, through partners in Africa", "Ask for the total that arrives, not just the rate on the board. The rate at the counter and in the same company's app can differ."],
    ["bank", "The remittance arm of a bank, with its own centres and app.", "From your bank account, or cash at a remittance centre", "Bank deposit, mobile money or cash pickup, depending on the country", "You must register first. Some destinations go by SWIFT, which can take days and add charges on the receiving side."],
    ["wallet", "A phone wallet that can hold your salary and send it abroad through partner networks.", "From the wallet balance, often where the salary is paid", "Usually through Western Union, MoneyGram or similar partners: mobile money, bank or cash", "The partner network sets the rate, so the same wallet can be good to one country and poor to another."],
    ["app", "Online services built for sending money abroad, licensed in the Gulf country you send from.", "Local debit card or bank transfer", "Mobile money such as M-Pesa and MTN MoMo, or a bank account", "Each app works only from certain Gulf countries, and checks your ID on your phone before the first transfer."],
    ["network", "Western Union and MoneyGram, offered through exchange houses, banks and some apps.", "Cash at an agent, or online", "Cash pickup almost anywhere, plus mobile money and bank", "Handy when your family needs cash in a small town. Compare their fee and rate with the others first."]
  ];
  const costCell = (t) => { const a = byType[t] || []; if (!a.length) return "Being checked"; const best = a.reduce((m, x) => (x.cost < m.cost ? x : m)); return `${pct(median(a))} typical, from ${pct(best.cost)} (${esc(best.p.name)}, ${esc(best.s.label)} to ${esc(best.r.name)}); ${a.length} quote${a.length > 1 ? "s" : ""}`; };
  const ranked = Object.keys(byType).filter((t) => byType[t].length >= 2).sort((a, b) => median(byType[a]) - median(byType[b]));
  const cheapest = ranked.length ? `On the Gulf routes we checked on ${dateLong}, ${METHOD[ranked[0]].short.toLowerCase()} cost least, typically ${pct(median(byType[ranked[0]]))} of what you send against the mid-market rate${ranked.length > 1 ? `, and ${METHOD[ranked[ranked.length - 1]].short.toLowerCase()} the most (${pct(median(byType[ranked[ranked.length - 1]]))})` : ""}. The best single service still varies by route and amount, so open your route to compare.` : "We are checking rates on the Gulf routes now. Until the figures are in, the table below shows how each way of sending works.";
  const faqs = [
    ["What is the cheapest way to send money from the Gulf to Africa?", cheapest],
    ["Is hawala legal in the Gulf?", "Only registered or licensed providers may move money for others. In the UAE, hawala providers must hold a certificate from the Central Bank, and operating without one can bring fines and prison. Informal agents give no receipt and no refund if the money doesn't arrive, which is why we don't list them."],
    ["Do I pay tax on money I send home from the Gulf?", "No Gulf state taxes the money you send. VAT is added to the transfer fee in the UAE (5%), Oman (5%), Bahrain (10%) and Saudi Arabia (15%); Qatar and Kuwait have no VAT. The fees on SendFair include it."],
    ["What ID do I need to send money from the Gulf?", `Your residence ID: ${joinList(gulfSenders.map((x) => `${x.idDoc} in ${x.short}`))}. Apps check it on your phone; exchange houses and bank remittance centres check it at the counter.`],
    ["Can I send from the Gulf straight to M-Pesa or MTN Mobile Money?", "Yes. Most exchange houses, wallets and apps that serve Kenya, Uganda, Ghana and Zambia pay straight into mobile money wallets. Choose \"Mobile money\" on a route page to compare only those services."]
  ];
  const trail = [[config.siteName, ""], ["Sending from the Gulf", rel]];
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>Sending money from the Gulf to Africa: every way compared</h1>
<p class="lede">Exchange houses, bank remittance services, mobile wallets, transfer apps and cash networks, from ${esc(joinList(gulfSenders.map((x) => x.short)))} to ${esc(joinList(corridors.receivers.map((r) => r.name)))}. Ranked by what your family receives, checked by hand.</p>
<h2 id="best">Today's best from each Gulf country</h2>
<div class="table-wrap"><table class="rates-table gulf-grid">
<thead><tr><th scope="col">From</th>${corridors.receivers.map((r) => `<th scope="col" class="num">${esc(r.name)}</th>`).join("")}</tr></thead>
<tbody>${grid.map((g) => `<tr><th scope="row">${esc(g.s.label)}<span class="sub">${esc(plain(R.money(config.defaultAmounts[g.s.currency], g.s.currency, 0)))}</span></th>${g.cells.map((c) => `<td class="num"><a href="${link(prefix, corridorPath(g.s, c.r))}">${c.top ? `${esc(plain(R.money(c.top.gets, c.r.currency)))}<span class="sub">${esc(c.lead.length > 1 ? c.lead.length + "-way tie" : c.top.p.name)}</span>` : `${c.ctx.anyQuotes ? "Being rechecked" : "Apps only"}<span class="sub">${esc(g.s.currency)} to ${esc(c.r.currency)}</span>`}</a></td>`).join("")}</tr>`).join("")}</tbody>
</table></div>
<p class="note">Most that arrives for the amount shown, after fees (including VAT) and exchange-rate margins. Tap a cell to compare every service on that route.</p>
<h2 id="ways">How the ways of sending compare</h2>
<p>${esc(cheapest)}</p>
<div class="ways">${ways.map(([t, what, pay, arrive, watch]) => `<div class="way"><h3>${esc(METHOD[t].short)}</h3><p>${esc(what)}</p><dl>
<div><dt>On SendFair</dt><dd>${esc(named(t) || "–")}</dd></div>
<div><dt>You pay by</dt><dd>${esc(pay)}</dd></div>
<div><dt>It arrives as</dt><dd>${esc(arrive)}</dd></div>
<div><dt>Cost vs mid-market today</dt><dd>${costCell(t)}</dd></div>
<div><dt>Watch out for</dt><dd>${esc(watch)}</dd></div></dl></div>`).join("")}
<div class="way way-warn"><h3>Hawala and informal agents</h3><p>A trusted person takes your cash and a contact back home pays your family. It can look cheap, but there is no receipt, no refund and no protection if the money goes missing, and running it without a licence is illegal in the Gulf. We don't compare it, and we don't recommend it.</p></div>
</div>
<p class="note">"Cost vs mid-market" is the share of your money lost to the fee and the exchange-rate margin together, across the fresh quotes we checked on all Gulf routes for a typical amount. "Typical" is the middle quote.</p>
<h2 id="where">Which services work from which country</h2>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">Service</th><th scope="col">Kind</th>${gulfSenders.map((x) => `<th scope="col">${esc(x.label)}</th>`).join("")}</tr></thead>
<tbody>${Object.keys(METHOD).flatMap((t) => gulfProv.filter((p) => (p.type || "app") === t)).map((p) => `<tr><th scope="row">${esc(p.name)}</th><td>${esc(METHOD[p.type || "app"].name)}</td>${gulfSenders.map((x) => `<td>${(p.sendsFrom || []).includes(x.id) ? "✓" : ""}</td>`).join("")}</tr>`).join("")}</tbody>
</table></div>
<p class="note">From each service's published list of sending countries. Not every service pays out in every African country; route pages show only the ones we found when checking. Know a service we should add? Email <span class="email">${esc(config.contactEmail)}</span>.</p>
<h2 id="tips">Good to know</h2>
<ul class="tips">${[...TIPS_FROM.gulf, "If your salary is paid onto a wage card or wallet, check whether it can send abroad directly. It saves withdrawing cash and paying again at the counter.", "Exchange houses set daily limits per person. For a large amount, an app or bank transfer to a bank account is usually simpler."].map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
<h2 id="faq">Questions</h2>
${faqBlock(faqs)}
<h2>Every Gulf route</h2>
${gulfSenders.map((x) => `<h3>From ${esc(x.short)}</h3><ul class="route-links">${corridors.receivers.map((r) => `<li><a href="${link(prefix, corridorPath(x, r))}">${esc(x.label)} to ${esc(r.name)}</a></li>`).join("")}</ul>`).join("")}
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, og: "gulf",
    title: `Send money from the Gulf to Africa: every way compared`,
    description: `Compare ways to send money from the UAE, Saudi Arabia, Qatar, Kuwait, Bahrain and Oman to Africa: exchange houses, bank remittance services, wallets, apps and cash networks, ranked by what arrives.`,
    jsonld: [faqLd(faqs), crumbs(trail)], body }));
  urls.push(rel);
}

// Trust pages
const hasAffiliate = Object.values(providers).some((p) => p.affiliateUrl);
const hasAds = !!config.adsenseClient;
const today = new Date(NOW).toISOString().slice(0, 10);
const privacyItems = [
  `<li><strong>Your comparison choices.</strong> Your route, amount and payout choice are saved only in your own browser so the tool remembers them. They are not sent to us.</li>`,
  config.newsletterFormAction ? `<li><strong>Email for rate alerts.</strong> If you sign up, your email address is stored by ${esc(config.emailProvider || "our email service")} to send the alerts. Every message has an unsubscribe link.</li>` : "",
  `<li><strong>Rate alerts.</strong> If you set a rate alert, we store your email address, the route, the amount and your target, so we can email you when it is reached. We send one confirmation email first and nothing else. Each alert is deleted once it fires, when you click the remove link in any of our emails, or after 12 months. Emails are sent by our email provider. To limit misuse we keep a one-way scrambled code made from your connection for two days.</li>`,
  `<li><strong>WhatsApp rate bot.</strong> If you message our WhatsApp number, we keep a one-way hash of your number and the alerts you ask for (route, amount and target). While an alert is active we also keep the number itself, because Meta needs it to deliver that message; sending "stop" deletes the number and the alerts. We reply only to messages you send, inside WhatsApp's 24-hour service window, and never send marketing broadcasts.</li>`,
  config.reportsEnabled ? `<li><strong>Delivery-time reports.</strong> When you report how long a transfer took, we store the route, the service and the time range only. To stop repeated reports we keep a one-way hash made from your connection for two days; it cannot be turned back into your IP address.</li>` : "",
  config.trackClicks ? `<li><strong>Link clicks.</strong> We count how many times each "Go to" button is clicked on each route. The count is not linked to you.</li>` : "",
  config.impactScriptId ? `<li><strong>Affiliate tracking.</strong> If you accept optional cookies, our pages load a script from Impact, an affiliate network some providers use. It records when a page is viewed and when you follow a link to a provider, so the provider can credit us if you sign up. It does not change the ranking.</li>` : "",
  config.cfAnalyticsToken ? `<li><strong>Visit statistics.</strong> We use Cloudflare Web Analytics, which counts visits without cookies and without building a profile of you.</li>` : "",
  hasAds ? `<li><strong>Advertising.</strong> Some pages show ads from Google. Google's advertising script loads only after you accept optional cookies, so visitors in the UK and Europe are asked for consent before Google uses cookies for personalised ads. You can change your choice at any time from the Cookie settings link in the footer, and manage ads at adssettings.google.com.</li>` : "",
  `<li><strong>Translation.</strong> If you choose a language from the Language button, the page is translated by Google Translate. Your browser then loads Google's translation script and sends the page's text to Google, and a cookie (googtrans) remembers your language. Nothing is sent to Google unless you choose a language.</li>`,
  `<li><strong>Search and saved guides on this device.</strong> Search words, saved guides and which guides you opened stay in this browser. They are not sent to SendFair.</li>`,
  `<li><strong>Page speed on this device.</strong> The browser can note how fast the last page felt. That note stays on the device. It is not a published traffic report, and it is not a 75th-percentile field measurement.</li>`,
  (config.ga4MeasurementId || config.gtmContainerId || config.clarityProjectId) ? `<li><strong>Optional analytics.</strong> If you accept optional cookies, Google Analytics and Microsoft Clarity load. Clarity records how visitors move around the site to help us improve it. They stay off when you choose essential only, and they are not loaded while their IDs are blank.</li>` : "",
  `<li><strong>Offline copies and logos.</strong> Your browser keeps a copy of the pages you open on SendFair so they still load without a connection; this stays on your device. Service logos are fetched by our server from each provider's public website, so your browser only ever connects to sendfair.africa for them.</li>`,
  `<li><strong>Hosting.</strong> The site is hosted by Cloudflare, which processes basic technical data (such as IP address) to deliver pages and protect against abuse.</li>`,
  `<li><strong>Quote Check (paid quote review).</strong> If you use <a href="${link("../", "quote-check/")}">Quote Check</a>, we store the files you upload, the country, town, house details, quote currency, your email address, and the line items extracted from the quote. We use them to read the quote, match it to our published prices, produce the report and email it to you. The file is processed by our AI extraction provider, the payment by our payment provider, and the report email by our email provider. We keep the payment reference, amount and status, but never your card details. Uploaded files, extracted data and reports are deleted ${QC.retentionDays} days after the report; payment records are kept for accounting and tax. Our legal bases are performance of the contract (producing the report you paid for), legitimate interests (preventing fraud and improving the service), and consent where the law requires it. For Kenya this is processed under the Data Protection Act 2019; for UK and European users, UK GDPR and GDPR apply. You can ask for a copy, correction or deletion through the contact page.</li>`
].filter(Boolean).join("");

const trust = {
  "about/": ["About SendFair", "Who runs SendFair, how the transfer comparison and the house-cost calculator work, and why the site is independent and free to use.", `
<h1>About SendFair</h1>
<p>Sending money home is one of the most regular bills in a diaspora household, and one of the least transparent. A transfer that says "zero fees" can still lose several percent in the exchange rate. A lot of that money is meant for a house, and a contractor's lump sum is just as hard to check.</p>
<p>SendFair does two things, side by side. It shows how much of a transfer actually lands at home, and it prices a simple house in the country you send to, line by line — materials, trade days, finish and the building permit. We cover the routes most used by Africans sending from the United States, the United Kingdom, Europe, Canada and Australia to ${esc(joinList(corridors.receivers.map((r) => r.name)))}.</p>
<h2>Cost to build a house back home</h2>
<p>The <a href="${link("../", "cost-to-build/")}">house calculator</a> prices the structure, the finish, the plot works and the building permit: cement, steel, blocks, roof sheets, windows, doors, floor and wall tiles, a framed ceiling, paint, kitchen cupboards, wardrobes, wiring, plumbing, a basin, a shower, a sink, a septic tank, a boundary wall, a gate, the trade days, and the permit fee published for that country. Materials use the same quantities everywhere. The permit keeps that country's own tariff. On each line you can switch to another published type, or to the ends of a published price range, and the total follows what you pick. Land and the contractor's fee are not included. Every line shows a quantity, so a round sum can be checked against receipts. Prices are refreshed monthly.</p>
<p>SendFair is run by ${esc(config.legalName || config.businessName || config.siteName)}${config.founderName ? `, founded by ${esc(config.founderName)}` : ""}, independently from Nairobi, Kenya. We are not owned by any transfer company.</p>
<h2>Who's behind SendFair</h2>
<p>${config.founderName ? `SendFair was founded by ${esc(config.founderName)} to make the true cost of sending money home easy to compare. ` : ""}${esc(config.legalName || config.businessName || config.siteName)} runs the site, checks the rates and handles corrections.</p>
<h2>How the numbers are made</h2>
<p>Quotes for the big providers are updated automatically every 30 minutes from Wise's comparison data; ${handCheckedRoutes === 0 ? "every price is collected automatically" : `the rest are read by hand from each provider's own calculator or app, for a typical amount on each route`}. Every quote is saved with the time it was checked. Each row on a route page shows when it was checked, and quotes that are too old are marked or removed. The full method is on <a href="${link("../", "methodology/")}">How we rank</a>.</p>
<h2>Editorial independence</h2>
<p>Services are ranked only by how much your family receives. Some providers pay us a referral commission, but no provider can pay to appear, to rank higher or to have a quote removed, and services that pay us nothing are listed on the same terms. See <a href="${link("../", "disclosure/")}">how we make money</a>.</p>
<h2>Corrections</h2>
<p>If a figure here doesn't match what a provider shows you, tell us with the route, the amount and a screenshot if you can. We recheck it and fix the page, usually the same day.</p>
<h2>Contact</h2><p>Corrections, partnership enquiries and provider updates: <a href="${link("../", "contact/")}">the contact page</a>.</p>`],
  "methodology/": ["How we rank", "How SendFair ranks transfers by the amount that arrives, where the quotes come from, and how the house-cost estimate is built.", `
<h1>How we rank</h1>
<h2>What we collect</h2>
<ul><li>The exchange rate each provider quotes on each route, and the amount we checked it for.</li><li>The transfer fee: a fixed amount, a percentage, or both.</li><li>The ways the money can be received (mobile money, bank, cash pickup). Where a provider's rate differs by payout method, we record each one separately.</li><li>The typical delivery time and when we checked.</li></ul>
<p>Quotes come from two sources. For Wise, Remitly, Western Union, WorldRemit, MoneyGram and some others, rates and fees are updated automatically every 30 minutes from Wise's comparison data, which collects each provider's advertised rate and fee from their websites. Those rows are marked "(auto)". ${handCheckedRoutes === 0 ? "No routes are checked by hand at the moment: every price comes from Wise's comparison data or from WorldRemit's own website." : `Other services are checked by hand from the provider's public calculator or app, busy routes every day and quieter ones at least every two days. A hand check made in the last 30 hours always takes priority over automatic data.`} Automatic rates far from the mid-market rate are held back as likely errors.</p>
<h2>How the amount received is calculated</h2>
<p>You enter the total you plan to pay. We take off the provider's fee and convert the rest at the provider's rate. Where the fee is a percentage, it is worked out on the amount sent.</p>
<p>Total cost is the gap between that and converting your full amount at the mid-market rate with no fee.</p>
<p>In the Gulf, VAT is charged on transfer fees in the UAE (5%), Oman (5%), Bahrain (10%) and Saudi Arabia (15%). We record fees there including VAT, because that is what you pay.</p>
<h2>Freshness</h2>
<ul><li>A quote older than ${staleH} hours is marked "Not rechecked today", ranks below fresh quotes, and never gets the "Most money home" label.</li><li>A quote older than ${hideH} hours is removed from the ranking until it is checked again.</li><li>Mid-market reference rates come from ExchangeRate-API's free service, which updates once a day. We refresh our copy every few hours.</li></ul>
<h2>What can differ on the provider's site</h2>
<ul><li>Rates move during the day.</li><li>Fees and rates can change with the amount, the payment method (bank transfer, debit or credit card) and the payout method. If you enter an amount far from the one we checked, we show a warning.</li><li>First-transfer promotions are excluded unless noted, because they apply only once.</li></ul>
<h2>Delivery times from senders</h2><p>Where at least three senders have reported how long a transfer took on a route in the last two months, we show the most common answer.</p>
<h2>Regional benchmark</h2>
<p>We show what the same transfer would deliver at ${config.regionalAverageCost.percent}% total cost, the ${esc(config.regionalAverageCost.label)}, from the <a href="https://remittanceprices.worldbank.org/" rel="noopener" target="_blank">World Bank's Remittance Prices Worldwide</a> report. The World Bank measures the same things we do — the fee, the exchange-rate margin and delivery speed — but quarterly, at fixed $200 and $500 amounts; we show the same comparison live, for whatever amount you type.</p>
<h2>Commissions never change the order</h2><p>Results are sorted only by the amount received. See <a href="${link("../", "disclosure/")}">how we make money</a>.</p>
<h2>The house estimate</h2>
<p>The <a href="${link("../", "cost-to-build/")}">cost to build a house</a> is a separate check. It is not a transfer rate. Quantities are for a simple rectangular house. Where a shop list publishes more than one type, the page lets you choose, and the total changes. A listed price is a published figure. A guide is scaled from another country's figure at the mid-market rate, or assumes how much a box, sheet or load covers. Land and the contractor's fee are left out of the receipt. A published whole-house band, where we have one, is shown beside the receipt and includes a contractor. A 10% contingency, a contractor margin where one is published, and the architect's fee can be shown under the receipt and stay out of it until you include them. Economy and luxury change the finish lines only. A steep or distant plot adds a planning allowance to sand and ballast, and a soil test is still required. The finish is in, and so are a septic tank, kitchen cupboards, a wardrobe in each bedroom, a boundary wall, a gate and the building permit published for that country. An architect's professional fee is not a permit and is not included. The wall length is a usual plot for that number of bedrooms, and the same length is used for one floor or two. It is not a structural design.</p>`],
  "disclosure/": ["How we make money", "How SendFair makes money: referral commissions and advertising, and why neither changes the ranking, which is sorted only by how much arrives.", `
<h1>How we make money</h1>
<p>SendFair is free to use. We earn money in two ways:</p>
<ul><li><strong>Referral commissions.</strong> ${hasAffiliate ? 'Some "Go to" buttons are affiliate links. If you open an account and make your first transfer, the provider may pay us a fee. You pay the same either way.' : 'We intend to earn a referral commission from some providers when you sign up through us. Those affiliate links are being added as each provider approves us, and you never pay more.'}</li>${hasAds ? `<li><strong>Advertising.</strong> Some pages show ads served by Google. Ads are labelled as ads, are never placed inside the ranking, and advertisers cannot choose or influence where a service ranks.</li>` : `<li><strong>Advertising.</strong> We don't show ads at the moment. If we ever do, they will be labelled, kept out of the ranking, and this page will say so.</li>`}</ul>
<p>Neither affects the ranking. Results are sorted only by how much your recipient receives. Providers that pay us nothing appear and rank on the same terms.</p>
<ul><li><strong>Sponsored listings.</strong> Builders, suppliers, SACCOs and banks can pay for a listing under the house calculator for a country. Each one is labelled Sponsored, sits outside the receipt and never changes a price, a quantity or the total. Sponsors never appear in the transfer rankings. See <a href="${link("../", "advertise/")}">advertise on SendFair</a>.</li><li><strong>Travel links.</strong> ${(partners.travel || {}).flightsWrap || (partners.travel || {}).esimWrap ? "Some flight and eSIM links on the flying-home pages are affiliate links. If you book, we may earn a commission at no extra cost to you." : "The flight and eSIM links on the flying-home pages open the search sites directly and earn us nothing at the moment. If that changes, the links will be marked and this page will say so."}</li></ul>
<p>The receipt itself is not paid for by a supplier or a contractor. Choosing a roof sheet, a door or a tile does not earn us a fee.</p>`],
  "privacy/": ["Privacy policy", "How SendFair handles personal data: the little it collects, mostly an email if you set a rate alert, your rights, and how to contact us.", `
<h1>Privacy policy</h1>
<p>Last updated ${today}.</p>
<h2>What we collect and why</h2>
<ul>${privacyItems}</ul>
<h2>WhatsApp</h2>
<p>If you use the WhatsApp rate bot, the same rules apply: a one-way hash of your number, the alerts you ask for, and the number itself only while an alert is active so we can deliver it. Sending "stop" deletes both. We reply only inside WhatsApp's 24-hour service window and never send marketing broadcasts.</p>
<h2>Your rights</h2>
<p>If you are in the UK or Europe, data protection law gives you the right to ask what we hold about you, to have it corrected or deleted, and to object to its use. You can also complain to your data protection authority (the ICO in the UK). In practice we hold very little: usually only your email address, if you signed up for alerts.</p>
<h2>Links to providers</h2><p>When you follow a link to a transfer service, that service's own privacy policy applies.</p>
<h2>Contact</h2><p>For any privacy request, use <a href="${link("../", "contact/")}">the contact page</a>.</p>`],
  "terms/": ["Terms of use", "Who runs SendFair, what the site is and isn't, that it's not financial advice, that rates change, and the law that governs these terms.", `
<h1>Terms of use</h1>
<p>Last updated ${today}.</p>
<p>SendFair provides information to help you compare money transfer services, and an estimate of what it costs to build a simple house back home. It is not financial advice, we are not a money transfer business, and the house figure is not a contractor's quote.</p>
<p>The house estimate leaves out land, the contractor's fee and several other costs named on that page. Material menus use published types and published ranges. A guide is not a shop receipt. Always check the current price at the yard before you buy or send.</p>
<h2>Quote Check</h2>
<p>Quote Check is a paid comparison of a builder's quote with our published local prices. It is not a valuation, quantity survey, structural design or guarantee of workmanship. The one-off fee is shown before payment, and the free preview comes first. If we cannot produce a report after payment, we refund the fee. You confirm that you have the right to upload the quote and that it does not contain another person's private information. We may refuse or refund an order that cannot be read. A report link is private to you; do not publish it. Card payments are handled by our payment provider under its own terms. Uploaded files, extracted data and reports are deleted ${QC.retentionDays} days after the report, as described in the privacy policy.</p>
<p>We work to keep rates accurate, but they change through the day and can differ on the provider's site. Always confirm the final amount, fee and delivery time with the provider before paying. We are not responsible for transfers you make with any provider, or for losses from relying on a rate shown here.</p>
<p>Delivery-time reports come from other visitors and are shown as they are given.</p>
<p>Provider names belong to their owners. Their appearance here does not mean they endorse SendFair.</p>${config.legalName || config.companyNumber || config.legalAddress || config.governingLaw ? "<p>" + esc(config.legalName || config.siteName) + (config.companyNumber ? ", company number " + esc(config.companyNumber) : "") + (config.legalAddress ? ", " + esc(config.legalAddress) : "") + "." + (config.governingLaw ? " These terms are governed by " + esc(config.governingLaw) + " law." : "") + "</p>" : ""}`],
  "cookies/": ["Cookie policy", "How SendFair uses cookies: which are essential, which are optional for analytics, ads and affiliate tracking, and how to change your choice.", `
<h1>Cookie policy</h1>
<p>SendFair uses a small number of cookies and similar technologies. You can accept or refuse the optional ones from the banner on your first visit, and change your choice at any time from the "Cookie settings" link in the footer.</p>
<h2>Essential (always on)</h2>
<p>These are needed for the site to work: a note of your consent choice (so we do not ask again), and, only if you pick a language, a Google Translate cookie (googtrans) that remembers it.</p>
<h2>Optional (only if you accept)</h2>
<ul><li>Google Analytics and Microsoft Clarity, to understand how the site is used. Clarity also records how visitors move around the site.</li><li>Google advertising, to show ads, and Impact, an affiliate network that lets a provider credit us for a sign-up.</li></ul>
<p>Each of those services has its own privacy policy. You can compare rates without the optional ones.</p>`],
  "accessibility/": ["Accessibility", "How SendFair is built to be accessible: clear headings, keyboard navigation, labelled controls and screen-reader support, and how to report problems.", `
<h1>Accessibility</h1>
<p>We want SendFair to work for everyone, including people who use a screen reader, keyboard-only navigation or other assistive technology.</p>
<h2>What we do</h2>
<ul><li>Every page has one clear heading, a "skip to content" link, and text alternatives for images.</li><li>All controls can be used with a keyboard and are labelled.</li><li>Rates are given as text, not only colour.</li><li>Text is styled for strong contrast.</li></ul>
<h2>Tell us</h2>
<p>If something is hard to use, email <span class="email">${esc(config.contactEmail)}</span> and we will try to fix it.</p>`],
  "contact/": ["Contact SendFair", "How to contact SendFair to correct a rate, make a privacy request, report a provider update, or ask about a partnership.", `
<h1>Contact</h1>
<p>Email <span class="email">${esc(config.contactEmail)}</span>. That is the address for a wrong rate, a privacy request, a provider update and a partnership enquiry.</p>
<h2>A rate that does not match</h2>
<p>Send the route, the amount, the payout method and a screenshot of the provider's screen. The quote is rechecked, usually the same day. The <a href="${link("../", "guides/send-money/when-a-quote-looks-wrong/")}">guide on a wrong quote</a> lists what to include.</p>
<h2>Privacy</h2>
<p>A request to see, correct or delete what we hold goes to the same address. The <a href="${link("../", "privacy/")}">privacy policy</a> says how little is stored.</p>
<h2>Who replies</h2>
<p>${esc(config.legalName || config.businessName || config.siteName)} runs the site from Nairobi. SendFair does not send money and does not build houses.</p>`,
    [{ "@context": "https://schema.org", "@type": "ContactPage", name: "Contact SendFair", url: `${site}/contact/`, description: "Email SendFair about a rate, a privacy request or a provider update." }]]
};
for (const [rel, [title, desc, html, extraLd]] of Object.entries(trust)) {
  write(rel + "index.html", page({ prefix: "../", canonical: rel, rank: false, title: `${title} · ${config.siteName}`, description: desc, jsonld: extraLd || [], body: `<section class="block page"><div class="wrap"><article class="prose">${insertContentAds(html)}</article></div></section>` }));
  urls.push(rel);
}
writeGuides();

write("offline.html", page({ prefix: "/", canonical: null, rank: false, title: `You're offline · ${config.siteName}`, description: "No connection.", noindex: true, body: `<section class="block page"><div class="wrap"><article class="prose"><h1>You're offline</h1><p>SendFair needs a connection to show today's rates. A page you already opened can still appear, with the figures from that visit, not a new check.</p><p><a class="btn" href="/">Try again</a></p></article></div></section>` }));
write("404.html", page({ prefix: "/", canonical: null, rank: false, title: `Page not found · ${config.siteName}`, description: "Page not found.", noindex: true, body: `<section class="block page"><div class="wrap"><article class="prose"><h1>That page isn't here</h1><p>The link may be old or mistyped.</p><p><a class="btn" href="/">Compare transfers</a> <a class="btn" href="/cost-to-build/">Cost to build a house</a></p></article></div></section>` }));

// Rate Desk (never indexed)
fs.mkdirSync(path.join(OUT, "admin"), { recursive: true });
fs.writeFileSync(path.join(OUT, "admin/index.html"), fs.readFileSync(path.join(ROOT, "src/admin.html"), "utf8").replace(/assets\/fonts\.css(?!\?)/g, `assets/fonts.css?v=${V.fonts}`).replace(/assets\/rank\.js(?!\?)/g, `assets/rank.js?v=${V.rank}`));
fs.mkdirSync(path.join(OUT, "admin/quote-checks"), { recursive: true });
fs.writeFileSync(path.join(OUT, "admin/quote-checks/index.html"), fs.readFileSync(path.join(ROOT, "src/quote-check-admin.html"), "utf8"));

// SEO and hosting files
writeBuildPages();
writeFlyingHome();
writeAdvertisePage();
writeEmbedPage();
writeReports();
writeFrenchPages();

function inlineLinks(prefix, text) {
  const safe = esc(text);
  return safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const external = href.startsWith("http");
    const url = external ? esc(href) : link(prefix, href.replace(/^\//, ""));
    const extra = external ? ' target="_blank" rel="noopener"' : "";
    return `<a href="${url}"${extra}>${label}</a>`;
  });
}
function guideTeaser(prefix) {
  let guides;
  try { guides = read("data/guides.json"); } catch { return ""; }
  return `<section class="block" id="guides"><div class="wrap">
<div class="section-head"><h2>Guides</h2><p class="lede">Short explanations next to the live comparison and the house calculator. The route page is the current check. A guide is how to read it.</p></div>
<div class="guide-grid">${guides.pillars.map((p) => `<a class="guide-card" href="${link(prefix, `guides/${p.slug}/`)}"><span class="k">Guide</span><strong>${esc(p.title)}</strong><span class="s">${esc(p.description)}</span></a>`).join("")}</div>
</div></section>`;
}
function tagLabel(tag) {
  const names = { uk: "UK", us: "US" };
  return names[tag] || tag.charAt(0).toUpperCase() + tag.slice(1);
}
function guideLive(article) {
  if (!article || article.status === "draft") return false;
  if (article.publishAt && article.publishAt > today) return false;
  return true;
}
function writeGuides() {
  const guides = read("data/guides.json");
  const authors = guides.authors || [{ slug: "sendfair", name: "SendFair", bio: "SendFair is written by Continental Flow Ltd in Nairobi." }];
  const authorOf = (slug) => authors.find((a) => a.slug === slug) || authors[0];
  const articleLd = (item, rel) => {
    const author = authorOf(item.author);
    return {
      "@context": "https://schema.org", "@type": "Article", headline: item.seoTitle || item.title, description: item.seoDescription || item.description,
      dateModified: item.updated, datePublished: item.updated,
      author: { "@type": "Organization", name: author.name, url: `${site}/guides/author/${author.slug}/` },
      publisher: { "@type": "Organization", name: config.siteName, url: site + "/" }, mainEntityOfPage: `${site}/${rel}`
    };
  };
  const subBlocks = (parts, prefix, level) => (parts || []).map((part) => {
    const heading = level === 4 ? `<h4>${esc(part.h)}</h4>` : `<h3>${esc(part.h)}</h3>`;
    const paras = (part.paragraphs || []).map((p) => `<p>${inlineLinks(prefix, p)}</p>`).join("");
    return heading + paras + (level === 3 ? subBlocks(part.points, prefix, 4) : "");
  }).join("");
  const guideShare = (urlPath, title) => {
    const url = `${site}/${urlPath}`;
    const u = encodeURIComponent(url);
    const text = encodeURIComponent(title);
    return `<div class="share"><a href="https://wa.me/?text=${encodeURIComponent(title + " " + url)}" target="_blank" rel="noopener">WhatsApp</a><a href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener">Facebook</a><a href="https://www.linkedin.com/sharing/share-offsite/?url=${u}" target="_blank" rel="noopener">LinkedIn</a><a href="https://twitter.com/intent/tweet?url=${u}&text=${text}" target="_blank" rel="noopener">X</a><a href="mailto:?subject=${text}&body=${u}">Email</a><button type="button" data-copy="${esc(url)}">Copy link</button><button type="button" data-save="${esc(urlPath)}" data-title="${esc(title)}">Save</button><span class="share-msg" aria-live="polite"></span></div>`;
  };
  const newsForm = () => config.newsletterFormAction ? `<form class="news-form" action="${esc(config.newsletterFormAction)}" method="post"><h2>Morning rate</h2><p>One email. We ask you to confirm the address before the first message. Unsubscribe in every message.</p>${String(config.newsletterFormAction).includes("embed-subscribe") ? `<input type="hidden" name="embed" value="1">` : ""}<label class="label" for="sf-news-email">Email</label><input id="sf-news-email" name="email" type="email" required autocomplete="email"><button type="submit">Send me the rate</button></form>` : "";
  const render = (item, prefix, crumbsItems, siblings) => {
    const isArticle = !!item.pillar;
    const steps = (item.steps || []).length ? `<h2 id="steps">Steps</h2><ol class="howto">${item.steps.map((s) => `<li><h3>${esc(s.name)}</h3><p>${esc(s.text)}</p></li>`).join("")}</ol>` : "";
    const sections = (item.sections || []).map((s) => `<h2 id="${esc(s.id)}">${esc(s.h)}</h2>${(s.paragraphs || []).map((p) => `<p>${inlineLinks(prefix, p)}</p>`).join("")}${subBlocks(s.subs, prefix, 3)}`).join("");
    const more = siblings.length ? `<h2 id="related">Related guides</h2><ul class="route-links">${siblings.map((s) => `<li><a href="${link(prefix, s.href)}">${esc(s.title)}</a></li>`).join("")}</ul>` : "";
    const faqs = item.faq || [];
    const faqHtml = faqs.length ? `<h2 id="questions">Questions</h2>${faqBlock(faqs)}` : "";
    const author = isArticle ? authorOf(item.author) : null;
    const byline = author ? `<p class="note">By <a href="${link(prefix, `guides/author/${author.slug}/`)}">${esc(author.name)}</a>. Updated ${esc(item.updated || "")}.</p>` : "";
    const tags = isArticle && (item.tags || []).length ? `<p class="tag-row">${item.tags.map((t) => `<a href="${link(prefix, `guides/tag/${t}/`)}">${esc(tagLabel(t))}</a>`).join("")}</p>` : "";
    const share = isArticle ? guideShare(crumbsItems[crumbsItems.length - 1][1], item.title) : "";
    const tocItems = [
      ...(item.steps && item.steps.length ? [["steps", "Steps"]] : []),
      ...(item.sections || []).map((s) => [s.id, s.h]),
      ...(siblings.length ? [["related", "Related"]] : []),
      ...(faqs.length ? [["questions", "Questions"]] : [])
    ];
    const toc = tocItems.length > 1 ? `<nav class="secnav" aria-label="On this page"><div class="wrap">${tocItems.map(([id, label]) => `<a href="#${esc(id)}">${esc(label)}</a>`).join("")}</div></nav>` : "";
    const html = `${crumbNav(prefix, crumbsItems)}<h1>${esc(item.title)}</h1>${byline}${tags}<p class="lede">${inlineLinks(prefix, item.lede || "")}</p>${share}${steps}${sections}${isArticle ? newsForm() : ""}${more}${faqHtml}`;
    const rel = crumbsItems[crumbsItems.length - 1][1];
    const ld = [articleLd(item, rel), crumbs(crumbsItems)];
    if (item.steps && item.steps.length) ld.push(howToLd(item.seoTitle || item.title, item.seoDescription || item.description, item.steps));
    if (faqs.length) ld.push(faqLd(faqs));
    return { html: insertContentAds(html), ld, rel, toc };
  };
  const live = (guides.articles || []).filter(guideLive);
  const relatedOf = (article) => {
    const tags = new Set(article.tags || []);
    const scored = live.filter((a) => a.slug !== article.slug).map((a) => ({
      a, score: (a.tags || []).filter((t) => tags.has(t)).length + (a.pillar === article.pillar ? 0.25 : 0)
    })).filter((x) => x.score >= 1).sort((a, b) => b.score - a.score || String(b.a.updated).localeCompare(String(a.a.updated)));
    const picks = (scored.length ? scored.slice(0, 4).map((x) => x.a) : live.filter((a) => a.pillar === article.pillar && a.slug !== article.slug).slice(0, 4));
    const pillar = guides.pillars.find((p) => p.slug === article.pillar);
    return [{ href: `guides/${article.pillar}/`, title: pillar ? pillar.title : "Guide" }].concat(picks.map((a) => ({ href: `guides/${a.pillar}/${a.slug}/`, title: a.title })));
  };
  const indexRel = "guides/";
  const pillarCards = guides.pillars.map((p) => `<a class="guide-card" href="${link("../", `guides/${p.slug}/`)}"><span class="k">Guide</span><strong>${esc(p.title)}</strong><span class="s">${esc(p.lede)}</span></a>`).join("");
  const latest = live.slice().sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, 6);
  const mentions = {};
  const linkRe = /\]\((\/[^)]+)\)/g;
  const rawGuides = JSON.stringify(live);
  let found;
  while ((found = linkRe.exec(rawGuides))) mentions[found[1]] = (mentions[found[1]] || 0) + 1;
  const mentioned = Object.entries(mentions).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const latestHtml = `<h2>Recently updated</h2><ul class="route-links">${latest.map((a) => `<li><a href="${link("../", `guides/${a.pillar}/${a.slug}/`)}">${esc(a.title)}</a> <span class="note">${esc(a.updated || "")}</span></li>`).join("")}</ul>`;
  const linkedHtml = mentioned.length ? `<h2>Linked from the guides</h2><p class="note">Counted from links written in the guides. This is not a most-read list.</p><ul class="route-links">${mentioned.map(([href, n]) => `<li><a href="${link("../", href.replace(/^\//, ""))}">${esc(href)}</a> <span class="note">${n} link${n === 1 ? "" : "s"}</span></li>`).join("")}</ul>` : `<h2>Linked from the guides</h2><p>None of the guides link to another guide yet. They point at the comparison and the calculator.</p>`;
  const savedHtml = `<div id="sf-saved" hidden><h2>Saved on this device</h2><ul class="route-links" id="sf-saved-list"></ul></div>`;
  write(indexRel + "index.html", page({
    prefix: "../", canonical: indexRel, rank: false, title: `Guides · ${config.siteName}`,
    description: "Guides that explain how to compare a transfer by the amount that arrives and how to read the house-cost calculator.",
    jsonld: [crumbs([[config.siteName, ""], ["Guides", indexRel]])],
    body: `<section class="block page"><div class="wrap"><article class="prose wide">${insertContentAds(`${crumbNav("../", [[config.siteName, ""], ["Guides", indexRel]])}<h1>Guides</h1><p class="lede">Two subjects: comparing a transfer by the amount that arrives, and checking what a house back home costs to build. Each article links to the live page that holds the current figures.</p>${savedHtml}<div class="guide-grid">${pillarCards}</div>${latestHtml}${linkedHtml}`)}</article></div></section>`
  }));
  urls.push(indexRel);
  for (const pillar of guides.pillars) {
    const children = live.filter((a) => a.pillar === pillar.slug);
    const rel = `guides/${pillar.slug}/`;
    const built = render({ ...pillar, sections: pillar.sections.concat([{ id: "articles", h: "Articles", paragraphs: ["Open the article that matches the question you have. The calculator or the route page next to it is the current figure."] }]) }, "../../", [[config.siteName, ""], ["Guides", "guides/"], [pillar.title, rel]], []);
    const list = `<ul class="route-links">${children.map((a) => `<li><a href="${link("../../", `guides/${pillar.slug}/${a.slug}/`)}">${esc(a.title)}</a></li>`).join("")}</ul>`;
    write(rel + "index.html", page({
      prefix: "../../", canonical: rel, rank: false, title: `${pillar.seoTitle || pillar.title} · ${config.siteName}`, description: guideDescription(pillar),
      jsonld: built.ld, body: `${built.toc}<section class="block page"><div class="wrap"><article class="prose wide">${built.html}${list}</article></div></section>`
    }));
    urls.push(rel);
    for (const article of children) {
      const aRel = `guides/${pillar.slug}/${article.slug}/`;
      const pageBuilt = render(article, "../../../", [[config.siteName, ""], ["Guides", "guides/"], [pillar.title, rel], [article.title, aRel]], relatedOf(article));
      const ogName = article.og || `guide-${article.pillar}-${article.slug}`;
      write(aRel + "index.html", page({
        prefix: "../../../", canonical: aRel, rank: false, og: ogName, ogType: "article",
        title: `${article.seoTitle || article.title} · ${config.siteName}`, description: guideDescription(article),
        jsonld: pageBuilt.ld, body: `${pageBuilt.toc}<section class="block page"><div class="wrap"><article class="prose" data-guide="${esc(article.slug)}" data-tags="${esc((article.tags || []).join(","))}">${pageBuilt.html}</article></div></section>`
      }));
      urls.push(aRel);
    }
  }
  const tagSet = [...new Set(live.flatMap((a) => a.tags || []))].sort();
  for (const tag of tagSet) {
    const rel = `guides/tag/${tag}/`;
    const rows = live.filter((a) => (a.tags || []).includes(tag));
    write(rel + "index.html", page({
      prefix: "../../../", canonical: rel, rank: false, noindex: true, title: `${tagLabel(tag)} · Guides · ${config.siteName}`,
      description: `SendFair guides tagged ${tagLabel(tag)}.`,
      jsonld: [crumbs([[config.siteName, ""], ["Guides", "guides/"], [tagLabel(tag), rel]])],
      body: `<section class="block page"><div class="wrap"><article class="prose wide">${crumbNav("../../../", [[config.siteName, ""], ["Guides", "guides/"], [tagLabel(tag), rel]])}<h1>${esc(tagLabel(tag))}</h1><p class="lede">Guides that share this topic. The order is the order they were written, not a popularity ranking.</p><ul class="route-links">${rows.map((a) => `<li><a href="${link("../../../", `guides/${a.pillar}/${a.slug}/`)}">${esc(a.title)}</a></li>`).join("")}</ul></article></div></section>`
    }));
  }
  for (const author of authors) {
    const rel = `guides/author/${author.slug}/`;
    const rows = live.filter((a) => (a.author || "sendfair") === author.slug);
    write(rel + "index.html", page({
      prefix: "../../../", canonical: rel, rank: false, title: `${author.name} · ${config.siteName}`,
      description: author.bio,
      jsonld: [crumbs([[config.siteName, ""], ["Guides", "guides/"], [author.name, rel]])],
      body: `<section class="block page"><div class="wrap"><article class="prose wide">${crumbNav("../../../", [[config.siteName, ""], ["Guides", "guides/"], [author.name, rel]])}<h1>${esc(author.name)}</h1><p class="lede">${esc(author.bio || "")}</p><ul class="route-links">${rows.map((a) => `<li><a href="${link("../../../", `guides/${a.pillar}/${a.slug}/`)}">${esc(a.title)}</a></li>`).join("")}</ul></article></div></section>`
    }));
    urls.push(rel);
  }
  const searchItems = [
    ...live.map((a) => ({ kind: "guide", slug: a.slug, title: a.title, description: a.description || "", url: `guides/${a.pillar}/${a.slug}/`, tags: a.tags || [] })),
    ...guides.pillars.map((p) => ({ kind: "guide", slug: p.slug, title: p.title, description: p.description || "", url: `guides/${p.slug}/`, tags: [] })),
    ...Object.entries(buildCosts.countries || {}).map(([id, c]) => ({ kind: "house", slug: id, title: `Cost to build a house in ${c.name}`, description: `Receipt check for a simple house in ${c.name}.`, url: `cost-to-build/${id}/`, tags: [id] })),
    { kind: "house", slug: "material-prices", title: "Material prices", description: "Cement, steel, blocks, sand and a mason day.", url: "cost-to-build/material-prices/", tags: ["prices"] },
    { kind: "house", slug: "same-house", title: "The same house in every country", description: "One floor area priced in each country.", url: "cost-to-build/same-house/", tags: ["prices"] },
    { kind: "house", slug: "calculator", title: "Cost to build a house", description: "The house calculator.", url: "cost-to-build/", tags: ["calculator"] },
    { kind: "house", slug: "what-this-receipt-is", title: "What this receipt prices", description: "A block-and-sheet house. Factory systems are a different product.", url: "cost-to-build/what-this-receipt-is/", tags: ["receipt"] },
    { kind: "house", slug: "senegal-fr", title: "Coût pour construire au Sénégal", description: "Reçu en français pour une maison à Dakar.", url: "fr/cost-to-build/senegal/", tags: ["senegal", "fr"] },
    { kind: "house", slug: "ivorycoast-fr", title: "Coût pour construire en Côte d'Ivoire", description: "Reçu en français pour une maison à Abidjan.", url: "fr/cost-to-build/ivorycoast/", tags: ["ivorycoast", "fr"] },
    { kind: "house", slug: "mali-fr", title: "Coût pour construire au Mali", description: "Reçu en français pour une maison à Bamako.", url: "fr/cost-to-build/mali/", tags: ["mali", "fr"] },
    { kind: "house", slug: "cameroon-fr", title: "Coût pour construire au Cameroun", description: "Reçu en français pour une maison à Douala et Yaoundé.", url: "fr/cost-to-build/cameroon/", tags: ["cameroon", "fr"] },
    { kind: "house", slug: "drc-fr", title: "Coût pour construire en RD Congo", description: "Reçu en français. Le reçu est un guide converti depuis Nairobi.", url: "fr/cost-to-build/drc/", tags: ["drc", "fr"] },
    { kind: "house", slug: "rwanda-fr", title: "Coût pour construire au Rwanda", description: "Reçu en français pour une maison à Kigali.", url: "fr/cost-to-build/rwanda/", tags: ["rwanda", "fr"] },
    ...corridors.receivers.map((r) => ({ kind: "money", slug: r.id, title: `Send money to ${r.name}`, description: `Compare transfers into ${r.name}.`, url: hubPath(r), tags: [r.id] })),
    { kind: "page", slug: "methodology", title: "How we rank", description: "How SendFair orders a transfer.", url: "methodology/", tags: [] },
    { kind: "page", slug: "contact", title: "Contact", description: "Email SendFair.", url: "contact/", tags: [] }
  ];
  write("data/search.json", JSON.stringify({ items: searchItems }));
  write("search/index.html", page({
    prefix: "../", canonical: "search/", rank: false, title: `Search · ${config.siteName}`,
    description: "Search SendFair guides, house costs and receiving countries. The words you type stay in this browser and are not sent to us.",
    jsonld: [crumbs([[config.siteName, ""], ["Search", "search/"]])],
    body: `<section class="block page"><div class="wrap"><article class="prose wide">${crumbNav("../", [[config.siteName, ""], ["Search", "search/"]])}<h1>Search</h1><p class="lede">Guides, house-cost pages and receiving countries. A search is saved only in this browser.</p><form id="sf-search" class="search-form" role="search"><label class="label" for="sf-q">Search</label><input id="sf-q" name="q" type="search" autocomplete="off"><label class="label" for="sf-search-section">Section</label><select id="sf-search-section"><option value="">All</option><option value="guide">Guides</option><option value="house">House costs</option><option value="money">Send money</option></select><button type="submit">Search</button></form><p id="sf-search-suggest" class="tag-row"></p><div id="sf-search-out"></div></article></div></section>`
  }));
  urls.push("search/");
  const blank = (value, label) => `<li>${esc(label)}: ${value ? "set" : "not set"}</li>`;
  const deskRows = (guides.articles || []).map((a) => {
    const liveRow = guideLive(a);
    const state = a.status === "draft" ? "Draft" : (a.publishAt && a.publishAt > today ? `Scheduled ${a.publishAt}` : "Published");
    const days = a.updated ? Math.round((Date.parse(today) - Date.parse(a.updated)) / 86400000) : null;
    const notes = [
      !liveRow ? "Held out of the site and the sitemap" : "",
      days != null && days > 90 ? `Updated ${days} days ago` : "",
      !(a.tags || []).length ? "No tags" : "",
      !(a.description || "").trim() ? "No description" : "",
      (a.seoDescription || a.description || "").length > 170 ? "Description is long for a search result" : ""
    ].filter(Boolean).join(". ");
    const titleCell = liveRow ? `<a href="${link("../../", `guides/${a.pillar}/${a.slug}/`)}">${esc(a.title)}</a>` : esc(a.title);
    return `<tr><td>${titleCell}</td><td>${esc(state)}</td><td>${esc(a.updated || "")}</td><td>${esc((a.tags || []).join(", "))}</td><td>${a.seoTitle ? "Custom" : "Headline"}</td><td>${esc(notes || "OK")}</td></tr>`;
  }).join("");
  const redirectRows = readOptional("data/redirects.json", []).filter((r) => r && r.from && r.to && !r.example);
  write("admin/guides/index.html", page({
    prefix: "../../", canonical: "admin/guides/", noindex: true, rank: false, title: `Guide checklist · ${config.siteName}`,
    description: "Editorial checklist for SendFair guides. Not indexed.",
    body: `<section class="block page"><div class="wrap"><article class="prose wide"><h1>Guide checklist</h1><p class="lede">A static reading of the guide file. There is no login and no traffic count. Drafts and future dates are left out of the public pages.</p><div class="table-wrap"><table class="desk"><thead><tr><th>Guide</th><th>Status</th><th>Updated</th><th>Tags</th><th>Title tag</th><th>Notes</th></tr></thead><tbody>${deskRows}</tbody></table></div><h2>On this browser</h2><p id="sf-vitals">No speed note in this browser yet.</p><p id="sf-desk-searches">No searches stored in this browser.</p><h2>Advertising</h2><p>Slots are edited in config.json. Nothing here is invented.</p><ul>${blank(config.adsenseClient, "AdSense publisher ID")}${blank(config.adsenseSlots && config.adsenseSlots.afterIntro, "Slot after the introduction")}${blank(config.adsenseSlots && config.adsenseSlots.midPage, "Mid-page slot")}${blank(config.adsenseSlots && config.adsenseSlots.sticky, "Sticky slot")}${blank(config.adManagerNetwork, "Google Ad Manager network")}${blank(config.adManagerSlot, "Google Ad Manager slot")}${blank(config.ga4MeasurementId, "Google Analytics")}${blank(config.gtmContainerId, "Tag Manager")}${blank(config.clarityProjectId, "Clarity")}${blank(config.newsletterFormAction, "Newsletter form")}</ul><h2>Redirects</h2>${redirectRows.length ? `<ul>${redirectRows.map((r) => `<li>${esc(r.from)} → ${esc(r.to)} (${esc(String(r.code || 301))})</li>`).join("")}</ul>` : "<p>No redirects are published. Rows marked example in data/redirects.json are skipped.</p>"}<h2>Pictures</h2><p>Each guide can set og to a file name in src/og. Otherwise the build looks for a title card named guide-{pillar}-{slug}.png. That card is type, not a photograph. A featured picture is not used as the share image unless og is set to it.</p></article></div></section>`
  }));
}

function writeHtmlSitemap() {
  const pretty = (u) => (u === "" ? "Home" : u.replace(/\/$/, "").split("/").pop().replace(/-/g, " "));
  const groups = [
    ["Guides", (u) => u.startsWith("guides/")],
    ["Quote Check", (u) => u.startsWith("quote-check/")],
    ["Cost to build", (u) => u.startsWith("cost-to-build/")],
    ["Send money", (u) => u.startsWith("send-money") && !/^send-money\/[^/]+\/\d+\/$/.test(u)],
    ["Services and rates", (u) => u.startsWith("providers/") || u.startsWith("compare/") || u.startsWith("rates/")],
    ["About this site", (u) => !u.startsWith("guides/") && !u.startsWith("quote-check/") && !u.startsWith("cost-to-build/") && !u.startsWith("send-money") && !u.startsWith("providers/") && !u.startsWith("compare/") && !u.startsWith("rates/")]
  ];
  const body = groups.map(([name, test]) => {
    const list = urls.filter(test);
    if (!list.length) return "";
    return `<h2>${esc(name)}</h2><ul class="route-links">${list.map((u) => `<li><a href="${link("../", u)}">${esc(pretty(u))}</a></li>`).join("")}</ul>`;
  }).join("");
  write("sitemap/index.html", page({
    prefix: "../", canonical: "sitemap/", rank: false, title: `All pages · ${config.siteName}`,
    description: "The index of every public SendFair page: money transfer routes, house-build costs, guides and the pages about the site.",
    jsonld: [crumbs([[config.siteName, ""], ["All pages", "sitemap/"]])],
    body: `<section class="block page"><div class="wrap"><article class="prose wide">${crumbNav("../", [[config.siteName, ""], ["All pages", "sitemap/"]])}<h1>All pages</h1><p class="lede">The public pages on SendFair. The machine-readable list is <a href="${site}/sitemap.xml">sitemap.xml</a>.</p>${body}</article></div></section>`
  }));
  urls.push("sitemap/");
}
writeHtmlSitemap();
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.map((u) => { const lm = lastmodFor(u); const alts = sitemapAlts[u]; return `  <url><loc>${site}/${u}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}${alts ? alts.map((a) => `<xhtml:link rel="alternate" hreflang="${a.lang}" href="${a.href}"/>`).join("") : ""}</url>`; }).join("\n")}\n</urlset>\n`);
// AI answer engines may read the site so SendFair can be cited in their answers; model-training crawlers are
// blocked separately by Cloudflare's managed robots.txt, which Cloudflare puts above these lines.
write("robots.txt", `User-agent: OAI-SearchBot\nUser-agent: ChatGPT-User\nUser-agent: PerplexityBot\nUser-agent: Perplexity-User\nUser-agent: Claude-SearchBot\nUser-agent: Claude-User\nAllow: /\nDisallow: /admin/\nDisallow: /go/\nDisallow: /api/\nDisallow: /quote-check/report/\nDisallow: /quote-check/pay/\n\nUser-agent: *\nDisallow: /admin/\nDisallow: /go/\nDisallow: /api/\nDisallow: /quote-check/report/\nDisallow: /quote-check/pay/\nSitemap: ${site}/sitemap.xml\n`);
// Installable app: the manifest and a small service worker that keeps the last pages viewed for offline use.
write("manifest.webmanifest", JSON.stringify({
  name: "SendFair: compare transfers and house-build costs", short_name: "SendFair",
  description: "See which service delivers the most money home, and what a house back home costs to build.",
  start_url: "/?source=app", scope: "/", display: "standalone", background_color: "#ffffff", theme_color: "#ffffff",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]
}, null, 2));
if (!PREVIEW) {
  const shell = ["/", "/offline", `/assets/style.css?v=${V.css}`, `/assets/fonts.css?v=${V.fonts}`, `/assets/app.js?v=${V.app}`, `/assets/rank.js?v=${V.rank}`, `/assets/build-cost.js?v=${V.build}`, "/assets/fonts/figtree-latin-wght-normal.woff2", "/assets/fonts/bricolage-grotesque-latin-opsz-normal.woff2", "/favicon.svg", "/manifest.webmanifest"];
  write("sw.js", fs.readFileSync(path.join(ROOT, "src/sw.js"), "utf8").replace("__VERSION__", V.css + V.app + V.rank).replace("__SHELL__", JSON.stringify(shell)));
}
// ads.txt lets AdSense confirm this site may show the publisher's ads.
if (config.adsenseClient && !DEMO) write("ads.txt", `google.com, ${config.adsenseClient.replace(/^ca-/, "")}, DIRECT, f08c47fec0942fa0\n`);
const redirectRows = readOptional("data/redirects.json", []).filter((r) => r && r.from && r.to && !r.example);
write("_redirects", redirectRows.map((r) => `${r.from} ${r.to} ${r.code || 301}`).join("\n") + (redirectRows.length ? "\n" : ""));
write("_headers", `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://www.google-analytics.com https://*.clarity.ms https://pagead2.googlesyndication.com https://*.adtrafficquality.google https://fundingchoicesmessages.google.com https://static.cloudflareinsights.com https://translate.google.com https://translate.googleapis.com https://www.gstatic.com https://utt.impactcdn.com https://emrldco.com https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://www.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://*.clarity.ms https://pagead2.googlesyndication.com https://*.adtrafficquality.google https://fundingchoicesmessages.google.com https://static.cloudflareinsights.com https://cloudflareinsights.com https://translate.googleapis.com https://utt.impactcdn.com https://*.impact.com https://emrldco.com; frame-src https://*.doubleclick.net https://pagead2.googlesyndication.com https://*.adtrafficquality.google https://www.google.com https://fundingchoicesmessages.google.com https://challenges.cloudflare.com; font-src 'self' https://fonts.gstatic.com data:; base-uri 'self'; form-action 'self' https://buttondown.com; object-src 'none'
/data/*
  Cache-Control: public, max-age=300
/assets/fonts/*
  Cache-Control: public, max-age=31536000, immutable
/assets/*.css
  Cache-Control: public, max-age=31536000, immutable
/assets/*.js
  Cache-Control: public, max-age=31536000, immutable
/*.html
  Cache-Control: no-cache
/
  Cache-Control: no-cache
/send-money/*
  Cache-Control: no-cache
/send-money-to/*
  Cache-Control: no-cache
/providers/*
  Cache-Control: no-cache
/compare/*
  Cache-Control: no-cache
/rates/*
  Cache-Control: no-cache
/guides/*
  Cache-Control: no-cache
/logos/*.webp
  Cache-Control: public, max-age=604800
/sw.js
  Cache-Control: no-cache
/manifest.webmanifest
  Content-Type: application/manifest+json
  Cache-Control: public, max-age=86400
/admin/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store
/quote-check/report/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store
/quote-check/pay/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store
`);

console.log(`Built ${urls.length} pages into ${path.relative(ROOT, OUT)}${DEMO ? " (demo data)" : ""}${PREVIEW ? " (preview links)" : ""}`);
