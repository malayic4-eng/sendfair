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

// Logo: the "App Tile". Indigo rounded square, marigold S, and an F whose top bar ends in an arrow (money on its way).
const tile = (fill, ring, size) => `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><rect x="1" y="1" width="62" height="62" rx="16" fill="${fill}"/><rect x="4.5" y="4.5" width="55" height="55" rx="13" fill="none" stroke="#f6b52b" stroke-width="${ring}" opacity=".7"/><g transform="translate(32 32) scale(1.05) translate(-32 -32)" fill="#f6b52b"><path transform="translate(15.52 42.2) scale(.0275 -.0275)" d="M318 -14Q251 -14 199 0Q147 13 110 40Q73 67 54 107Q34 146 32 197L177 239Q180 195 199 167Q219 139 252 125Q285 112 326 112Q363 112 389 121Q416 130 430 145Q444 161 444 179Q444 202 425 217Q407 232 374 243Q342 253 300 264Q253 276 207 290Q161 304 124 326Q87 349 64 384Q42 419 42 472Q42 535 74 580Q105 625 164 649Q224 674 306 674Q389 674 450 648Q511 623 544 575Q577 528 576 463L430 429Q430 458 422 481Q413 503 397 518Q382 534 358 541Q334 549 303 549Q268 549 244 541Q220 532 208 518Q196 504 196 485Q196 462 215 448Q233 433 267 422Q300 412 342 401Q385 391 430 377Q475 363 513 340Q552 318 576 281Q599 243 599 186Q599 123 566 78Q533 33 470 10Q407 -14 318 -14Z"/><path d="M33.2 22.2h11.2v-2.7l5.6 4.8-5.6 4.8v-2.7h-6.6v3.6h5.6v4.2h-5.6v8.1h-4.6z"/></g></svg>`;
const logo = tile("#111853", 1.1, 34);
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
${noindex || DEMO ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">'}
${canonical != null ? `<link rel="canonical" href="${site}/${canonical}">` : ""}
<meta property="og:site_name" content="${esc(config.siteName)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
${canonical != null ? `<meta property="og:url" content="${site}/${canonical}">` : ""}
${ogImg}
<meta name="theme-color" content="#1b2470">
<link rel="icon" href="${prefix}favicon.svg" type="image/svg+xml">
<link rel="icon" href="${prefix}favicon-48.png" sizes="48x48" type="image/png">
<link rel="apple-touch-icon" href="${prefix}apple-touch-icon.png">
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
<div class="foot-cols">
<div><h3>Send money to</h3><ul>${corridors.receivers.map((r) => `<li><a href="${link(prefix, hubPath(r))}">${esc(r.name)}</a></li>`).join("")}</ul></div>
<div><h3>Popular routes</h3><ul>${(config.priorityRoutes || []).map((k) => { const [a, b] = k.split("-"); const S = corridors.senders.find((x) => x.id === a), Rr = corridors.receivers.find((x) => x.id === b); return S && Rr ? `<li><a href="${link(prefix, corridorPath(S, Rr))}">${esc(S.label)} to ${esc(Rr.name)}</a></li>` : ""; }).join("")}</ul></div>
<div><h3>Services</h3><ul>${providersWithQuotes().map((p) => `<li><a href="${link(prefix, provPath(p))}">${esc(p.name)}</a></li>`).join("")}</ul></div>
</div>
<nav aria-label="Footer"><a href="${link(prefix, "about/")}">About</a><a href="${link(prefix, "methodology/")}">How we rank</a><a href="${link(prefix, "disclosure/")}">How we make money</a><a href="${link(prefix, "privacy/")}">Privacy</a><a href="${link(prefix, "terms/")}">Terms</a></nav>
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
${phone(ctx)}
</div></section>
<section class="sheet"><div class="wrap">
<div class="tool">
  <div class="controls">
    <div class="field"><label for="sf-from">Sending from</label><select id="sf-from">${corridors.senders.map((s) => `<option value="${s.id}"${s.id === ctx.s.id ? " selected" : ""}>${esc(s.label)} (${s.currency})</option>`).join("")}</select></div>
    <div class="field"><label for="sf-to">Sending to</label><select id="sf-to">${corridors.receivers.map((r) => `<option value="${r.id}"${r.id === ctx.r.id ? " selected" : ""}>${esc(r.name)} (${r.currency})</option>`).join("")}</select></div>
    <div class="field"><label for="sf-amount">You pay in total</label><div class="amount-wrap"><span id="sf-cur">${ctx.s.currency}</span><input id="sf-amount" type="number" inputmode="decimal" min="1" step="any" value="${ctx.amount}"></div></div>
    <div class="field payout-field"><span class="label" id="sf-payout-label">They receive by</span><div class="payout-tabs" role="group" aria-labelledby="sf-payout-label">
      <button type="button" data-payout="all" aria-pressed="true">Any</button><button type="button" data-payout="mobile" aria-pressed="false">Mobile<span class="lg"> money</span></button><button type="button" data-payout="bank" aria-pressed="false">Bank</button><button type="button" data-payout="cash" aria-pressed="false">Cash</button>
    </div></div>
  </div>
  <div id="sf-results">${R.renderResults(ctx)}</div>
  <div class="tool-meta" id="sf-meta">${R.metaLine(ctx)}</div>
  <p class="note" id="sf-note"${ctx.r.note ? "" : " hidden"}>${esc(ctx.r.note)}</p>
</div>
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

// ---------- SEO helpers ----------
const CURNAME = { GBP: "British pounds", USD: "US dollars", CAD: "Canadian dollars", AUD: "Australian dollars", KES: "Kenyan shillings", NGN: "Nigerian naira", GHS: "Ghanaian cedis", UGX: "Ugandan shillings", ZMW: "Zambian kwacha" };
const STEP_AMOUNTS = { GBP: [100, 250, 500, 1000], USD: [100, 300, 500, 1000], CAD: [200, 400, 1000, 2000], AUD: [200, 450, 1000, 2000] };
const dateLong = new Date(quotesFile.updatedAt || NOW).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const hubPath = (r) => `send-money-to/${r.id}/`;
const provPath = (p) => `providers/${p.id}/`;
const joinList = (a) => a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : a.join("");
const networks = (r) => (r.payout.mobile || "").replace(/^Wallets such as /, "").split(/,| and /).map((x) => x.trim()).filter(Boolean);
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const providersWithQuotes = () => Object.values(providers).filter((p) => Object.values(quotes).some((list) => (list || []).some((q) => q.provider === p.id)));
const crumbs = (items) => ({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([name, rel], i) => ({ "@type": "ListItem", position: i + 1, name, item: `${site}/${rel}` })) });
const crumbNav = (prefix, items) => `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items.map(([name, rel], i) => i === items.length - 1 ? `<li aria-current="page">${esc(name)}</li>` : `<li><a href="${link(prefix, rel)}">${esc(name)}</a></li>`).join("")}</ol></nav>`;
const faqBlock = (faqs) => `<div class="faq">${faqs.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>`;
const faqLd = (faqs) => ({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });

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
  description: "Compare what actually arrives when you send money from the US, UK, Canada or Australia to Nigeria, Ghana, Kenya, Uganda, Zambia and Zimbabwe. Rates checked by hand.",
  jsonld: [{ "@context": "https://schema.org", "@type": "WebSite", name: config.siteName, url: site + "/" },
    { "@context": "https://schema.org", "@type": "Organization", name: config.siteName, url: site + "/", logo: `${site}/icon-512.png`, email: config.contactEmail, areaServed: ["GB", "US", "CA", "AU", "NG", "GH", "KE", "UG", "ZM", "ZW"] }],
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
<ul class="route-links big">${providersWithQuotes().map((p) => `<li><a href="${link("", provPath(p))}">${esc(p.name)} rates</a></li>`).join("")}</ul>
</div></section>` + alerts()
}));
urls.push("");

// Route pages
for (const s of corridors.senders) {
  for (const r of corridors.receivers) {
    const rel = corridorPath(s, r), prefix = "../../";
    const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]);
    const fresh = ctx.rows.filter((x) => !x.stale);
    const top = fresh[0], last = fresh[fresh.length - 1];
    const names = [...new Set(ctx.rows.map((x) => x.p.name))];
    const nets = networks(r);
    const rCur = CURNAME[r.currency] || r.currency, sCur = CURNAME[s.currency] || s.currency;
    const amt = plain(R.money(ctx.amount, s.currency, 0));
    const title = cap(`Send money from ${s.short} to ${r.name}: best ${s.currency} to ${r.currency} rate today`);
    const description = top
      ? `${top.p.name} delivers the most today: ${plain(R.money(top.gets, r.currency))} for ${amt}. Compare ${joinList(names.slice(0, 4))} by what arrives in ${r.name}${nets.length ? ` via ${joinList(nets.slice(0, 2))}, bank or cash pickup` : ""}.`
      : `Compare money transfer services from ${s.short} to ${r.name} by what actually arrives in ${rCur}, after fees and the exchange-rate markup. Rates checked by hand.`;
    const lede = `Compare ${esc(names.length ? joinList(names.slice(0, 6)) : "transfer services")} by how many ${esc(rCur)} arrive in ${esc(r.name)}${nets.length ? `, by ${esc(joinList(nets))}, bank or cash pickup` : ""}. Checked by hand, ${esc(dateLong)}.`;
    const mobileProv = [...new Set(fresh.filter((x) => (x.q.payout || []).includes("mobile")).map((x) => x.p.name))];
    const midTxt = ctx.mid ? `1 ${s.currency} = ${R.rateStr(ctx.mid)} ${r.currency}` : "";
    const summary = top ? `<p>On ${esc(dateLong)}, <strong>${esc(top.p.name)}</strong> delivers the most from ${esc(s.short)} to ${esc(r.name)}: <strong>${esc(plain(R.money(top.gets, r.currency)))}</strong> for ${esc(amt)}, at a rate of ${R.rateStr(top.ev.rate)} with ${esc(R.feeStr(top.q, s.currency).toLowerCase())}.${last && last !== top ? ` The lowest of the ${fresh.length} services we checked, ${esc(last.p.name)}, delivers ${esc(plain(R.money(last.gets, r.currency)))}, so choosing well is worth ${esc(plain(R.money(top.gets - last.gets, r.currency)))} on this one transfer.` : ""}${midTxt ? ` The mid-market rate is ${esc(midTxt)}.` : ""}</p>` : "";
    const faqs = [
      [`What is the cheapest way to send money from ${s.short} to ${r.name} today?`, top ? `Today ${top.p.name} delivers the most: ${plain(R.money(top.gets, r.currency))} for ${amt}, after its fee and exchange-rate margin. The order changes from day to day, so check the ranking on this page before each transfer.` : `It changes from day to day. The ranking on this page shows which service delivers the most ${rCur} for the amount you enter, after the transfer fee and the exchange-rate markup.`],
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
<section class="block"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h2>${esc(s.currency)} to ${esc(r.currency)}: today's rates by service</h2>
${summary}
${amountsTable(ctx)}
<h2>How to send money from ${esc(s.short)} to ${esc(r.name)}</h2>
<ol class="howto">
<li><strong>Compare today's options.</strong> Enter the amount you will pay above. The service at the top delivers the most ${esc(rCur)} after its fee and exchange-rate margin.</li>
<li><strong>Open an account with the provider.</strong> UK, US, Canadian and Australian providers must check your identity, so have photo ID ready. Your first transfer may take longer while this is done.</li>
<li><strong>Add your recipient.</strong> For mobile money${nets.length ? ` (${esc(joinList(nets))})` : ""}, you need their phone number registered for the wallet. For a bank deposit, their account number and bank. For cash pickup, their full name exactly as on their ID.</li>
<li><strong>Pay and track the transfer.</strong> Bank transfers are often cheapest to pay with; cards can add a fee. Check the final amount on the provider's screen before you confirm.</li>
</ol>
<h2>Ways to receive money in ${esc(r.name)}</h2>
<ul class="payout-list">${Object.entries(r.payout).map(([k, v]) => `<li><span>${R.LABEL[k]}</span><span>${esc(v)}</span></li>`).join("")}</ul>
${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
<h2>Questions about sending money to ${esc(r.name)}</h2>
${faqBlock(faqs)}
<h2>Other routes</h2>
<ul class="route-links">${corridors.receivers.filter((x) => x.id !== r.id).map((x) => `<li><a href="${link(prefix, corridorPath(s, x))}">${esc(s.label)} to ${esc(x.name)}</a></li>`).join("")}${corridors.senders.filter((x) => x.id !== s.id).map((x) => `<li><a href="${link(prefix, corridorPath(x, r))}">${esc(x.label)} to ${esc(r.name)}</a></li>`).join("")}</ul>
</div></div></section>` + reportSection(ctx) + alerts();
    write(rel + "index.html", page({
      prefix, canonical: rel, title, description, og: slug(s, r),
      jsonld: [faqLd(faqs), crumbs(trail)],
      init: { from: s.id, to: r.id, pageUrl: `${site}/${rel}` }, body
    }));
    urls.push(rel);
  }
}

