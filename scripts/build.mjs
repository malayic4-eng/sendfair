// Builds the static site into dist/.
// Usage: node scripts/build.mjs [--demo] [--preview] [--out dist]
//   --demo     fills the site with clearly labelled example quotes (previews only, never deploy)
//   --preview  writes links as .../index.html and uses hosted fonts so the site works inside a file preview
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const R = require(path.join(ROOT, "src/rank.js"));
const args = process.argv.slice(2);
const DEMO = args.includes("--demo");
const PREVIEW = args.includes("--preview");
const OUT = path.resolve(ROOT, args.includes("--out") ? args[args.indexOf("--out") + 1] : "dist");
const NOW = Date.now();

function read(p) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); }
  catch (e) { fail([`${p} is not valid JSON: ${e.message}`]); }
}
function fail(problems) {
  console.error("\nBuild stopped. Fix these and publish again:\n" + problems.map((p) => "  - " + p).join("\n") + "\n");
  process.exit(1);
}

const config = read("config.json");
const corridors = read("data/corridors.json");
const providersFile = read("data/providers.json");
let quotesFile = read("data/quotes.json");
let midmarket = read("data/midmarket.json");

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

// Hand-checked corrections for currencies where the free feed is off (kept for up to 7 days, since the free feed is further off).
try {
  const ov = JSON.parse(fs.readFileSync(path.join(ROOT, "data/mid-overrides.json"), "utf8"));
  if (ov && ov.rates && NOW - new Date(ov.updatedAt).getTime() < 7 * 24 * 3600000 && midmarket.rates) {
    Object.assign(midmarket.rates, ov.rates);
    if (!midmarket.updatedAt || new Date(ov.updatedAt) > new Date(midmarket.updatedAt)) midmarket.updatedAt = ov.updatedAt;
    // The previous check's rates, for the "since yesterday" trend next to the market rate.
    if (ov.previous && ov.previous.rates) midmarket.previous = { updatedAt: ov.previous.updatedAt, rates: Object.assign({ USD: 1 }, ov.previous.rates) };
  }
} catch {}
// Trustpilot ratings (data/ratings.json) are attached to each provider.
let ratingsFile = { ratings: {} };
try { ratingsFile = read("data/ratings.json"); } catch {}
for (const p of providersFile.providers) if (ratingsFile.ratings[p.id]) p.rating = { ...ratingsFile.ratings[p.id], source: ratingsFile.source || "Trustpilot", checkedAt: ratingsFile.checkedAt };
const providers = Object.fromEntries(providersFile.providers.map((x) => [x.id, x]));
// Daily history (data/history.json), written by scripts/record-history.mjs after each rate check.
let history = { days: {} };
try { history = read("data/history.json"); } catch {}
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
const quotes = quotesFile.quotes || {};
const coverage = quotesFile.coverage || {};

// ---------- helpers ----------
const slug = (s, r) => `${s.id}-to-${r.id}`;
const corridorPath = (s, r) => `send-money/${slug(s, r)}/`;
const link = (prefix, p) => (PREVIEW ? prefix + (p === "" ? "index.html" : p.endsWith("/") ? p + "index.html" : p) : prefix + p);
const hrefFor = (prefix) => (p, k) => (config.trackClicks && !DEMO ? `${prefix}go/${encodeURIComponent(p.id)}?r=${encodeURIComponent(k)}` : (p.affiliateUrl || p.website).replace("{route}", k));
const hasOg = fs.existsSync(path.join(ROOT, "src/og"));
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// Logo: the "App Tile". Indigo rounded square, marigold S, and an F whose top bar ends in an arrow (money on its way).
const tile = (fill, ring, size) => `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><rect x="1" y="1" width="62" height="62" rx="16" fill="${fill}"/><rect x="4.5" y="4.5" width="55" height="55" rx="13" fill="none" stroke="#f6b52b" stroke-width="${ring}" opacity=".7"/><g transform="translate(32 32) scale(1.05) translate(-32 -32)" fill="#f6b52b"><path transform="translate(15.52 42.2) scale(.0275 -.0275)" d="M318 -14Q251 -14 199 0Q147 13 110 40Q73 67 54 107Q34 146 32 197L177 239Q180 195 199 167Q219 139 252 125Q285 112 326 112Q363 112 389 121Q416 130 430 145Q444 161 444 179Q444 202 425 217Q407 232 374 243Q342 253 300 264Q253 276 207 290Q161 304 124 326Q87 349 64 384Q42 419 42 472Q42 535 74 580Q105 625 164 649Q224 674 306 674Q389 674 450 648Q511 623 544 575Q577 528 576 463L430 429Q430 458 422 481Q413 503 397 518Q382 534 358 541Q334 549 303 549Q268 549 244 541Q220 532 208 518Q196 504 196 485Q196 462 215 448Q233 433 267 422Q300 412 342 401Q385 391 430 377Q475 363 513 340Q552 318 576 281Q599 243 599 186Q599 123 566 78Q533 33 470 10Q407 -14 318 -14Z"/><path d="M33.2 22.2h11.2v-2.7l5.6 4.8-5.6 4.8v-2.7h-6.6v3.6h5.6v4.2h-5.6v8.1h-4.6z"/></g></svg>`;
const logo = tile("#111853", 1.1, 34);
const wallet = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><rect x="4" y="8" width="16" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="16" cy="13.5" r="1.4" fill="currentColor"/></svg>`;

function routeContext(s, r, prefix, amount) {
  const k = `${s.id}-${r.id}`;
  const mid = R.midRate(midmarket, s.currency, r.currency);
  const list = quotes[k] || [];
  const rows = R.rank({ list, providers, amount, payout: "all", mid, now: NOW, staleH, hideH });
  const cov = coverage[k] && coverage[k].length ? coverage[k] : Object.keys(providers).filter((id) => servesFrom(providers[id], s.id));
  return {
    s, r, key: k, amount, payout: "all", mid, rows, allRows: rows, hist: histFor(k), now: NOW, midPrev: midmarket.previous ? R.midRate(midmarket.previous, s.currency, r.currency) : null, midPrevAt: midmarket.previous && midmarket.previous.updatedAt, timeStyle: "absolute", anyQuotes: list.length > 0, reports: demoReports ? demoReports.routes[k] : {},
    hrefFor: hrefFor(prefix), disclosureHref: link(prefix, "disclosure/"), checkList: cov.map((id) => providers[id]).filter(Boolean),
    avgPct: config.regionalAverageCost.percent, avgLabel: config.regionalAverageCost.label,
    midUpdated: midmarket && midmarket.updatedAt, quotesUpdated: quotesFile.updatedAt
  };
}

function head({ title, description, canonical, prefix, jsonld = [], noindex = false, og = "home" }) {
  const ads = config.adsenseClient && !DEMO ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${esc(config.adsenseClient)}" crossorigin="anonymous"></script>` : "";
  const cfa = config.cfAnalyticsToken && !DEMO ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${esc(config.cfAnalyticsToken)}"}'></script>` : "";
  // Impact (affiliate network, used by Remitly and others): site verification and link tracking.
  const impact = config.impactScriptId && !DEMO ? `<script type="text/javascript">(function(i,m,p,a,c,t){c.ire_o=p;c[p]=c[p]||function(){(c[p].a=c[p].a||[]).push(arguments)};t=a.createElement(m);var z=a.getElementsByTagName(m)[0];t.async=1;t.src=i;z.parentNode.insertBefore(t,z)})('https://utt.impactcdn.com/P-${esc(config.impactScriptId)}.js','script','impactStat',document,window);impactStat('transformLinks');impactStat('trackImpression');</script>` : "";
  const fonts = PREVIEW
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&family=Figtree:wght@300..900&display=swap">`
    : `<link rel="preload" href="${prefix}assets/fonts/figtree-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${prefix}assets/fonts/bricolage-grotesque-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${prefix}assets/fonts.css?v=${V.fonts}">`;
  if (hasOg && !fs.existsSync(path.join(ROOT, "src/og", og + ".png"))) og = "home";
  const ogImg = hasOg ? `<meta property="og:image" content="${site}/og/${og}.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`;
  return `<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${PREVIEW ? '<meta name="claude:viewport-fit-sides" content="cover">' : ""}
${noindex || DEMO ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">'}
${canonical != null ? `<link rel="canonical" href="${site}/${canonical}">` : ""}
<meta property="og:site_name" content="${esc(config.siteName)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
${canonical != null ? `<meta property="og:url" content="${site}/${canonical}">` : ""}
${ogImg}
<meta name="color-scheme" content="light"><meta name="theme-color" content="#ffffff">
<link rel="icon" href="${prefix}favicon.svg" type="image/svg+xml">
<link rel="icon" href="${prefix}favicon-48.png" sizes="48x48" type="image/png">
<link rel="apple-touch-icon" href="${prefix}apple-touch-icon.png"><link rel="manifest" href="${prefix}manifest.webmanifest">
${fonts}
<link rel="stylesheet" href="${prefix}assets/style.css?v=${V.css}">
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join("\n")}
${ads}${cfa}${impact}`;
}

