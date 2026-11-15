// Optional: pulls Wise's Comparison API (prices of many providers, collected by Wise) into data/wise-feed.json.
// The Rate Desk shows these as suggestions you can accept with one click. It never publishes quotes by itself.
// Needs a GitHub secret named WISE_API_TOKEN. Without it, this script does nothing.
// API reference: https://docs.wise.com/api-reference/comparison
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const routes = {};
for (const s of corridors.senders) {
  for (const r of corridors.receivers) {
    if (s.currency === r.currency) continue;
    const amount = config.defaultAmounts[s.currency];
    const url = `https://api.wise.com/v4/comparisons/?sourceCurrency=${s.currency}&targetCurrency=${r.currency}&sendAmount=${amount}`;
    await pause(250); // gentle on Wise's API
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { console.log(`${s.id}-${r.id}: Wise returned ${res.status}`); continue; }
      const data = await res.json();
      const out = {};
      for (const p of data.providers || []) {
        const id = byKey[norm(p.alias)] || byKey[norm(p.name)];
        if (!id || !Array.isArray(p.quotes) || !p.quotes.length) continue;
        const q = p.quotes.find((x) => !x.targetCountry || x.targetCountry === r.iso2) || p.quotes[0];
        if (!(q.rate > 0)) continue;
        const d = (q.deliveryEstimation || {}).duration || {};
        out[id] = { rate: q.rate, fee: q.fee ?? 0, collected: q.dateCollected || null, speed: speedText(d.max || d.min) };
      }
      routes[`${s.id}-${r.id}`] = out;
      console.log(`${s.id}-${r.id}: ${Object.keys(out).length} providers`);
    } catch (e) {
      console.log(`${s.id}-${r.id}: ${e.message}`);
    }
  }
}
fs.writeFileSync(path.join(ROOT, "data/wise-feed.json"), JSON.stringify({ updatedAt: new Date().toISOString(), routes }, null, 2) + "\n");