// Country pages: "Send money to Kenya"
for (const r of corridors.receivers) {
  const rel = hubPath(r), prefix = "../../";
  const nets = networks(r), rCur = CURNAME[r.currency] || r.currency;
  const lines = corridors.senders.map((s) => {
    const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]);
    return { s, ctx, top: ctx.rows.find((x) => !x.stale) };
  });
  const names = [...new Set(lines.flatMap((l) => l.ctx.rows.map((x) => x.p.name)))];
  const faqs = [
    [`What is the cheapest way to send money to ${r.name}?`, `It depends on where you send from and how much. Today: ${lines.filter((l) => l.top).map((l) => `from ${l.s.short}, ${l.top.p.name} (${plain(R.money(l.top.gets, r.currency))} for ${plain(R.money(l.ctx.amount, l.s.currency, 0))})`).join("; ") || "rates are being checked"}.`],
    [`How can people in ${r.name} receive money from abroad?`, Object.entries(r.payout).map(([k, v]) => `${R.LABEL[k]}: ${v}`).join(". ") + "."],
    [`Which services send money to ${r.name}?`, names.length ? `We compare ${joinList(names)} on routes to ${r.name}, ranked by the amount that arrives.` : `Several international services send to ${r.name}; we are checking today's rates.`]
  ];
  const trail = [[config.siteName, ""], [`Send money to ${r.name}`, rel]];
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>Send money to ${esc(r.name)}</h1>
<p class="lede">Compare what arrives in ${esc(r.name)} from the UK, the US, Canada and Australia, in ${esc(rCur)}${nets.length ? ` by ${esc(joinList(nets))}, bank or cash pickup` : ""}. Ranked by the amount your family receives, checked by hand ${esc(dateLong)}.</p>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">Sending from</th><th scope="col">You pay</th><th scope="col">Best today</th><th scope="col" class="num">They get</th><th scope="col"></th></tr></thead>
<tbody>${lines.map((l) => `<tr><th scope="row">${esc(l.s.name)}</th><td class="num">${esc(plain(R.money(l.ctx.amount, l.s.currency, 0)))}</td><td>${l.top ? esc(l.top.p.name) : "Being checked"}</td><td class="num top">${l.top ? esc(plain(R.money(l.top.gets, r.currency))) : "–"}</td><td><a href="${link(prefix, corridorPath(l.s, r))}">Compare all</a></td></tr>`).join("")}</tbody>
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
    title: `Send money to ${r.name}: best rates from the UK, US, Canada and Australia`,
    description: `Compare money transfers to ${r.name} by what arrives in ${rCur}${nets.length ? ` via ${joinList(nets.slice(0, 2))}, bank or cash pickup` : ""}. Today's best service from each country, checked by hand.`,
    jsonld: [faqLd(faqs), crumbs(trail)], body }));
  urls.push(rel);
}