function header(prefix) {
  return `${DEMO ? `<div class="demo-banner"><div class="wrap"><strong>Preview with example figures.</strong> These rates are made up to show how the site works. The live site shows only quotes checked by hand.</div></div>` : ""}
<header class="site-header"><div class="wrap">
<a class="brand" href="${link(prefix, "")}">${logo}<span>SendFair</span></a>
<nav class="site-nav" aria-label="Main"><a href="${link(prefix, "")}#corridors">All routes</a><a href="${link(prefix, "methodology/")}">How we rank</a><a href="${link(prefix, "about/")}">About</a></nav>
</div></header>`;
}

function footer(prefix) {
  return `<footer class="site-footer"><div class="wrap">
<a class="brand" href="${link(prefix, "")}">${logo}<span>SendFair</span></a>
<div class="foot-cols">
<div><h3>Send money to</h3><ul>${corridors.receivers.map((r) => `<li><a href="${link(prefix, hubPath(r))}">${esc(r.name)}</a></li>`).join("")}</ul></div>
<div><h3>Popular routes</h3><ul>${(config.priorityRoutes || []).map((k) => { const [a, b] = k.split("-"); const S = corridors.senders.find((x) => x.id === a), Rr = corridors.receivers.find((x) => x.id === b); return S && Rr ? `<li><a href="${link(prefix, corridorPath(S, Rr))}">${esc(S.label)} to ${esc(Rr.name)}</a></li>` : ""; }).join("")}</ul></div>
<div><h3>Services</h3><ul>${providersWithQuotes().map((p) => `<li><a href="${link(prefix, provPath(p))}">${esc(p.name)} review</a></li>`).join("")}</ul></div>
<div><h3>Exchange rates</h3><ul>${["GBP-NGN", "USD-NGN", "GBP-KES", "USD-KES", "GBP-GHS", "USD-GHS", "AED-KES", "SAR-KES"].map((x) => { const [a, b] = x.split("-"); return `<li><a href="${link(prefix, `rates/${a.toLowerCase()}-to-${b.toLowerCase()}/`)}">${a} to ${b}</a></li>`; }).join("")}</ul></div>
</div>
<nav aria-label="Footer"><a href="${link(prefix, GULF_GUIDE)}">Sending from the Gulf</a><a href="${link(prefix, "about/")}">About</a><a href="${link(prefix, "methodology/")}">How we rank</a><a href="${link(prefix, "disclosure/")}">How we make money</a><a href="${link(prefix, "privacy/")}">Privacy</a><a href="${link(prefix, "terms/")}">Terms</a><button type="button" class="install-btn" id="sf-install" hidden>Add SendFair to your home screen</button></nav>
<p>SendFair compares money transfer services. We do not send, hold or exchange money. Rates change through the day; always confirm the final amount on the provider's own screen before you pay.</p>
<p>Mid-market reference rates by <a href="https://www.exchangerate-api.com" rel="noopener" target="_blank">ExchangeRate-API</a>.</p>
<p>&copy; ${new Date(NOW).getUTCFullYear()} ${esc(config.siteName)}. Run independently from Nairobi. Contact: <span class="email">${esc(config.contactEmail)}</span></p>
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
  return `<section class="hero"><div class="wrap hero-grid">
<div class="hero-copy"><h1>${heading}</h1><p class="lede">${sub}</p></div>
<div class="hero-side">${phone(ctx)}<div class="picks" id="sf-picks" aria-label="Best service by way of receiving">${R.picks(ctx)}</div></div>
</div></section>
<section class="sheet"><div class="wrap">
<div class="tool">
  <div class="controls">
    <div class="field"><label for="sf-from">Sending from</label><select id="sf-from">${corridors.senders.map((s) => `<option value="${s.id}"${s.id === ctx.s.id ? " selected" : ""}>${esc(s.label)} (${s.currency})</option>`).join("")}</select></div>
    <div class="field"><label for="sf-to">Sending to</label><select id="sf-to">${corridors.receivers.map((r) => `<option value="${r.id}"${r.id === ctx.r.id ? " selected" : ""}>${esc(r.name)} (${r.currency})</option>`).join("")}</select></div>
    <div class="field amount-field"><label for="sf-amount" id="sf-amount-label">You pay in total</label><div class="amount-wrap"><button type="button" id="sf-mode" class="mode-btn" title="Switch between the amount you pay and the amount they need">Pay <span class="mode-cur">${ctx.s.currency}</span><span class="mode-ic" aria-hidden="true">⇄</span></button><span id="sf-cur" hidden>${ctx.s.currency}</span><input id="sf-amount" type="number" inputmode="decimal" min="1" step="any" value="${ctx.amount}"><span class="quick" id="sf-quick" role="group" aria-label="Common amounts">${(STEP_AMOUNTS[ctx.s.currency] || []).map((a) => `<button type="button" data-amt="${a}" aria-pressed="${a === ctx.amount}">${a >= 1000 ? a / 1000 + "k" : a}</button>`).join("")}</span></div></div>
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
  <li><strong>Checked by hand.</strong> Busy routes daily, others every two days; each row shows when.</li>
  <li><strong>Standard rates only.</strong> No paid placements; commissions never change the order.</li>
  <li><strong>Ratings shown</strong> from Trustpilot, so you see what customers say.</li>
</ul>
${shareBar(ctx)}${after}
</div></section>`;
}

function shareBar(ctx) {
  const url = `${site}/${corridorPath(ctx.s, ctx.r)}`;
  return `<div class="share"><a id="sf-wa" data-url="${esc(url)}" href="https://wa.me/?text=${encodeURIComponent(R.shareText(ctx, url))}" target="_blank" rel="noopener">Share on WhatsApp</a><button type="button" id="sf-copy">Copy link</button><span class="share-msg" id="sf-share-msg" aria-live="polite"></span></div>`;
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
<button type="submit">Send report</button><p class="report-msg" id="sf-rep-msg" aria-live="polite"></p>
</form></div></section>`;
}

