// Shared, pure helpers for the Wise feed scripts (fetch-wise-feed, apply-wise-feed, mid-from-wise,
// check-data-fresh) and the build. No network and no file access here, so it can be tested with fixtures.

// Receive currencies used by more than one receiving country (e.g. USD: Zimbabwe and DR Congo;
// XOF: Senegal, Côte d'Ivoire, Mali). A currency-only quote can't tell those countries apart.
export function sharedCurrencies(corridors) {
  const n = {};
  for (const r of corridors.receivers || []) n[r.currency] = (n[r.currency] || 0) + 1;
  return new Set(Object.keys(n).filter((c) => n[c] > 1));
}

// Facts about a route key ("uk-zimbabwe"): currencies, receiver ISO2, and whether the receive currency is shared.
export function routeInfo(corridors, route) {
  const [sid, rid] = String(route).split("-");
  const s = (corridors.senders || []).find((x) => x.id === sid);
  const r = (corridors.receivers || []).find((x) => x.id === rid);
  if (!s || !r) return null;
  return { s, r, iso2: r.iso2, shared: sharedCurrencies(corridors).has(r.currency), same: s.currency === r.currency };
}

// Picks the quote for one receiving country from a Wise provider's quotes.
// - A quote marked with this country always wins.
// - A quote marked with another country is never used.
// - An unmarked (currency-only) quote is used only when no other receiving country uses this currency.
// Returns { quote, country } (country set only when the quote was marked with it) or null.
export function pickQuote(quotes, iso2, shared) {
  const list = (quotes || []).filter((x) => x && Number(x.rate) > 0);
  const exact = list.find((x) => x.targetCountry && String(x.targetCountry).toUpperCase() === iso2);
  if (exact) return { quote: exact, country: iso2 };
  if (shared) return null;
  const generic = list.find((x) => !x.targetCountry);
  return generic ? { quote: generic, country: null } : null;
}

// True when a stored feed row (or published quote with a "country" field) may be used for this route.
export function countryOk(entry, info) {
  if (!info) return true;
  if (entry && entry.country && entry.country !== info.iso2) return false;
  if (info.shared && !(entry && entry.country === info.iso2)) return false;
  return true;
}

// Drops feed rows (and their tiers) on shared-currency routes that are not marked with the route's country.
export function cleanFeed(feed, corridors) {
  const out = { ...feed, routes: {}, ...(feed.tiers ? { tiers: {} } : {}) };
  const dropped = [];
  for (const [route, provs] of Object.entries(feed.routes || {})) {
    const info = routeInfo(corridors, route);
    const keep = {};
    for (const [id, f] of Object.entries(provs || {})) {
      if (countryOk(f, info)) keep[id] = f; else dropped.push(`${route} ${id}`);
    }
    out.routes[route] = keep;
    if (feed.tiers && feed.tiers[route]) {
      const t = {};
      for (const [id, list] of Object.entries(feed.tiers[route])) if (keep[id]) t[id] = list;
      out.tiers[route] = t;
    }
  }
  return { feed: out, dropped };
}

const isFeedQuote = (q) => q.source === "wise-feed" || /^Updated automatically from Wise/.test(q.note || "");

// Removes published Wise-feed quotes on shared-currency routes that are not marked with the route's country
// (they were copied from a currency-only quote). Returns the list of removed "route provider" strings.
export function purgeCopiedQuotes(quotesFile, corridors) {
  const removed = [];
  for (const [route, list] of Object.entries(quotesFile.quotes || {})) {
    const info = routeInfo(corridors, route);
    if (!info || !info.shared) continue;
    quotesFile.quotes[route] = (list || []).filter((q) => {
      if (isFeedQuote(q) && q.country !== info.iso2) { removed.push(`${route} ${q.provider}`); return false; }
      return true;
    });
  }
  return removed;
}

// How long a Wise-based mid-market correction is still used. Older than FRESH_H it is marked stale
// (the page shows its real time); older than MAX_H the free feed is used alone.
export const OVERRIDE_FRESH_H = 36;
export const OVERRIDE_MAX_H = 7 * 24;

