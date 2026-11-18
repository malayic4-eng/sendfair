// Merges adapter quotes into data/quotes.json using the rules the site already relies on:
// - a hand-checked quote less than 30 hours old always wins;
// - a quote older than 24 hours is dropped;
// - a rate far from the mid-market rate is held back as a likely error;
// - the provider must send from that source market;
// - coverage[route] gains the provider so the route page lists it.
import { toIso } from "./adapter.mjs";

const AUTO_SOURCES = new Set(["wise-feed", "partner-feed", "worldremit", "scrape"]);

export function isAutoQuote(q) {
  return !q || AUTO_SOURCES.has(q.source) || q.feed === true || /^Updated automatically|^From .+ partner feed/.test(q.note || "");
}

export function mergeQuotes(quotesFile, incoming, { now = Date.now(), mid = {}, providers = new Set(), sendsFrom = {}, defaultAmounts = {}, routeCurrency = {}, maxAgeHours = 24 } = {}) {
  if (!quotesFile.quotes) quotesFile.quotes = {};
  if (!quotesFile.coverage) quotesFile.coverage = {};
  const quotes = quotesFile.quotes, coverage = quotesFile.coverage;
  let added = 0, kept = 0;
  const dropped = [];
  const ageH = (iso) => (now - Date.parse(iso)) / 3600000;

  for (const [route, list] of Object.entries(incoming || {})) {
    const [s, r] = route.split("-");
    const m = mid[r] && mid[s] ? mid[r] / mid[s] : null;
    for (const q of list || []) {
      const checkedAt = toIso(q.checkedAt);
      if (!providers.has(q.provider)) { dropped.push(`${route} ${q.provider}: unknown provider`); continue; }
      if (!(q.rate > 0) || !checkedAt) { dropped.push(`${route} ${q.provider}: missing rate or checkedAt`); continue; }
      if (!(ageH(checkedAt) <= maxAgeHours)) { dropped.push(`${route} ${q.provider}: older than ${maxAgeHours}h`); continue; }
      if (sendsFrom[q.provider] && sendsFrom[q.provider].length && !sendsFrom[q.provider].includes(s)) { dropped.push(`${route} ${q.provider}: does not send from ${s}`); continue; }
      if (m && (q.rate < m * 0.88 || q.rate > m * 1.03)) { dropped.push(`${route} ${q.provider}: rate ${q.rate} vs mid ${m.toFixed(4)}`); continue; }

      const existing = quotes[route] || [];
      const mine = existing.filter((x) => x.provider === q.provider);
      const freshHand = mine.some((x) => !isAutoQuote(x) && ageH(x.checkedAt) < 30);
      if (freshHand) { kept++; continue; }

      const sendCurrency = routeCurrency[route] || routeCurrency[s] || null;
      const refAmount = q.refAmount || (sendCurrency && defaultAmounts[sendCurrency]) || null;
      quotes[route] = [{ ...q, checkedAt, refAmount }, ...existing.filter((x) => x.provider !== q.provider)];
      coverage[route] = [...new Set([...(coverage[route] || []), q.provider])];
      added++;
    }
  }
  if (added) quotesFile.updatedAt = new Date(now).toISOString();
  return { quotesFile, added, kept, dropped };
}