function alerts() {
  let body;
  if (DEMO) {
    body = `<form id="sf-alert-form" data-demo="1"><label for="sf-email" class="label" style="flex-basis:100%;color:inherit">Email for daily alerts</label><input id="sf-email" name="email" type="email" required placeholder="you@example.com"><button type="submit">Get rate alerts</button></form><p id="sf-alert-msg" aria-live="polite"></p>`;
  } else if (config.newsletterFormAction) {
    body = `<form id="sf-alert-form" action="${esc(config.newsletterFormAction)}" method="post"><label for="sf-email" class="label" style="flex-basis:100%;color:inherit">Email for daily alerts</label><input id="sf-email" name="email" type="email" required placeholder="you@example.com"><button type="submit">Get rate alerts</button></form>`;
  } else if (config.whatsappChannelUrl) {
    body = `<div><a class="btn-light" href="${esc(config.whatsappChannelUrl)}" target="_blank" rel="noopener">Follow on WhatsApp</a></div>`;
  } else return "";
  return `<section class="alerts"><div class="wrap"><h2>Know when your rate moves</h2><p>One short message each morning: which service pays the most for your route today. Unsubscribe anytime.</p>${body}</div></section>`;
}

function corridorGrid(prefix) {
  const col = (s) => {
    const amount = config.defaultAmounts[s.currency];
    const rows = corridors.receivers.map((r) => {
      const c = routeContext(s, r, prefix, amount);
      const top = c.rows.find((x) => !x.stale), lead = R.leaders(c.rows);
      return `<li><a href="${link(prefix, corridorPath(s, r))}"><span class="b-country">${esc(r.name)}</span>${top
        ? `<span class="b-amt num">${R.moneyHtml(top.gets, r.currency)}</span><span class="b-prov">${lead.length > 1 ? `${lead.length}-way tie: ${esc(lead.map((x) => x.p.name).join(", "))}` : `with ${esc(top.p.name)}`}</span>`
        : `<span class="b-amt b-wait">${c.anyQuotes ? "Being rechecked" : "Coming soon"}</span><span class="b-prov">${s.currency} to ${r.currency}</span>`}</a></li>`;
    }).join("");
    return `<div class="board-col"><h3>From ${esc(s.short)}</h3><p class="board-sub">Best result for <span class="num">${esc(R.money(amount, s.currency, 0))}</span></p><ul>${rows}</ul></div>`;
  };
  const groups = REGION_IDS.map((id) => ({ id, reg: (corridors.regions || {})[id] || {}, list: corridors.senders.filter((s) => (s.region || "west") === id) })).filter((g) => g.list.length);
  return `<section class="block" id="corridors"><div class="wrap">
<div class="section-head"><h2>Today's best on every route</h2><p class="lede">What arrives for a typical transfer, from the service that delivers the most. Open a route to compare every service and enter your own amount.</p></div>
${groups.map((g) => !g.list.some((s) => corridors.receivers.some((r) => (quotes[`${s.id}-${r.id}`] || []).length)) ? `<div class="board-group" id="from-${g.id}"><h3>${esc(g.reg.heading || "")}</h3>${g.reg.guide ? `<a href="${link(prefix, g.reg.guide)}">How exchange houses, apps, banks and wallets compare</a>` : ""}</div><p class="board-soon">Rates from ${esc(joinList(g.list.map((s) => s.short)))} are being added. Until then, <a href="${link(prefix, g.reg.guide || GULF_GUIDE)}">the guide</a> explains each way of sending and what a fair deal looks like.</p>` : `${groups.length > 1 ? `<div class="board-group" id="from-${g.id}"><h3>${esc(g.reg.heading || "")}</h3>${g.reg.guide ? `<a href="${link(prefix, g.reg.guide)}">Compare exchange houses, apps, banks and wallets</a>` : ""}</div>` : ""}<div class="board${g.list.length % 3 === 0 && g.list.length > 4 ? " board-3" : ""}">${g.list.map(col).join("")}</div>`).join("")}
</div></section>`;
}

