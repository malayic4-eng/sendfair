// Pulls Wise's Comparison API (prices of many providers, collected by Wise) into data/wise-feed.json.
// apply-wise-feed.mjs then publishes these automatically on a 30-minute schedule.
// Needs a GitHub secret named WISE_API_TOKEN. Without it, this script does nothing.
// API reference: https://docs.wise.com/api-reference/comparison
//
// Output (data/wise-feed.json):
//   routes:    { "uk-nigeria": { provider: { rate, fee, collected, speed, country? } } } at the reference amount
//              (config.defaultAmounts). "country" is the receiver ISO2 when Wise marked the quote with it.
//   tiers:     { "uk-nigeria": { provider: [{ amount, rate, fee }, ...] } } at config.quickAmounts, so the site
//              can work out the fee and rate for other amounts.
//   wiseRates: { "GBP-NGN": { rate, collected } } Wise's own (mid-market) rate per currency pair.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedCurrencies, pickQuote } from "./feed-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = process.env.WISE_API_TOKEN;
if (!token) { console.log("WISE_API_TOKEN not set, skipping Wise feed."); process.exit(0); }

const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const corridors = JSON.parse(fs.readFileSync(path.join(ROOT, "data/corridors.json"), "utf8"));
const providers = JSON.parse(fs.readFileSync(path.join(ROOT, "data/providers.json"), "utf8")).providers;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const byKey = Object.fromEntries(providers.flatMap((p) => [[norm(p.id), p.id], [norm(p.name), p.id]]));

// ISO 8601 duration (e.g. PT20H8M, P2D) to a short label like "Minutes", "Same day" or "1-2 days".
function speedText(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:[\d.]+S)?)?$/.exec(iso || "");
  if (!m) return "";
  const h = (+m[1] || 0) * 24 + (+m[2] || 0) + (+m[3] || 0) / 60;
  if (h < 1) return "Minutes";
  if (h < 24) return "Same day";
  if (h <= 48) return "1–2 days";
  return Math.ceil(h / 24) + " days";
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSE_MS = Number(process.env.WISE_FEED_PAUSE_MS ?? 250); // tests set 0
const shared = sharedCurrencies(corridors);
const routes = {}, tiers = {}, wiseRates = {};
let fetched = 0, calls = 0;

// One Wise call: provider id -> { rate, fee, collected, speed, country? } for this receiving country.
async function compare(s, r, amount) {
  const url = `https://api.wise.com/v4/comparisons/?sourceCurrency=${s.currency}&targetCurrency=${r.currency}&sendAmount=${amount}`;
  await pause(PAUSE_MS); // gentle on Wise's API
  calls++;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { status: res.status };
  const data = await res.json();
  const out = {};
  let own = null;
  for (const p of data.providers || []) {
    const id = byKey[norm(p.alias)] || byKey[norm(p.name)];
    if (!id || !Array.isArray(p.quotes) || !p.quotes.length) continue;
    // Wise's own rate is the mid-market rate whatever the country: kept for mid-from-wise.mjs.
    if (id === "wise" && !own) { const w = p.quotes.find((x) => Number(x.rate) > 0); if (w) own = { rate: w.rate, collected: w.dateCollected || null }; }
    // Never borrow another country's quote: on a shared currency (USD, XOF) only a quote marked with
    // this country counts; elsewhere a currency-only quote is fine, but never one marked for another country.
    const picked = pickQuote(p.quotes, r.iso2, shared.has(r.currency));
    if (!picked) continue;
    const q = picked.quote;
    const d = (q.deliveryEstimation || {}).duration || {};
    out[id] = { rate: q.rate, fee: q.fee ?? 0, collected: q.dateCollected || null, speed: speedText(d.max || d.min) };
    if (picked.country) out[id].country = picked.country;
  }
  return { out, own };
}

for (const s of corridors.senders) {
  const ref = config.defaultAmounts[s.currency];
  // Prices change with the amount, so read each route at the sender's quick amounts too (the reference amount first).
  const amounts = [ref, ...((config.quickAmounts || {})[s.currency] || []).filter((a) => a !== ref)];
  for (const r of corridors.receivers) {
    const key = `${s.id}-${r.id}`;
    const same = s.currency === r.currency; // e.g. USD to Zimbabwe: Wise may or may not price it
    const points = {};
    let refOut = null;
    for (const amount of amounts) {
      try {
        const got = await compare(s, r, amount);
        if (got.status) {
          if (!same) console.log(`${key} @${amount}: Wise returned ${got.status}`);
          if (amount === ref) break; // no reference price: skip the other amounts for this route
          continue;
        }
        if (amount === ref) {
          refOut = got.out;
          if (got.own && !same) wiseRates[`${s.currency}-${r.currency}`] = got.own;
        }
        for (const [id, f] of Object.entries(got.out)) (points[id] = points[id] || []).push({ amount, rate: f.rate, fee: f.fee });
      } catch (e) {
        if (!same) console.log(`${key} @${amount}: ${e.message}`);
        if (amount === ref) break;
      }
    }
    if (!refOut) continue;
    routes[key] = refOut;
    const t = {};
    for (const [id, list] of Object.entries(points)) if (refOut[id] && list.length > 1) t[id] = list.sort((a, b) => a.amount - b.amount);
    if (Object.keys(t).length) tiers[key] = t;
    fetched++;
    console.log(`${key}: ${Object.keys(refOut).length} providers, ${Object.keys(t).length} with prices at ${amounts.length} amounts`);
  }
}
console.log(`Wise feed: ${calls} calls, ${fetched} routes.`);
if (!fetched) {
  console.log("Wise feed: no routes fetched, keeping the existing data/wise-feed.json untouched.");
  process.exitCode = 1;
} else {
  fs.writeFileSync(path.join(ROOT, "data/wise-feed.json"), JSON.stringify({ updatedAt: new Date().toISOString(), routes, tiers, wiseRates }, null, 2) + "\n");
}
