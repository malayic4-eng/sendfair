// Corrects the free mid-market feed with Wise's own rates.
// Wise converts at the mid-market rate and charges a separate fee, so the rate Wise quotes in its
// comparison feed is a good mid-market reference. The free feed (ExchangeRate-API open access) can lag
// for some currencies; for the naira it has been about 4% off, which made the site hide genuine quotes
// as "too far above mid-market". This script writes data/mid-overrides.json, which the build, the
// Wise-feed publisher and the history recorder already apply (for up to 36 hours).
// Run after fetch-midmarket.mjs and fetch-wise-feed.mjs, before apply-wise-feed.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch { return d; } };
const MAX_AGE_H = 6;      // only use Wise rates collected in the last 6 hours
const MIN_GAP = 0.005;    // correct a currency when the free feed is more than 0.5% away
const MAX_GAP = 0.25;     // ignore anything wildly different (likely a parsing error)

const mid = read("data/midmarket.json", null);
const feed = read("data/wise-feed.json", null);
const corridors = read("data/corridors.json", { senders: [], receivers: [] });
const old = read("data/mid-overrides.json", {});
if (!mid || !mid.rates || !feed || !feed.routes) { console.log("Missing midmarket or Wise feed; nothing to do."); process.exit(0); }

const now = Date.now();
const senders = Object.fromEntries(corridors.senders.map((s) => [s.id, s.currency]));
const receivers = Object.fromEntries(corridors.receivers.map((r) => [r.id, r.currency]));
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

// Collect "units of currency X per 1 USD" implied by each fresh Wise quote: rate(S->X) * (S per USD).
const seen = {};
for (const [route, provs] of Object.entries(feed.routes)) {
  const w = provs && provs.wise;
  if (!w || !(Number(w.rate) > 0) || !w.collected) continue;
  if ((now - new Date(w.collected).getTime()) / 3600000 > MAX_AGE_H) continue;
  const [sid, rid] = route.split("-");
  const sc = senders[sid], rc = receivers[rid];
  if (!sc || !rc || sc === rc || !(mid.rates[sc] > 0)) continue;
  (seen[rc] = seen[rc] || []).push(Number(w.rate) * mid.rates[sc]);
}

const rates = {};
for (const [cur, list] of Object.entries(seen)) {
  if (cur === (mid.base || "USD")) continue; // never move the base currency
  const v = median(list), free = mid.rates[cur];
  if (!(free > 0)) continue;
  const gap = Math.abs(v / free - 1);
  if (gap > MIN_GAP && gap < MAX_GAP) rates[cur] = Number(v.toPrecision(7));
  console.log(`${cur}: free ${free} vs Wise ${v.toPrecision(7)} (${(gap * 100).toFixed(2)}%)${rates[cur] ? " -> corrected" : ""}`);
}

const out = {
  updatedAt: new Date(now).toISOString(),
  source: "Wise's own rates from its comparison feed (Wise converts at the mid-market rate)",
  rates,
  previous: old && old.rates ? { updatedAt: old.updatedAt, rates: old.rates } : undefined
};
fs.writeFileSync(path.join(ROOT, "data/mid-overrides.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`Corrected ${Object.keys(rates).length} currencies: ${Object.keys(rates).join(", ") || "none"}`);