function page({ prefix, title, description, canonical, body, jsonld, noindex, init, bodyOnly, og }) {
  const sf = {
    root: prefix, siteUrl: site, disclosureHref: link(prefix, "disclosure/"),
    routeUrl: link(prefix, "send-money/{from}-to-{to}/"),
    config: { quickAmounts: STEP_AMOUNTS, defaultAmounts: config.defaultAmounts, staleAfterHours: staleH, hideAfterHours: hideH, regionalAverageCost: config.regionalAverageCost,
      trackClicks: !!config.trackClicks && !DEMO, reportsEnabled: !!config.reportsEnabled && !DEMO, demo: DEMO },
    ...(init || {})
  };
  const scripts = `<script>window.SF=${JSON.stringify(sf)};</script><script src="${prefix}assets/rank.js?v=${V.rank}" defer></script><script src="${prefix}assets/app.js?v=${V.app}" defer></script>` +
    (PREVIEW || DEMO ? "" : `<script>if("serviceWorker" in navigator&&location.protocol==="https:")addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})});addEventListener("beforeinstallprompt",function(e){e.preventDefault();var b=document.getElementById("sf-install");if(!b)return;b.hidden=false;b.onclick=function(){b.hidden=true;e.prompt();};});</script>`);
  const headStr = head({ title, description, canonical, prefix, jsonld, noindex, og });
  const bodyStr = `${header(prefix)}\n<main>${body}</main>\n${footer(prefix)}\n${scripts}`;
  if (bodyOnly) return `${headStr}\n${bodyStr}`;
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${headStr}\n</head>\n<body>\n${bodyStr}\n</body>\n</html>\n`;
}

function write(rel, content) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
}

// ---------- asset versions ----------
// Each page asks for style.css?v=<hash> etc., so browsers fetch new files as soon as they change.
import crypto from "node:crypto";
const ver = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "src", f))).digest("hex").slice(0, 10);
const V = { css: ver("style.css"), app: ver("app.js"), rank: ver("rank.js"), fonts: ver("fonts.css") };

// ---------- SEO helpers ----------
const joinList = (a) => a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : a.join("");
const CURNAME = { GBP: "British pounds", USD: "US dollars", CAD: "Canadian dollars", AUD: "Australian dollars", AED: "UAE dirhams", SAR: "Saudi riyals", QAR: "Qatari riyals", KWD: "Kuwaiti dinars", BHD: "Bahraini dinars", OMR: "Omani rials", KES: "Kenyan shillings", NGN: "Nigerian naira", GHS: "Ghanaian cedis", UGX: "Ugandan shillings", ZMW: "Zambian kwacha" };
const STEP_AMOUNTS = { GBP: [100, 250, 500, 1000], USD: [100, 300, 500, 1000], CAD: [200, 400, 1000, 2000], AUD: [200, 450, 1000, 2000],
  AED: [500, 1000, 2000, 5000], SAR: [500, 1000, 2000, 5000], QAR: [500, 1000, 2000, 5000], KWD: [50, 100, 200, 500], BHD: [50, 100, 200, 500], OMR: [50, 100, 200, 500] };
const REGION_IDS = ["west", "gulf"];
const GULF_GUIDE = ((corridors.regions || {}).gulf || {}).guide || "send-money-from-the-gulf/";
const gulfSenders = corridors.senders.filter((x) => x.region === "gulf");
const allSendersText = joinList(corridors.senders.filter((x) => x.region !== "gulf").map((x) => x.label)) + (gulfSenders.length ? " and the Gulf" : "");
const regulatorText = (list) => joinList([...new Set(list.map((x) => REGULATOR[x.id]).filter(Boolean))]);
const REGULATOR = { uk: "the FCA (UK)", us: "FinCEN (US)", canada: "FINTRAC (Canada)", australia: "AUSTRAC (Australia)", uae: "the Central Bank of the UAE", saudi: "the Saudi Central Bank (SAMA)", qatar: "Qatar Central Bank", kuwait: "the Central Bank of Kuwait", bahrain: "the Central Bank of Bahrain", oman: "the Central Bank of Oman" };
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

// Practical tips per receiving country, plus general ones for every route.
const TIPS = {
  kenya: ["M-Pesa limits: KES 250,000 per transaction and KES 500,000 per day, with a wallet balance cap of KES 500,000. For more, send to a bank account or split it over several days.", "Enter the recipient's number in +254 format and check the registered name the provider shows before you confirm."],
  nigeria: ["Most transfers go to a bank account: you need the 10-digit account number and the bank's name. The provider shows the account holder's name before you pay; check it matches.", "Wallets such as OPay and PalmPay have limits that depend on how fully the recipient's account is verified."],
  ghana: ["Mobile money wallets (MTN MoMo, Telecel Cash, AT Money) must be registered to the recipient; their verification level sets how much they can receive.", "Check the registered name the provider shows before you confirm."],
  uganda: ["MTN Mobile Money and Airtel Money wallets have daily and balance limits set by how fully the account is registered. For large amounts, send to a bank account.", "Enter the number in +256 format and check the registered name before you confirm."],
  zambia: ["MTN, Airtel and Zamtel wallets have limits that depend on registration level; banks suit larger amounts.", "Check the registered name the provider shows before you confirm."],
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
  west: ["Sending money to family is generally not taxed for the sender in the UK, US, Canada or Australia, though very large gifts can have reporting rules. Check with a tax adviser if unsure."],
  gulf: [
    "Gulf states do not tax money you send home, but VAT is added to the transfer fee in some: 5% in the UAE and Oman, 10% in Bahrain and 15% in Saudi Arabia. Fees shown here include it.",
    "Use only a service licensed by the country's central bank. Informal hawala agents are cheap until something goes wrong: there is no receipt, no refund and, in the UAE and elsewhere, operating unregistered is a crime.",
    "Gulf currencies are pegged to the US dollar, so day-to-day moves in your rate come from the African currency, not the dirham, riyal or dinar."
  ]
};
const tipsFor = (s, r) => [...(TIPS[r.id] || []), ...(TIPS_FROM[s.region || "west"] || []), ...TIPS_ALL];

// Daily history chart: mid-market rate (line) and the best rate a service gave (dots), server-drawn SVG.
function histChart(ctx) {
  const pts = ctx.hist.filter((h) => h.mid || h.best);
  const effective = (h) => (h.best && h.amount ? h.best / h.amount : null);
  if (!pts.length) return `<p class="note">History starts with the next rate check.</p>`;
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

// Rate alert sign-up for one route.
function alertForm(ctx) {
  const top = ctx.rows.find((x) => !x.stale);
  const target = top ? Math.ceil((top.gets * 1.01) / (top.gets >= 1000 ? 100 : 1)) * (top.gets >= 1000 ? 100 : 1) : "";
  return `<form class="alert-form" id="sf-alert-route" data-route="${ctx.key}" novalidate>
<div class="af-row"><label>When <span class="af-cur">${ctx.s.currency}</span> <input name="amount" type="number" min="1" step="any" inputmode="decimal" value="${ctx.amount}" required aria-label="Amount you send"></label>
<label>delivers at least <span class="af-cur">${ctx.r.currency}</span> <input name="target" type="number" min="1" step="any" inputmode="decimal" value="${target}" required aria-label="Amount you want them to receive"></label></div>
<div class="af-row"><label class="af-email">email me at <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required></label><button type="submit" class="btn">Set alert</button></div>
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
for (const f of ["style.css", "app.js", "rank.js", "fonts.css"]) fs.copyFileSync(path.join(ROOT, "src", f), path.join(OUT, "assets", f));
copyDir(path.join(ROOT, "src/fonts"), path.join(OUT, "assets/fonts"));
copyDir(path.join(ROOT, "src/og"), path.join(OUT, "og"));
copyDir(path.join(ROOT, "src/icons"), OUT);
write("data/corridors.json", JSON.stringify(corridors));
write("data/providers.json", JSON.stringify(providersFile));
write("data/quotes.json", JSON.stringify(quotesFile));
write("data/midmarket.json", JSON.stringify(midmarket));
write("data/history.json", JSON.stringify(history));
const wiseFeed = path.join(ROOT, "data/wise-feed.json");
if (fs.existsSync(wiseFeed) && !DEMO) fs.copyFileSync(wiseFeed, path.join(OUT, "data/wise-feed.json"));
if (demoReports) write("data/reports-demo.json", JSON.stringify(demoReports));
write("data/site.json", JSON.stringify({ siteName: config.siteName, siteUrl: site, priorityRoutes: config.priorityRoutes || [], defaultAmounts: config.defaultAmounts, staleAfterHours: staleH, hideAfterHours: hideH, regionalAverageCost: config.regionalAverageCost }));

const urls = [];
const S0 = corridors.senders.find((s) => s.id === "uk") || corridors.senders[0];
const R0 = corridors.receivers.find((r) => r.id === "kenya") || corridors.receivers[0];

// Home
const quotedRoutes = Object.keys(quotesFile.quotes || {}).filter((k) => (quotesFile.quotes[k] || []).length).length;
const quotedProviders = new Set(Object.values(quotesFile.quotes || {}).flat().map((q) => q.provider).filter((id) => providers[id])).size;
const homeProof = quotedProviders > 1
  ? `${quotedProviders} services on ${quotedRoutes} routes, checked by hand every day.`
  : "Rates checked by hand. Commissions never change the order.";
const homeCtx = routeContext(S0, R0, "", config.defaultAmounts[S0.currency]);
write("index.html", page({
  prefix: "", canonical: "", bodyOnly: PREVIEW, og: "home",
  title: PREVIEW ? config.siteName : `Compare money transfers to Africa: best rates today | ${config.siteName}`,
  description: `Compare what actually arrives when you send money from the US, UK, Canada, Australia or the Gulf (UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, Oman) to ${joinList(corridors.receivers.map((r) => r.name))}. Rates checked by hand.`,
  jsonld: [{ "@context": "https://schema.org", "@type": "WebSite", name: config.siteName, url: site + "/" },
    { "@context": "https://schema.org", "@type": "Organization", name: config.siteName, url: site + "/", logo: `${site}/icon-512.png`, email: config.contactEmail, areaServed: [...corridors.senders, ...corridors.receivers].map((x) => x.iso2) }],
  body: tool({
    ctx: homeCtx,
    heading: "Send more home.",
    sub: `Compare money transfers to Africa by what your family actually receives, after the fee and the exchange-rate markup. ${homeProof}`
  }) + corridorGrid("") + `
<section class="block steps-block"><div class="wrap">
<div class="section-head"><h2>How the ranking works</h2></div>
<ol class="steps">
<li><h3>We check each provider</h3><p>We record the rate and fee each service quotes on every route, how the money can be received, and when we checked.</p></li>
<li><h3>We do the maths for your amount</h3><p>Fees come off what you pay and the rest converts at the provider's rate. That gives the amount that actually arrives.</p></li>
<li><h3>Most money home ranks first</h3><p>Commissions never change the order. A service that pays us nothing can rank first.</p></li>
</ol></div></section>
<section class="block"><div class="wrap"><div class="section-head"><h2>Send money to</h2></div>
<ul class="route-links big">${corridors.receivers.map((r) => `<li><a href="${link("", hubPath(r))}">${esc(r.name)}</a></li>`).join("")}</ul>
<div class="section-head" style="margin-top:32px"><h2>Services we compare</h2></div>
<ul class="route-links big">${providersWithQuotes().map((p) => `<li><a class="with-badge" href="${link("", provPath(p))}">${R.badge(p)}${esc(p.name)} review</a></li>`).join("")}</ul>
<div class="section-head" style="margin-top:32px"><h2>Head to head</h2></div>
<ul class="route-links">${vsPairs().map(([a, b]) => `<li><a href="${link("", vsPath(a, b))}">${esc(a.name)} vs ${esc(b.name)}</a></li>`).join("")}</ul>
<div class="section-head" style="margin-top:32px"><h2>Exchange rates today</h2></div>
<ul class="route-links">${ratePairs.map(({ s, r }) => `<li><a href="${link("", ratePath(s, r))}">${s.currency} to ${r.currency}</a></li>`).join("")}</ul>
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
    const title = cap(`Send money from ${s.short} to ${r.name}: best ${s.currency} to ${r.currency} rate today`);
    const description = top
      ? `${who} today: ${plain(R.money(top.gets, r.currency))} for ${amt}. Compare ${joinList(names.slice(0, 4))} by what arrives in ${r.name}${nets.length ? ` via ${joinList(nets.slice(0, 2))}, bank or cash pickup` : ""}.`
      : `Compare money transfer services from ${s.short} to ${r.name} by what actually arrives in ${rCur}, after fees and the exchange-rate markup. Rates checked by hand.`;
    const lede = `Compare ${names.length > 1 ? names.length + " services" : "transfer services"} by how many ${esc(rCur)} arrive${nets.length ? ` by ${esc(joinList(nets))}, bank or cash pickup` : ""}. ${top ? `Checked by hand, ${esc(dateLong)}.` : "Quotes for this route are being added."}`;
    const mobileProv = [...new Set(fresh.filter((x) => (x.q.payout || []).includes("mobile")).map((x) => x.p.name))];
    const midTxt = ctx.mid ? `1 ${s.currency} = ${R.rateStr(ctx.mid)} ${r.currency}` : "";
    const summary = top ? `<p>On ${esc(dateLong)}, ${lead.length > 1 ? `<strong>${esc(R.names(lead))}</strong> tie for the most` : `<strong>${esc(top.p.name)}</strong> delivers the most`} from ${esc(s.short)} to ${esc(r.name)}: <strong>${esc(plain(R.money(top.gets, r.currency)))}</strong> for ${esc(amt)}${lead.length > 1 ? "" : `, at a rate of ${R.rateStr(top.ev.rate)} with ${esc(R.feeStr(top.q, s.currency).replace(/^Fee /, "a fee of ").replace(/^No fee$/, "no fee"))}`}.${last && last !== top ? ` The lowest of the ${fresh.length} services we checked, ${esc(last.p.name)}, delivers ${esc(plain(R.money(last.gets, r.currency)))}, so choosing well is worth ${esc(plain(R.money(top.gets - last.gets, r.currency)))} on this one transfer.` : ""}${midTxt ? ` The mid-market rate is ${esc(midTxt)}.` : ""}</p>` : "";
    const faqs = [
      [`What is the cheapest way to send money from ${s.short} to ${r.name} today?`, top ? `Today ${who}: ${plain(R.money(top.gets, r.currency))} for ${amt}, after fees and exchange-rate margins. The order changes from day to day, so check the ranking on this page before each transfer.` : `It changes from day to day. The ranking on this page shows which service delivers the most ${rCur} for the amount you enter, after the transfer fee and the exchange-rate markup.`],
      ...(ctx.mid ? [[`What is the ${s.currency} to ${r.currency} exchange rate today?`, `The mid-market rate is ${midTxt}.${top ? ` The best rate a transfer service offers today is ${R.rateStr(Math.max(...fresh.map((x) => x.ev.rate)))}, but the fee matters too, which is why we rank by the amount that arrives.` : ""}`]] : []),
      ...(ctx.mid ? [[`How much is ${amt} in ${rCur}?`, `At the mid-market rate, ${amt} is ${plain(R.money(ctx.amount * ctx.mid, r.currency))}.${top ? ` After fees and margins, the best transfer service today delivers ${plain(R.money(top.gets, r.currency))}.` : ""}`]] : []),
      ...(nets.length ? [[`Can I send money from ${s.short} to ${nets[0]} in ${r.name}?`, mobileProv.length ? `Yes. Of the services we checked today, ${joinList(mobileProv)} pay out to mobile money in ${r.name}${nets.length > 1 ? `, which covers ${joinList(nets)}` : ""}. Choose "Mobile money" above the ranking to compare only those.` : `Several services pay out to mobile money in ${r.name}. Choose "Mobile money" above the ranking to see which ones were checked today.`]] : []),
      [`How long does a transfer from ${s.short} to ${r.name} take?`, `Mobile money transfers usually arrive within minutes once the provider has verified your payment. Bank deposits take from a few minutes to two working days, and cash pickup is usually ready the same day. Your first transfer can take longer while the provider checks your identity.`],
      [`How can people in ${r.name} receive the money?`, Object.entries(r.payout).map(([k, v]) => `${R.LABEL[k]}: ${v}`).join(". ") + "."],
      [`Why compare against the mid-market rate?`, `The mid-market rate is the midpoint between buying and selling prices on currency markets. Providers add a margin on top of it, so the gap between their rate and the mid-market rate is a hidden cost, even when the fee says zero.`],
      [`Is ${config.siteName} a money transfer service?`, `No. We compare services and send you to the provider to complete your transfer. We never hold your money or your card details.`]
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
<h2 id="rates">${esc(s.currency)} to ${esc(r.currency)}: today's rates by service</h2>
${summary}
${amountsTable(ctx)}
<h2 id="history">${esc(s.currency)} to ${esc(r.currency)} rate history</h2>
${histChart(ctx)}
${s.currency !== r.currency ? `<p class="note"><a href="${link(prefix, `rates/${s.currency.toLowerCase()}-to-${r.currency.toLowerCase()}/`)}">${esc(s.currency)} to ${esc(r.currency)} converter and today's rate</a></p>` : ""}
<h2 id="alert">Get a rate alert</h2>
${alertForm(ctx)}
<h2>How to send money from ${esc(s.short)} to ${esc(r.name)}</h2>
<ol class="howto">
<li><strong>Compare today's options.</strong> Enter the amount you will pay above. The service at the top delivers the most ${esc(rCur)} after its fee and exchange-rate margin.</li>
<li><strong>Open an account with the provider.</strong> ${s.region === "gulf" ? `Services in ${esc(s.short)} must check your identity, so have your ${esc(s.idDoc || "residence ID")} ready. At an exchange house branch you can do this at the counter; apps check it on your phone.` : "UK, US, Canadian and Australian providers must check your identity, so have photo ID ready."} Your first transfer may take longer while this is done.</li>
<li><strong>Add your recipient.</strong> For mobile money${nets.length ? ` (${esc(joinList(nets))})` : ""}, you need their phone number registered for the wallet. For a bank deposit, their account number and bank. For cash pickup, their full name exactly as on their ID.</li>
<li><strong>Pay and track the transfer.</strong> ${s.region === "gulf" ? "Pay by bank transfer, debit card, wallet balance or cash at a branch, depending on the service." : "Bank transfers are often cheapest to pay with; cards can add a fee."} Check the final amount on the provider's screen before you confirm.</li>
</ol>
<h2>Ways to receive money in ${esc(r.name)}</h2>
<ul class="payout-list">${Object.entries(r.payout).map(([k, v]) => `<li><span>${R.LABEL[k]}</span><span>${esc(v)}</span></li>`).join("")}</ul>
${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
<h2 id="tips">Good to know before you send</h2>
<ul class="tips">${tipsFor(s, r).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
${s.region === "gulf" ? `<p class="note"><a href="${link(prefix, GULF_GUIDE)}">Exchange house, bank, wallet or app? How the ways of sending from the Gulf compare</a></p>` : ""}
<h2 id="faq">Questions about sending money to ${esc(r.name)}</h2>
${faqBlock(faqs)}
<h2>Other routes</h2>
<ul class="route-links">${corridors.receivers.filter((x) => x.id !== r.id).map((x) => `<li><a href="${link(prefix, corridorPath(s, x))}">${esc(s.label)} to ${esc(x.name)}</a></li>`).join("")}${corridors.senders.filter((x) => x.id !== s.id).map((x) => `<li><a href="${link(prefix, corridorPath(x, r))}">${esc(x.label)} to ${esc(r.name)}</a></li>`).join("")}</ul>
</div></div></section>` + reportSection(ctx) + alerts();
    // A route with no fresh quotes stays reachable but is kept out of search results and the sitemap until it is filled.
    write(rel + "index.html", page({
      prefix, canonical: rel, title, description, og: slug(s, r), noindex: !top,
      jsonld: [faqLd(faqs), crumbs(trail)],
      init: { from: s.id, to: r.id, pageUrl: `${site}/${rel}` }, body
    }));
    if (top) urls.push(rel);
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
    [`Which services send money to ${r.name}?`, names.length ? `We compare ${joinList(names)} on routes to ${r.name}, ranked by the amount that arrives.` : `Several international services send to ${r.name}; we are checking today's rates.`]
  ];
  const trail = [[config.siteName, ""], [`Send money to ${r.name}`, rel]];
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>Send money to ${esc(r.name)}</h1>
<p class="lede">Compare what arrives in ${esc(r.name)} from the UK, the US, Canada, Australia and the Gulf states, in ${esc(rCur)}${nets.length ? ` by ${esc(joinList(nets))}, bank or cash pickup` : ""}. Ranked by the amount your family receives, checked by hand ${esc(dateLong)}.</p>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">Sending from</th><th scope="col">You pay</th><th scope="col">Best today</th><th scope="col" class="num">They get</th><th scope="col"></th></tr></thead>
<tbody>${lines.filter((l) => l.s.region !== "gulf" || lines.some((m) => m.s.region === "gulf" && m.ctx.anyQuotes)).map((l, i, arr) => `${i && l.s.region !== arr[i - 1].s.region ? `<tr class="group"><th scope="rowgroup" colspan="5">From the Gulf · <a href="${link(prefix, GULF_GUIDE)}">ways of sending compared</a></th></tr>` : ""}<tr><th scope="row">${esc(l.s.name)}</th><td class="num">${esc(plain(R.money(l.ctx.amount, l.s.currency, 0)))}</td><td>${l.top ? esc(l.lead.length > 1 ? l.lead.map((x) => x.p.name).join(", ") + " (tie)" : l.top.p.name) : "Being checked"}</td><td class="num top">${l.top ? esc(plain(R.money(l.top.gets, r.currency))) : "–"}</td><td><a href="${link(prefix, corridorPath(l.s, r))}">Compare all</a></td></tr>`).join("")}${lines.some((m) => m.s.region === "gulf") && !lines.some((m) => m.s.region === "gulf" && m.ctx.anyQuotes) ? `<tr class="group"><th scope="rowgroup" colspan="5">From the Gulf: rates are being added · <a href="${link(prefix, GULF_GUIDE)}">ways of sending compared</a></th></tr>` : ""}</tbody>
</table></div>
<h2>Ways to receive money in ${esc(r.name)}</h2>
<ul class="payout-list">${Object.entries(r.payout).map(([k, v]) => `<li><span>${R.LABEL[k]}</span><span>${esc(v)}</span></li>`).join("")}</ul>
${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
<h2>Questions</h2>
${faqBlock(faqs)}
<h2>Compare a route</h2>
<ul class="route-links">${corridors.senders.map((s) => `<li><a href="${link(prefix, corridorPath(s, r))}">${esc(s.label)} to ${esc(r.name)}</a></li>`).join("")}</ul>
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, og: "home",
    title: `Send money to ${r.name}: best rates from the UK, US, Canada, Australia and the Gulf`,
    description: `Compare money transfers to ${r.name} by what arrives in ${rCur}${nets.length ? ` via ${joinList(nets.slice(0, 2))}, bank or cash pickup` : ""}. Today's best service from each country, checked by hand.`,
    jsonld: [faqLd(faqs), crumbs(trail)], body }));
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
<p class="lede">How ${esc(p.name)} compares on ${lines.length} routes to ${esc(joinList(countries))}, using rates checked by hand on ${esc(dateLong)}.</p>
<div class="facts">
  <div><span class="k">Customer rating</span><span class="v">${ratingLine(p)}</span></div>
  <div><span class="k">Most money home</span><span class="v">${firsts} of ${fresh.length} routes today</span></div>
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
<h2>${esc(p.name)} compared with</h2>
<ul class="route-links">${others.filter((o) => vsPairs().some(([a, b]) => (a.id === p.id && b.id === o.id) || (b.id === p.id && a.id === o.id))).map((o) => { const [a, b] = vsPairs().find(([a, b]) => (a.id === p.id && b.id === o.id) || (b.id === p.id && a.id === o.id)); return `<li><a href="${link(prefix, vsPath(a, b))}">${esc(p.name)} vs ${esc(o.name)}</a></li>`; }).join("")}</ul>
<h2>Questions about ${esc(p.name)}</h2>
${faqBlock(faqs)}
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, og: "home",
    title: `${p.name} review: rates, fees and ratings to ${countries.length > 3 ? countries.slice(0, 3).join(", ") + " and more" : joinList(countries)}`,
    description: `${p.name} on ${lines.length} routes to Africa: today's rates and fees, how often it delivers the most, ways to pay and receive, and its ${p.rating ? `${p.rating.score}/5 Trustpilot rating` : "customer rating"}.`,
    jsonld: [faqLd(faqs), crumbs(trail)], body }));
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
  if (!rows.length) continue;
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
<h2>Questions</h2>
${faqBlock(faqs)}
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, og: "home",
    title: `${A.name} vs ${B.name}: who sends more money to Africa?`,
    description: `${A.name} vs ${B.name} on ${rows.length} routes to Africa: today's amounts delivered, fees, ways to pay and Trustpilot ratings, side by side.`,
    jsonld: [faqLd(faqs), crumbs(trail)], body }));
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
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>${esc(s.currency)} to ${esc(r.currency)} today: 1 ${esc(s.currency)} = ${R.rateStr(ctx.mid)} ${esc(r.currency)}</h1>
<p class="lede">The mid-market rate for ${esc(sCur)} to ${esc(rCur)}${pairHasData ? `, and what actually arrives in ${esc(r.name)} when you send money from ${esc(s.short)} with the best service we checked on ${esc(dateLong)}` : `. Transfer quotes from ${esc(s.short)} to ${esc(r.name)} are being added`}.</p>
<div class="converter" id="sf-conv" data-mid="${ctx.mid}" data-from="${s.currency}" data-to="${r.currency}">
  <label>Amount in ${esc(s.currency)} <input type="number" inputmode="decimal" min="0" step="any" value="${config.defaultAmounts[s.currency]}" id="sf-conv-in"></label>
  <div class="conv-out"><span class="k">At the mid-market rate</span><span class="v num" id="sf-conv-mid">${esc(plain(R.money(config.defaultAmounts[s.currency] * ctx.mid, r.currency)))}</span></div>
  <a class="btn" href="${link(prefix, corridorPath(s, r))}">See what arrives with each service</a>
