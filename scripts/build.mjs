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

// Hand-checked corrections for currencies where the free feed is off (ignored after 72 hours).
try {
  const ov = JSON.parse(fs.readFileSync(path.join(ROOT, "data/mid-overrides.json"), "utf8"));
  if (ov && ov.rates && NOW - new Date(ov.updatedAt).getTime() < 72 * 3600000 && midmarket.rates) Object.assign(midmarket.rates, ov.rates);
} catch {}
const providers = Object.fromEntries(providersFile.providers.map((x) => [x.id, x]));
const esc = R.esc;
const plain = (s) => String(s).replace(/ /g, " ");
const site = config.siteUrl.replace(/\/$/, "");
const staleH = config.staleAfterHours || 36, hideH = config.hideAfterHours || 72;

// ---------- demo data (preview only, bannered on every page) ----------
let demoReports = null;
if (DEMO) {
  const rates = { USD: 1, GBP: 0.75, CAD: 1.39, AUD: 1.52, NGN: 1460, GHS: 11.2, KES: 129.2, UGX: 3640, ZMW: 23.6 };
  midmarket = { base: "USD", updatedAt: new Date(NOW - 3 * 3600000).toISOString(), source: "Example figures", demo: true, rates };
  const pick = ["lemfi", "wise", "worldremit", "remitly", "sendwave", "taptapsend", "afriex", "nala", "westernunion", "mukuru"];
  const out = {}, coverage = {}, reps = {};
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const buckets = ["Under 1 hour", "Same day", "1–2 days"];
  for (const s of corridors.senders) {
    for (const r of corridors.receivers) {
      const k = `${s.id}-${r.id}`, mid = rates[r.currency] / rates[s.currency], ref = config.defaultAmounts[s.currency];
      const list = [], used = new Set(), n = 4 + Math.floor(rnd() * 3);
      while (used.size < n) {
        const id = pick[Math.floor(rnd() * pick.length)];
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

const logo = `<svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15.5" fill="#f6b52b"/><path d="M8 19.5c3-7 10-9 15-6" stroke="#1b2470" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M19.8 10.6l3.6 2.8-3.1 3.2" stroke="#1b2470" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="23" r="2.4" fill="#1b2470"/></svg>`;
const favicon = "data:image/svg+xml," + encodeURIComponent(logo);
const wallet = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><rect x="4" y="8" width="16" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="16" cy="13.5" r="1.4" fill="currentColor"/></svg>`;

function routeContext(s, r, prefix, amount) {
  const k = `${s.id}-${r.id}`;
  const mid = R.midRate(midmarket, s.currency, r.currency);
  const list = quotes[k] || [];
  const rows = R.rank({ list, providers, amount, payout: "all", mid, now: NOW, staleH, hideH });
  const cov = coverage[k] && coverage[k].length ? coverage[k] : Object.keys(providers);
  return {
    s, r, key: k, amount, payout: "all", mid, rows, now: NOW, timeStyle: "absolute", anyQuotes: list.length > 0, reports: demoReports ? demoReports.routes[k] : {},
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
<link rel="stylesheet" href="${prefix}assets/fonts.css">`;
  const ogImg = hasOg ? `<meta property="og:image" content="${site}/og/${og}.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`;
  return `<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${PREVIEW ? '<meta name="claude:viewport-fit-sides" content="cover">' : ""}
${noindex || DEMO ? '<meta name="robots" content="noindex">' : ""}
${canonical != null ? `<link rel="canonical" href="${site}/${canonical}">` : ""}
<meta property="og:site_name" content="${esc(config.siteName)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
${canonical != null ? `<meta property="og:url" content="${site}/${canonical}">` : ""}
${ogImg}
<meta name="theme-color" content="#1b2470">
<link rel="icon" href="${favicon}">
${fonts}
<link rel="stylesheet" href="${prefix}assets/style.css">
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
<nav aria-label="Footer"><a href="${link(prefix, "about/")}">About</a><a href="${link(prefix, "methodology/")}">How we rank</a><a href="${link(prefix, "disclosure/")}">How we make money</a><a href="${link(prefix, "privacy/")}">Privacy</a><a href="${link(prefix, "terms/")}">Terms</a></nav>
<p>SendFair compares money transfer services. We do not send, hold or exchange money. Rates change through the day; always confirm the final amount on the provider's own screen before you pay.</p>
<p>Mid-market reference rates by <a href="https://www.exchangerate-api.com" rel="noopener" target="_blank">ExchangeRate-API</a>.</p>
<p>&copy; ${new Date(NOW).getUTCFullYear()} ${esc(config.siteName)}. Run independently from Nairobi. Contact: <span class="email">${esc(config.contactEmail)}</span></p>
</div></footer>`;
}

function phone(ctx) {
  const n = R.notice(ctx);
  const home = R.homeTime(ctx.r.id, NOW);
  return `<figure class="phone" id="sf-phone">
<div class="phone-body"><div class="phone-screen">
  <div class="lock" aria-hidden="true"><span class="lock-city" id="sf-ph-city">${esc(home.city)}</span><span class="lock-time" id="sf-ph-time">${home.time}</span><span class="lock-date" id="sf-ph-date">${home.date}</span></div>
  <div class="notif" id="sf-notif"><span class="notif-icon">${wallet}</span><div class="notif-main"><div class="notif-head"><strong id="sf-ph-title">${n.title}</strong><span>now</span></div><p id="sf-ph-text">${n.text}</p></div></div>
</div></div>
<figcaption id="sf-ph-cap">${n.cap}</figcaption>
</figure>`;
}

function tool({ heading, sub, proof, ctx }) {
  return `<section class="hero"><div class="wrap hero-grid">
<div class="hero-copy"><h1>${heading}</h1><p class="lede">${sub}</p>${proof ? `<p class="proof">${proof}</p>` : ""}</div>
${phone(ctx)}
</div></section>
<section class="sheet"><div class="wrap">
<div class="tool">
  <div class="tool-row">
    <div class="field"><label for="sf-from">Sending from</label><select id="sf-from">${corridors.senders.map((s) => `<option value="${s.id}"${s.id === ctx.s.id ? " selected" : ""}>${esc(s.name)} (${s.currency})</option>`).join("")}</select></div>
    <div class="field"><label for="sf-to">Sending to</label><select id="sf-to">${corridors.receivers.map((r) => `<option value="${r.id}"${r.id === ctx.r.id ? " selected" : ""}>${esc(r.name)} (${r.currency})</option>`).join("")}</select></div>
    <div class="field"><label for="sf-amount">You pay in total</label><div class="amount-wrap"><span id="sf-cur">${ctx.s.currency}</span><input id="sf-amount" type="number" inputmode="decimal" min="1" step="any" value="${ctx.amount}"></div></div>
  </div>
  <div class="payout-row"><span class="label" id="sf-payout-label">They receive by</span><div class="payout-tabs" role="group" aria-labelledby="sf-payout-label">
    <button type="button" data-payout="all" aria-pressed="true">Any way</button><button type="button" data-payout="mobile" aria-pressed="false">Mobile money</button><button type="button" data-payout="bank" aria-pressed="false">Bank</button><button type="button" data-payout="cash" aria-pressed="false">Cash pickup</button>
  </div></div>
  <div class="tool-meta" id="sf-meta">${R.metaLine(ctx)}</div>
  <p class="note" id="sf-note"${ctx.r.note ? "" : " hidden"}>${esc(ctx.r.note)}</p>
  <div id="sf-results">${R.renderResults(ctx)}</div>
</div>
${shareBar(ctx)}
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
      const top = c.rows.find((x) => !x.stale);
      return `<li><a href="${link(prefix, corridorPath(s, r))}"><span class="b-country">${esc(r.name)}</span>${top
        ? `<span class="b-amt num">${R.moneyHtml(top.gets, r.currency)}</span><span class="b-prov">with ${esc(top.p.name)}</span>`
        : `<span class="b-amt b-wait">Being checked</span><span class="b-prov">${s.currency} to ${r.currency}</span>`}</a></li>`;
    }).join("");
    return `<div class="board-col"><h3>From ${esc(s.short)}</h3><p class="board-sub">Best result for <span class="num">${esc(R.money(amount, s.currency, 0))}</span></p><ul>${rows}</ul></div>`;
  };
  return `<section class="block" id="corridors"><div class="wrap">
<div class="section-head"><h2>Today's best on every route</h2><p class="lede">What arrives for a typical transfer, from the service that delivers the most. Open a route to compare every service and enter your own amount.</p></div>
<div class="board">${corridors.senders.map(col).join("")}</div>
</div></section>`;
}

function page({ prefix, title, description, canonical, body, jsonld, noindex, init, bodyOnly, og }) {
  const sf = {
    root: prefix, siteUrl: site, disclosureHref: link(prefix, "disclosure/"),
    routeUrl: link(prefix, "send-money/{from}-to-{to}/"),
    config: { defaultAmounts: config.defaultAmounts, staleAfterHours: staleH, hideAfterHours: hideH, regionalAverageCost: config.regionalAverageCost,
      trackClicks: !!config.trackClicks && !DEMO, reportsEnabled: !!config.reportsEnabled && !DEMO, demo: DEMO },
    ...(init || {})
  };
  const scripts = `<script>window.SF=${JSON.stringify(sf)};</script><script src="${prefix}assets/rank.js" defer></script><script src="${prefix}assets/app.js" defer></script>`;
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

// ---------- build ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
for (const f of ["style.css", "app.js", "rank.js", "fonts.css"]) fs.copyFileSync(path.join(ROOT, "src", f), path.join(OUT, "assets", f));
copyDir(path.join(ROOT, "src/fonts"), path.join(OUT, "assets/fonts"));
copyDir(path.join(ROOT, "src/og"), path.join(OUT, "og"));
write("data/corridors.json", JSON.stringify(corridors));
write("data/providers.json", JSON.stringify(providersFile));
write("data/quotes.json", JSON.stringify(quotesFile));
write("data/midmarket.json", JSON.stringify(midmarket));
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
  ? `${quotedProviders} services compared on ${quotedRoutes} routes, checked by hand. Commissions never change the order.`
  : "Rates checked by hand. Commissions never change the order.";
const homeCtx = routeContext(S0, R0, "", config.defaultAmounts[S0.currency]);
write("index.html", page({
  prefix: "", canonical: "", bodyOnly: PREVIEW, og: "home",
  title: PREVIEW ? config.siteName : `${config.siteName}: compare money transfers to Africa`,
  description: "Compare what actually arrives when you send money from the US, UK, Canada or Australia to Nigeria, Ghana, Kenya, Uganda, Zambia and Zimbabwe. Rates checked by hand.",
  jsonld: [{ "@context": "https://schema.org", "@type": "WebSite", name: config.siteName, url: site + "/" }],
  body: tool({
    ctx: homeCtx,
    heading: "Send more home.",
    sub: "We compare money transfer services and rank them by what your family actually receives, after the fee and the exchange-rate markup.",
    proof: homeProof
  }) + corridorGrid("") + `
<section class="block steps-block"><div class="wrap">
<div class="section-head"><h2>How the ranking works</h2></div>
<ol class="steps">
<li><h3>We check each provider</h3><p>We record the rate and fee each service quotes on every route, how the money can be received, and when we checked.</p></li>
<li><h3>We do the maths for your amount</h3><p>Fees come off what you pay and the rest converts at the provider's rate. That gives the amount that actually arrives.</p></li>
<li><h3>Most money home ranks first</h3><p>Commissions never change the order. A service that pays us nothing can rank first.</p></li>
</ol></div></section>` + alerts()
}));
urls.push("");

// Route pages
for (const s of corridors.senders) {
  for (const r of corridors.receivers) {
    const rel = corridorPath(s, r), prefix = "../../";
    const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]);
    const top = ctx.rows.find((x) => !x.stale);
    const title = top
      ? cap(`Send money from ${s.short} to ${r.name}: ${plain(R.money(top.gets, r.currency))} for ${plain(R.money(ctx.amount, s.currency, 0))} today`)
      : cap(`Send money from ${s.short} to ${r.name}: compare today's rates`);
    const names = [...new Set(ctx.rows.map((x) => x.p.name))];
    const nameList = names.length > 4 ? names.slice(0, 3).join(", ") + ` and ${names.length - 3} more`
      : names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names.join("");
    const description = top
      ? `${top.p.name} delivers the most today: ${plain(R.money(top.gets, r.currency))} for ${plain(R.money(ctx.amount, s.currency, 0))}. Compare ${nameList} on what actually arrives in ${r.name}, after fees and the exchange-rate markup.`
      : `Compare money transfer services from ${s.short} to ${r.name} by what actually arrives, after fees and the exchange-rate markup. Rates checked by hand.`;
    const faqs = [
      [`What is the cheapest way to send money from ${s.short} to ${r.name}?`, `It changes from day to day. The ranking on this page shows which service delivers the most ${r.currency} for the amount you enter, after the transfer fee and the exchange-rate markup.`],
      [`Why do you compare against the mid-market rate?`, `The mid-market rate is the midpoint between buying and selling prices on currency markets. Providers add a margin on top of it, so the gap between their rate and the mid-market rate is a hidden cost, even when the fee says zero.`],
      [`How can people in ${r.name} receive the money?`, Object.entries(r.payout).map(([k, v]) => `${R.LABEL[k]}: ${v}`).join(". ") + "."],
      [`Is ${config.siteName} a money transfer service?`, `No. We compare services and send you to the provider to complete your transfer. We never hold your money or your card details.`]
    ];
    const body = tool({
      ctx,
      heading: `Send money from ${esc(s.short)} to ${esc(r.name)}`,
      sub: `Today's ranking of transfer services by how much arrives in ${esc(r.name)}. Change the amount or the way they receive to see your own numbers.`
    }) + reportSection(ctx) + `
<section class="block"><div class="wrap"><div class="prose">
<h2>Ways to receive money in ${esc(r.name)}</h2>
<ul class="payout-list">${Object.entries(r.payout).map(([k, v]) => `<li><span>${R.LABEL[k]}</span><span>${esc(v)}</span></li>`).join("")}</ul>
${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
<h2>Common questions</h2>
<div>${faqs.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>
<h2>Other routes</h2>
<ul class="route-links">${corridors.receivers.filter((x) => x.id !== r.id).map((x) => `<li><a href="${link(prefix, corridorPath(s, x))}">${esc(s.label)} to ${esc(x.name)}</a></li>`).join("")}${corridors.senders.filter((x) => x.id !== s.id).map((x) => `<li><a href="${link(prefix, corridorPath(x, r))}">${esc(x.label)} to ${esc(r.name)}</a></li>`).join("")}</ul>
</div></div></section>` + alerts();
    write(rel + "index.html", page({
      prefix, canonical: rel, title, description, og: slug(s, r),
      jsonld: [
        { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
        { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
          { "@type": "ListItem", position: 1, name: config.siteName, item: site + "/" },
          { "@type": "ListItem", position: 2, name: `${s.label} to ${r.name}`, item: `${site}/${rel}` }] }
      ],
      init: { from: s.id, to: r.id, pageUrl: `${site}/${rel}` }, body
    }));
    urls.push(rel);
  }
}

// Trust pages
const today = new Date(NOW).toISOString().slice(0, 10);
const privacyItems = [
  `<li><strong>Your comparison choices.</strong> Your route, amount and payout choice are saved only in your own browser so the tool remembers them. They are not sent to us.</li>`,
  config.newsletterFormAction ? `<li><strong>Email for rate alerts.</strong> If you sign up, your email address is stored by ${esc(config.emailProvider || "our email service")} to send the alerts. Every message has an unsubscribe link.</li>` : "",
  config.reportsEnabled ? `<li><strong>Delivery-time reports.</strong> When you report how long a transfer took, we store the route, the service and the time range only. To stop repeated reports we keep a one-way scrambled code made from your connection for two days; we cannot turn it back into your IP address.</li>` : "",
  config.trackClicks ? `<li><strong>Link clicks.</strong> We count how many times each "Go to" button is clicked on each route. The count is not linked to you.</li>` : "",
  config.impactScriptId ? `<li><strong>Affiliate tracking.</strong> Our pages load a script from Impact, an affiliate network some providers use. It records when a page is viewed and when you follow a link to a provider, so the provider can credit us if you sign up. It does not change the ranking.</li>` : "",
  config.cfAnalyticsToken ? `<li><strong>Visit statistics.</strong> We use Cloudflare Web Analytics, which counts visits without cookies and without building a profile of you.</li>` : "",
  config.adsenseClient ? `<li><strong>Advertising.</strong> Some pages show ads from Google. Visitors in the UK and Europe are asked for consent before Google uses cookies for personalised ads. You can change your choice at any time from the privacy link Google adds to the page, and manage ads at adssettings.google.com.</li>` : "",
  `<li><strong>Hosting.</strong> The site is hosted by Cloudflare, which processes basic technical data (such as IP address) to deliver pages and protect against abuse.</li>`
].filter(Boolean).join("");

const trust = {
  "about/": ["About SendFair", "Who runs SendFair and why it exists.", `
<h1>About SendFair</h1>
<p>Sending money home is one of the most regular bills in a diaspora household, and one of the least transparent. A transfer that says "zero fees" can still lose several percent in the exchange rate.</p>
<p>SendFair shows one number clearly: how much actually lands at home. We cover the routes most used by Africans in the United States, the United Kingdom, Canada and Australia sending to Nigeria, Ghana, Kenya, Uganda, Zambia and Zimbabwe.</p>
<p>The site is run independently from Nairobi, Kenya. We are not owned by any transfer company.</p>
<h2>Contact</h2><p>Corrections, partnership enquiries and provider updates: <span class="email">${esc(config.contactEmail)}</span></p>`],
  "methodology/": ["How we rank", "How SendFair collects rates and ranks money transfer services.", `
<h1>How we rank</h1>
<h2>What we collect</h2>
<ul><li>The exchange rate each provider quotes on each route, and the amount we checked it for.</li><li>The transfer fee: a fixed amount, a percentage, or both.</li><li>The ways the money can be received (mobile money, bank, cash pickup). Where a provider's rate differs by payout method, we record each one separately.</li><li>The typical delivery time and when we checked.</li></ul>
<p>Quotes are checked by hand from each provider's public calculator or app. Busy routes are checked every day, quieter routes at least every two days.</p>
<h2>How the amount received is calculated</h2>
<p>You enter the total you plan to pay. We take off the provider's fee and convert the rest at the provider's rate. Where the fee is a percentage, it is worked out on the amount sent.</p>
<p>Total cost is the gap between that and converting your full amount at the mid-market rate with no fee.</p>
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

write("404.html", page({ prefix: "/", canonical: null, title: `Page not found · ${config.siteName}`, description: "Page not found.", noindex: true, body: `<section class="block page"><div class="wrap"><article class="prose"><h1>That page isn't here</h1><p>The link may be old or mistyped. Today's rankings are one click away.</p><p><a class="btn" href="/">Compare transfers</a></p></article></div></section>` }));

// Rate Desk (never indexed)
fs.mkdirSync(path.join(OUT, "admin"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "src/admin.html"), path.join(OUT, "admin/index.html"));

// SEO and hosting files
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${site}/${u}</loc><lastmod>${today}</lastmod></url>`).join("\n")}\n</urlset>\n`);
write("robots.txt", `User-agent: *\nDisallow: /admin/\nDisallow: /go/\nDisallow: /api/\nSitemap: ${site}/sitemap.xml\n`);
write("_headers", `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/data/*
  Cache-Control: public, max-age=300
/assets/fonts/*
  Cache-Control: public, max-age=31536000, immutable
/admin/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store
`);

console.log(`Built ${urls.length} pages into ${path.relative(ROOT, OUT)}${DEMO ? " (demo data)" : ""}${PREVIEW ? " (preview links)" : ""}`);