// Provider pages: "Wise rates to Africa today"
for (const p of providersWithQuotes()) {
  const rel = provPath(p), prefix = "../../";
  const lines = [];
  for (const s of corridors.senders) for (const r of corridors.receivers) {
    const ctx = routeContext(s, r, prefix, config.defaultAmounts[s.currency]);
    const i = ctx.rows.findIndex((x) => x.p.id === p.id);
    if (i >= 0) lines.push({ s, r, ctx, x: ctx.rows[i], pos: i + 1, of: ctx.rows.length });
  }
  const firsts = lines.filter((l) => l.pos === 1 && !l.x.stale).length;
  const countries = [...new Set(lines.map((l) => l.r.name))];
  const notes = [...new Set(lines.map((l) => l.x.q.note).filter(Boolean))];
  const trail = [[config.siteName, ""], [`${p.name} rates`, rel]];
  const faqs = [
    [`Is ${p.name} the cheapest way to send money to Africa?`, `On the routes we checked today, ${p.name} delivers the most on ${firsts} of ${lines.length}. Which service is cheapest depends on the route and the amount, so compare before each transfer.`],
    [`Which countries does ${p.name} send to that SendFair compares?`, `${joinList(countries)}, from ${joinList([...new Set(lines.map((l) => l.s.short))])}.`]
  ];
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>${esc(p.name)} rates to Africa today</h1>
<p class="lede">${esc(p.name)}'s exchange rates and fees on ${lines.length} routes to ${esc(joinList(countries))}, checked by hand ${esc(dateLong)}, and how it ranks against other services on each route. Today it delivers the most on ${firsts} of ${lines.length} routes.</p>
<div class="table-wrap"><table class="rates-table">
<thead><tr><th scope="col">Route</th><th scope="col">Rate</th><th scope="col">Fee</th><th scope="col">You pay</th><th scope="col" class="num">They get</th><th scope="col">Rank</th></tr></thead>
<tbody>${lines.map((l) => `<tr><th scope="row"><a href="${link(prefix, corridorPath(l.s, l.r))}">${esc(l.s.label)} to ${esc(l.r.name)}</a></th><td class="num">${R.rateStr(l.x.ev.rate)}</td><td>${esc(R.feeStr(l.x.q, l.s.currency).replace(/^Fee /, ""))}</td><td class="num">${esc(plain(R.money(l.ctx.amount, l.s.currency, 0)))}</td><td class="num${l.pos === 1 ? " top" : ""}">${esc(plain(R.money(l.x.gets, l.r.currency)))}</td><td>${l.x.stale ? "Not rechecked" : `${ordinal(l.pos)} of ${l.of}`}</td></tr>`).join("")}</tbody>
</table></div>
${notes.length ? `<p class="note">${notes.map(esc).join(" ")}</p>` : ""}
<p><a class="btn" href="${esc(hrefFor(prefix)(p, "provider-page"))}" target="_blank" rel="sponsored nofollow noopener">Go to ${esc(p.name)}</a></p>
<h2>Questions about ${esc(p.name)}</h2>
${faqBlock(faqs)}
<h2>Other services we compare</h2>
<ul class="route-links">${providersWithQuotes().filter((o) => o.id !== p.id).map((o) => `<li><a href="${link(prefix, provPath(o))}">${esc(o.name)}</a></li>`).join("")}</ul>
</div></div></section>`;
  write(rel + "index.html", page({ prefix, canonical: rel, og: "home",
    title: `${p.name} rates and fees to ${countries.length > 3 ? countries.slice(0, 3).join(", ") + " and more" : joinList(countries)} today`,
    description: `${p.name}'s exchange rates and fees from the UK, US, Canada and Australia to ${joinList(countries)}, checked by hand, with how it ranks against other services on each route.`,
    jsonld: [faqLd(faqs), crumbs(trail)], body }));
  urls.push(rel);
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