</div>
<h2>What arrives in ${esc(r.name)} today</h2>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">You send</th><th scope="col" class="num">At mid-market</th><th scope="col" class="num">Best service gives</th><th scope="col">Service</th></tr></thead>
<tbody>${amts.map((a) => { const b = bestAt(a); return `<tr><th scope="row">${esc(plain(R.money(a, s.currency, a < 10 ? 2 : 0)))}</th><td class="num">${esc(plain(R.money(a * ctx.mid, r.currency)))}</td><td class="num top">${b ? esc(plain(R.money(b.gets, r.currency))) : "–"}</td><td>${b ? esc(b.p.name) : "Coming soon"}</td></tr>`; }).join("")}</tbody>
</table></div>
<p class="note">"Best service gives" is for sending from ${esc(s.short)}, after fees and margins, using rates checked for ${esc(plain(R.money(ctx.amount, s.currency, 0)))}. For 1 ${esc(s.currency)}, a fixed fee can outweigh the transfer.</p>
<h2>${esc(s.currency)} to ${esc(r.currency)} rate history</h2>
${histChart(ctx)}
<h2>Questions</h2>
${faqBlock(faqs)}
<h2>Send money from ${esc(s.short)} to ${esc(r.name)}</h2>
<p><a class="btn" href="${link(prefix, corridorPath(s, r))}">Compare all services for ${esc(s.label)} to ${esc(r.name)}</a></p>
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, og: slug(s, r), noindex: !pairHasData,
    title: `${s.currency} to ${r.currency} today: 1 ${s.currency} = ${R.rateStr(ctx.mid)} ${r.currency} | ${sCur} to ${rCur}`,
    description: `${sCur} to ${rCur} rate today: 1 ${s.currency} = ${R.rateStr(ctx.mid)} ${r.currency}. Converter, what arrives with the best transfer service, and rate history.`,
    jsonld: [faqLd(faqs), crumbs(trail)], body }));
  if (pairHasData) urls.push(rel);
}

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
<tbody>${grid.map((g) => `<tr><th scope="row">${esc(g.s.label)}<span class="sub">${esc(plain(R.money(config.defaultAmounts[g.s.currency], g.s.currency, 0)))}</span></th>${g.cells.map((c) => `<td class="num"><a href="${link(prefix, corridorPath(g.s, c.r))}">${c.top ? `${esc(plain(R.money(c.top.gets, c.r.currency)))}<span class="sub">${esc(c.lead.length > 1 ? c.lead.length + "-way tie" : c.top.p.name)}</span>` : `${c.ctx.anyQuotes ? "Being rechecked" : "Coming soon"}<span class="sub">${esc(g.s.currency)} to ${esc(c.r.currency)}</span>`}</a></td>`).join("")}</tr>`).join("")}</tbody>
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
    title: `Send money from the Gulf to Africa: exchange houses, banks, wallets and apps compared`,
    description: `Compare ways to send money from the UAE, Saudi Arabia, Qatar, Kuwait, Bahrain and Oman to ${joinList(corridors.receivers.map((r) => r.name))}: exchange houses, bank remittance services, wallets, apps and cash networks, ranked by what arrives.`,
    jsonld: [faqLd(faqs), crumbs(trail)], body }));
  urls.push(rel);
}

