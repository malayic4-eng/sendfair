// Fetches mid-market reference rates (USD base) and writes data/midmarket.json.
// Run by the GitHub Action every 6 hours. Source: ExchangeRate-API open access (attribution shown in the site footer).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = ["USD", "GBP", "CAD", "AUD", "EUR", "AED", "SAR", "QAR", "KWD", "BHD", "OMR", "NGN", "GHS", "KES", "UGX", "ZMW", "TZS", "RWF", "ZAR"];

const res = await fetch("https://open.er-api.com/v6/latest/USD");
if (!res.ok) throw new Error(`Rate source returned ${res.status}`);
const data = await res.json();
if (data.result !== "success") throw new Error("Rate source did not return success");

const rates = {};
for (const c of KEEP) if (data.rates[c]) rates[c] = data.rates[c];

const out = {
  base: "USD",
  updatedAt: new Date(data.time_last_update_unix * 1000).toISOString(),
  source: "ExchangeRate-API (open access)",
  rates
};
fs.writeFileSync(path.join(ROOT, "data/midmarket.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`Saved ${Object.keys(rates).length} rates, source time ${out.updatedAt}`);