// Applies data/mid-overrides.json onto a midmarket object (in place). Records per-currency times in
// midmarket.rateAt so the page can say how old the rate for a route really is.
export function applyOverrides(midmarket, ov, now = Date.now()) {
  if (!midmarket || !midmarket.rates || !ov || !ov.rates) return { applied: false };
  const at = new Date(ov.updatedAt).getTime();
  const ageH = (now - at) / 3600000;
  if (!(ageH >= -1) || ageH > OVERRIDE_MAX_H) return { applied: false, ageH };
  Object.assign(midmarket.rates, ov.rates);
  midmarket.overrideAt = ov.updatedAt;
  midmarket.overrideStale = ageH > OVERRIDE_FRESH_H;
  midmarket.rateAt = { ...(midmarket.rateAt || {}) };
  for (const c of Object.keys(ov.rates)) midmarket.rateAt[c] = ov.updatedAt;
  return { applied: true, ageH, stale: midmarket.overrideStale };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

// Wise converts at the mid-market rate, so Wise's own quoted rate is a fresh mid-market reference.
// Returns { rates: { CUR: units per 1 USD }, log: [...] } for every currency Wise quoted recently,
// within maxGap of the free feed (anything further is treated as an error and ignored).
//   feed.wiseRates: { "GBP-NGN": { rate, collected } } (Wise's own rate per currency pair, any country)
//   feed.routes[route].wise: fallback for older feed files.
export function deriveMidOverrides({ mid, feed, corridors, now = Date.now(), maxAgeH = 6, maxGap = 0.25 }) {
  const base = mid.base || "USD";
  const fresh = (c) => c && (now - new Date(c).getTime()) / 3600000 <= maxAgeH;
  const pairs = {}; // "SRC-TGT" -> [rate]
  const add = (src, tgt, rate, collected) => {
    if (!src || !tgt || src === tgt || !(Number(rate) > 0) || !fresh(collected)) return;
    (pairs[`${src}-${tgt}`] = pairs[`${src}-${tgt}`] || []).push(Number(rate));
  };
  for (const [k, w] of Object.entries(feed.wiseRates || {})) { const [a, b] = k.split("-"); add(a, b, w && w.rate, w && w.collected); }
  const sCur = Object.fromEntries((corridors.senders || []).map((s) => [s.id, s.currency]));
  const rCur = Object.fromEntries((corridors.receivers || []).map((r) => [r.id, r.currency]));
  for (const [route, provs] of Object.entries(feed.routes || {})) {
    const w = provs && provs.wise;
    const [sid, rid] = route.split("-");
    if (w && !(feed.wiseRates || {})[`${sCur[sid]}-${rCur[rid]}`]) add(sCur[sid], rCur[rid], w.rate, w.collected);
  }
  const pair = (a, b) => (pairs[`${a}-${b}`] ? median(pairs[`${a}-${b}`]) : null);
  const senders = [...new Set(Object.values(sCur))].filter((c) => c !== base);
  const targets = [...new Set(Object.values(rCur))].filter((c) => c !== base);
  const log = [], rates = {};
  const within = (cur, v) => {
    const free = mid.rates[cur];
    if (!(free > 0) || !(v > 0)) return false;
    const gap = Math.abs(v / free - 1);
    log.push(`${cur}: free ${free} vs Wise ${v.toPrecision(7)} (${(gap * 100).toFixed(2)}%)${gap < maxGap ? " -> used" : " -> ignored, too far from the free feed"}`);
    return gap < maxGap;
  };
  // Sender currencies against USD: USD->X divided by S->X over every receiving currency X Wise quoted both ways.
  for (const sc of senders) {
    const est = targets.map((x) => { const u = pair(base, x), v = pair(sc, x); return u && v ? u / v : null; }).filter(Boolean);
    if (est.length) { const v = median(est); if (within(sc, v)) rates[sc] = Number(v.toPrecision(7)); }
  }
  // Receiver currencies against USD: USD->X directly, plus S->X times (S per USD) for the other senders.
  for (const x of targets) {
    const est = [];
    const u = pair(base, x);
    if (u) est.push(u);
    for (const sc of senders) {
      const v = pair(sc, x), sPerUsd = rates[sc] || mid.rates[sc];
      if (v && sPerUsd > 0) est.push(v * sPerUsd);
    }
    if (est.length) { const v = median(est); if (within(x, v)) rates[x] = Number(v.toPrecision(7)); }
  }
  return { rates, log };
}

// Data-freshness check used by check-data-fresh.mjs. Returns a list of problems (empty when fine).
export function freshnessProblems({ feed, now = Date.now(), maxAgeH = 6 }) {
  const problems = [];
  if (!feed) return ["data/wise-feed.json is missing or unreadable"];
  const t = new Date(feed.updatedAt).getTime();
  const ageH = (now - t) / 3600000;
  if (!isFinite(ageH)) problems.push("data/wise-feed.json has no valid updatedAt");
  else if (ageH > maxAgeH) problems.push(`data/wise-feed.json was last updated ${ageH.toFixed(1)} h ago (limit ${maxAgeH} h): the Wise feed is not refreshing (check the WISE_API_TOKEN secret and the "Update rates" workflow log)`);
  const routes = Object.values(feed.routes || {}).filter((p) => p && Object.keys(p).length).length;
  if (!routes) problems.push("data/wise-feed.json has zero routes with quotes");
  return problems;
}

// The publishing rules of apply-wise-feed.mjs, on in-memory data (quotesFile is changed in place).
// - Copied quotes on shared-currency routes are purged first (see purgeCopiedQuotes).
// - A hand-checked quote less than handKeepH hours old always wins; the feed never overwrites it.
// - Feed rows older than feedMaxH hours are ignored.
// - On a shared-currency route only rows marked with the route's country are published.
// - A rate more than 12% below, or more than 3% above, the mid-market rate is held back as a likely error.
// - Tiers (prices at several amounts) are stored on the quote as q.tiers.
// Payout methods each provider offers in each receiving country, learned from hand checks (which read
// the provider's own page) and kept in data/payout-methods.json so the knowledge outlives the quote.
// Payout depends on the receiving country, not the sender, so a hand check from one sender teaches the
// others. Only grows from hand checks; never guessed.
export function learnPayoutMethods(quotesFile, known = {}) {
  const out = JSON.parse(JSON.stringify(known || {}));
  for (const [route, list] of Object.entries((quotesFile && quotesFile.quotes) || {})) {
    const receiver = route.split("-").slice(1).join("-");
    for (const q of list || []) {
      if (!q || isFeedQuote(q) || !Array.isArray(q.payout) || !q.payout.length) continue;
      const cur = ((out[q.provider] = out[q.provider] || {})[receiver] = out[q.provider][receiver] || []);
      for (const m of q.payout) if (["mobile", "bank", "cash"].includes(m) && !cur.includes(m)) cur.push(m);
    }
  }
  return out;
}

export function applyWiseFeed({ feed, quotesFile, config, corridors, provList, mid, now = Date.now(), handKeepH = 30, feedMaxH = 24, payoutMethods = null }) {
  const providers = new Set(provList.map((p) => p.id));
  const sendsFrom = Object.fromEntries(provList.map((p) => [p.id, p.sendsFrom || []]));
  const cur = Object.fromEntries([...corridors.senders, ...corridors.receivers].map((x) => [x.id, x.currency]));
  const age = (iso) => (now - new Date(iso).getTime()) / 3600000;
  const purged = purgeCopiedQuotes(quotesFile, corridors);
  let added = 0, kept = 0;
  const held = [];
  for (const [route, list] of Object.entries(feed.routes || {})) {
    const info = routeInfo(corridors, route);
    if (!info) continue;
    const s = info.s.id;
    const m = mid[cur[route.split("-")[1]]] && mid[cur[s]] ? mid[cur[route.split("-")[1]]] / mid[cur[s]] : (info.same ? 1 : null);
    for (const [id, f] of Object.entries(list || {})) {
      const existing = quotesFile.quotes[route] || [];
      if (!providers.has(id) || !(f.rate > 0) || !f.collected || age(f.collected) > feedMaxH) continue;
      if (!countryOk(f, info)) { held.push(`${route} ${id}: quote not marked for ${info.iso2} (currency shared with another country)`); continue; }
      if (sendsFrom[id] && sendsFrom[id].length && !sendsFrom[id].includes(s)) { held.push(`${route} ${id}: does not send from ${s}`); continue; }
      if (m && (f.rate < m * 0.88 || f.rate > m * 1.03)) { held.push(`${route} ${id}: ${f.rate} vs mid ${m.toFixed(4)}`); continue; }
      const mine = existing.filter((q) => q.provider === id);
      const freshHand = mine.some((q) => !isFeedQuote(q) && age(q.checkedAt) < handKeepH);
      if (freshHand) { kept++; continue; }
      const tiers = ((feed.tiers || {})[route] || {})[id];
      const hasTiers = Array.isArray(tiers) && tiers.length > 1;
      if (mine.some((q) => isFeedQuote(q) && q.checkedAt === f.collected && (!hasTiers || q.tiers))) continue; // nothing new
      const handPay = [...new Set(mine.filter((q) => !isFeedQuote(q)).flatMap((q) => q.payout || []))];
      const known = ((payoutMethods || {})[id] || {})[route.split("-").slice(1).join("-")] || [];
      const prevPay = [...new Set(mine.flatMap((q) => q.payout || []))];
      const payout = handPay.length ? handPay : known.length ? [...known] : prevPay;
      const q = {
        provider: id, rate: +f.rate, feeFixed: +(f.fee || 0), feePct: 0,
        payout: payout.length ? payout : ["bank"], speed: f.speed || "",
        note: "Updated automatically from Wise's comparison data; confirm on the provider's site",
        refAmount: config.defaultAmounts[cur[s]], checkedAt: f.collected, source: "wise-feed"
      };
      if (f.country) q.country = f.country;
      if (hasTiers) q.tiers = tiers.map((t) => ({ amount: +t.amount, rate: +t.rate, fee: +(t.fee || 0) }));
      quotesFile.quotes[route] = [q, ...existing.filter((x) => x.provider !== id)];
      added++;
    }
  }
  return { added, kept, held, purged };
}