// Trust pages
const today = new Date(NOW).toISOString().slice(0, 10);
const privacyItems = [
  `<li><strong>Your comparison choices.</strong> Your route, amount and payout choice are saved only in your own browser so the tool remembers them. They are not sent to us.</li>`,
  config.newsletterFormAction ? `<li><strong>Email for rate alerts.</strong> If you sign up, your email address is stored by ${esc(config.emailProvider || "our email service")} to send the alerts. Every message has an unsubscribe link.</li>` : "",
  `<li><strong>Rate alerts.</strong> If you set a rate alert, we store your email address, the route, the amount and your target, so we can email you when it is reached. We send one confirmation email first and nothing else. Each alert is deleted once it fires, when you click the remove link in any of our emails, or after 12 months. Emails are sent through Cloudflare's Email Service. To limit misuse we keep a one-way scrambled code made from your connection for two days.</li>`,
  config.reportsEnabled ? `<li><strong>Delivery-time reports.</strong> When you report how long a transfer took, we store the route, the service and the time range only. To stop repeated reports we keep a one-way scrambled code made from your connection for two days; we cannot turn it back into your IP address.</li>` : "",
  config.trackClicks ? `<li><strong>Link clicks.</strong> We count how many times each "Go to" button is clicked on each route. The count is not linked to you.</li>` : "",
  config.impactScriptId ? `<li><strong>Affiliate tracking.</strong> Our pages load a script from Impact, an affiliate network some providers use. It records when a page is viewed and when you follow a link to a provider, so the provider can credit us if you sign up. It does not change the ranking.</li>` : "",
  config.cfAnalyticsToken ? `<li><strong>Visit statistics.</strong> We use Cloudflare Web Analytics, which counts visits without cookies and without building a profile of you.</li>` : "",
  config.adsenseClient ? `<li><strong>Advertising.</strong> Some pages show ads from Google. Visitors in the UK and Europe are asked for consent before Google uses cookies for personalised ads. You can change your choice at any time from the privacy link Google adds to the page, and manage ads at adssettings.google.com.</li>` : "",
  `<li><strong>Offline copies and logos.</strong> Your browser keeps a copy of the pages you open on SendFair so they still load without a connection; this stays on your device. Service logos are fetched by our server from each provider's public website, so your browser only ever connects to sendfair.africa for them.</li>`,
  `<li><strong>Hosting.</strong> The site is hosted by Cloudflare, which processes basic technical data (such as IP address) to deliver pages and protect against abuse.</li>`
].filter(Boolean).join("");

