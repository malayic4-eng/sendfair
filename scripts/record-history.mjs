// Adds today's snapshot to data/history.json: per route, the mid-market rate and the best amount that arrives
// for the route's typical amount (and which services delivered it). Run after each rate check.
// Usage: node scripts/record-history.mjs [--quotes file] [--mid file] [--date YYYY-MM-DD]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = createRequire(import.meta.url)(path.join(ROOT, "src/rank.js"));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

const config = read(path.join(ROOT, "config.json"));
const corridors = read(path.join(ROOT, "data/corridors.json"));
const providers = Object.fromEntries(read(path.join(ROOT, "data/providers.json")).providers.map((p) => [p.id, p]));
const quotes = read(arg("--quotes", path.join(ROOT, "data/quotes.json")));
let mid = { rates: {} };
try { mid = read(arg("--midmarket", path.join(ROOT, "data/midmarket.json"))); } catch {}
const ovFile = arg("--mid", path.join(ROOT, "data/mid-overrides.json"));
if (ovFile !== "none") { try { const ov = read(ovFile); Object.assign(mid.rates = mid.rates || {}, ov.rates || {}); } catch {} }
mid.rates.USD = 1;
const when = new Date(quotes.updatedAt || Date.now());
const day = arg("--date", when.toISOString().slice(0, 10));

const file = path.join(ROOT, "data/history.json");
let hist = { note: "One entry per route per day: mid = mid-market rate, best = most that arrives for the typical amount, by = services that delivered it.", days: {} };
try { hist = read(file); } catch {}

const snap = {};
for (const s of corridors.senders) for (const r of corridors.receivers) {
  const key = `${s.id}-${r.id}`;
  const amount = config.defaultAmounts[s.currency];
  const m = R.midRate(mid, s.currency, r.currency);
  const rows = R.rank({ list: (quotes.quotes || {})[key] || [], amount, payout: "all", providers, now: when.getTime(), staleH: 36, hideH: 72, mid: m });
  const lead = R.leaders(rows);
  if (!m && !lead.length) continue;
  snap[key] = { mid: m ? +m.toPrecision(6) : null, amount, best: lead.length ? Math.round(lead[0].gets * 100) / 100 : null, by: lead.map((x) => x.p.id) };
}
hist.days[day] = snap;
// keep the last 400 days
const keep = Object.keys(hist.days).sort().slice(-400);
hist.days = Object.fromEntries(keep.map((d) => [d, hist.days[d]]));
fs.writeFileSync(file, JSON.stringify(hist) + "\n");
console.log(`history: ${day}, ${Object.keys(snap).length} routes, ${keep.length} days kept`);