const trust = {
  "about/": ["About SendFair", "Who runs SendFair and why it exists.", `
<h1>About SendFair</h1>
<p>Sending money home is one of the most regular bills in a diaspora household, and one of the least transparent. A transfer that says "zero fees" can still lose several percent in the exchange rate.</p>
<p>SendFair shows one number clearly: how much actually lands at home. We cover the routes most used by Africans in the United States, the United Kingdom, Canada and Australia, and by the many who work in the Gulf (the UAE, Saudi Arabia, Qatar, Kuwait, Bahrain and Oman), sending to Nigeria, Ghana, Kenya, Uganda, Zambia and Zimbabwe.</p>
<p>The site is run independently from Nairobi, Kenya. We are not owned by any transfer company.</p>
<h2>How the numbers are made</h2>
<p>Every quote is read by hand from the provider's own public calculator or app, for a typical amount on each route, and saved with the time it was checked. Busy routes are checked every day and quieter ones at least every two days. Each row on a route page shows when it was checked, and quotes that are too old are marked or removed. The full method is on <a href="${link("../", "methodology/")}">How we rank</a>.</p>
<h2>Editorial independence</h2>
<p>Services are ranked only by how much your family receives. Some providers pay us a referral commission, but no provider can pay to appear, to rank higher or to have a quote removed, and services that pay us nothing are listed on the same terms. See <a href="${link("../", "disclosure/")}">how we make money</a>.</p>
<h2>Corrections</h2>
<p>If a figure here doesn't match what a provider shows you, tell us with the route, the amount and a screenshot if you can. We recheck it and fix the page, usually the same day.</p>
<h2>Contact</h2><p>Corrections, partnership enquiries and provider updates: <span class="email">${esc(config.contactEmail)}</span></p>`],
  "methodology/": ["How we rank", "How SendFair collects rates and ranks money transfer services.", `
<h1>How we rank</h1>
<h2>What we collect</h2>
<ul><li>The exchange rate each provider quotes on each route, and the amount we checked it for.</li><li>The transfer fee: a fixed amount, a percentage, or both.</li><li>The ways the money can be received (mobile money, bank, cash pickup). Where a provider's rate differs by payout method, we record each one separately.</li><li>The typical delivery time and when we checked.</li></ul>
<p>Quotes are checked by hand from each provider's public calculator or app. Busy routes are checked every day, quieter routes at least every two days.</p>
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
<p>We show what the same transfer would deliver at ${config.regionalAverageCost.percent}% total cost, the ${esc(config.regionalAverageCost.label)}, from the World Bank's Remittance Prices Worldwide report.</p>
<h2>Commissions never change the order</h2><p>Results are sorted only by the amount received. See <a href="${link("../", "disclosure/")}">how we make money</a>.</p>`],
  "disclosure/": ["How we make money", "SendFair's affiliate and advertising disclosure.", `
<h1>How we make money</h1>
<p>SendFair is free to use. We earn money in two ways:</p>
<ul><li><strong>Referral commissions.</strong> Some "Go to" buttons are affiliate links. If you open an account and make your first transfer, the provider may pay us a fee. You pay the same either way.</li><li><strong>Advertising.</strong> Some pages may show ads served by Google.</li></ul>
<p>Neither affects the ranking. Results are sorted only by how much your recipient receives. Providers that pay us nothing appear and rank on the same terms.</p>`],
  "privacy/": ["Privacy policy", "How SendFair handles your data.", `
<h1>Privacy policy</h1>
<p>Last updated ${today}.</p>
<h2>What we collect and why</h2>
<ul>${privacyItems}</ul>
<h2>Your rights</h2>
<p>If you are in the UK or Europe, data protection law gives you the right to ask what we hold about you, to have it corrected or deleted, and to object to its use. You can also complain to your data protection authority (the ICO in the UK). In practice we hold very little: usually only your email address, if you signed up for alerts.</p>
<h2>Links to providers</h2><p>When you follow a link to a transfer service, that service's own privacy policy applies.</p>
<h2>Contact</h2><p>For any privacy request: <span class="email">${esc(config.contactEmail)}</span></p>`],
  "terms/": ["Terms of use", "Terms for using SendFair.", `
<h1>Terms of use</h1>
<p>Last updated ${today}.</p>
<p>SendFair provides information to help you compare money transfer services. It is not financial advice, and we are not a money transfer business.</p>
<p>We work to keep rates accurate, but they change through the day and can differ on the provider's site. Always confirm the final amount, fee and delivery time with the provider before paying. We are not responsible for transfers you make with any provider, or for losses from relying on a rate shown here.</p>
<p>Delivery-time reports come from other visitors and are shown as they are given.</p>
<p>Provider names belong to their owners. Their appearance here does not mean they endorse SendFair.</p>`]
};
for (const [rel, [title, desc, html]] of Object.entries(trust)) {
  write(rel + "index.html", page({ prefix: "../", canonical: rel, title: `${title} · ${config.siteName}`, description: desc, body: `<section class="block page"><div class="wrap"><article class="prose">${html}</article></div></section>` }));
  urls.push(rel);
}

write("offline.html", page({ prefix: "/", canonical: null, title: `You're offline · ${config.siteName}`, description: "No connection.", noindex: true, body: `<section class="block page"><div class="wrap"><article class="prose"><h1>You're offline</h1><p>SendFair needs a connection to show today's rates. Pages you opened recently still work; this one wasn't saved yet.</p><p><a class="btn" href="/">Try again</a></p></article></div></section>` }));
write("404.html", page({ prefix: "/", canonical: null, title: `Page not found · ${config.siteName}`, description: "Page not found.", noindex: true, body: `<section class="block page"><div class="wrap"><article class="prose"><h1>That page isn't here</h1><p>The link may be old or mistyped. Today's rankings are one click away.</p><p><a class="btn" href="/">Compare transfers</a></p></article></div></section>` }));

// Rate Desk (never indexed)
fs.mkdirSync(path.join(OUT, "admin"), { recursive: true });
fs.writeFileSync(path.join(OUT, "admin/index.html"), fs.readFileSync(path.join(ROOT, "src/admin.html"), "utf8").replace(/assets\/fonts\.css(?!\?)/g, `assets/fonts.css?v=${V.fonts}`).replace(/assets\/rank\.js(?!\?)/g, `assets/rank.js?v=${V.rank}`));

// SEO and hosting files
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${site}/${u}</loc><lastmod>${today}</lastmod></url>`).join("\n")}\n</urlset>\n`);
write("robots.txt", `User-agent: *\nDisallow: /admin/\nDisallow: /go/\nDisallow: /api/\nSitemap: ${site}/sitemap.xml\n`);
// Installable app: the manifest and a small service worker that keeps the last pages viewed for offline use.
write("manifest.webmanifest", JSON.stringify({
  name: "SendFair: compare money transfers to Africa", short_name: "SendFair",
  description: "See which service delivers the most money home today.",
  start_url: "/?source=app", scope: "/", display: "standalone", background_color: "#ffffff", theme_color: "#ffffff",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]
}, null, 2));
if (!PREVIEW) write("sw.js", fs.readFileSync(path.join(ROOT, "src/sw.js"), "utf8").replace("__VERSION__", V.css + V.app + V.rank));
write("_headers", `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN
  Permissions-Policy: camera=(), microphone=(), geolocation=()
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
/sw.js
  Cache-Control: no-cache
/manifest.webmanifest
  Content-Type: application/manifest+json
  Cache-Control: public, max-age=86400
/admin/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store
`);

console.log(`Built ${urls.length} pages into ${path.relative(ROOT, OUT)}${DEMO ? " (demo data)" : ""}${PREVIEW ? " (preview links)" : ""}`);
