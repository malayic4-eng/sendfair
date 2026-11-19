// Corrects the free mid-market feed with Wise's own rates.
// Wise converts at the mid-market rate and charges a separate fee, so the rate Wise quotes in its
// comparison feed is a good, fresh mid-market reference. The free feed (ExchangeRate-API open access) is
// refreshed about once a day and can lag: for the naira it has been 4-8% off, which made the site hide
// genuine quotes as "too far above mid-market". This script writes data/mid-overrides.json for every
// currency Wise quoted in the last 6 hours (receiving currencies, and the sending currencies against USD),
// ignoring any value more than 25% away from the free feed as a likely error. The build, the Wise-feed
// publisher and the history recorder apply it (marked stale after 36 hours, dropped after 7 days).
// Run after fetch-midmarket.mjs and fetch-wise-feed.mjs, before apply-wise-feed.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveMidOverrides } from "./feed-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch { return d; } };

const mid = read("data/midmarket.json", null);
const feed = read("data/wise-feed.json", null);
const corridors = read("data/corridors.json", { senders: [], receivers: [] });
const old = read("data/mid-overrides.json", {});
if (!mid || !mid.rates || !feed || !feed.routes) { console.log("Missing midmarket or Wise feed; nothing to do."); process.exit(0); }

const now = Date.now();
const { rates, log } = deriveMidOverrides({ mid, feed, corridors, now, maxAgeH: 6, maxGap: 0.25 });
log.forEach((l) => console.log(l));
if (!Object.keys(rates).length) {
  // Nothing fresh from Wise: keep the last corrections (the site marks them with their real time).
  console.log("No fresh Wise rates; data/mid-overrides.json left as it is.");
  process.exit(0);
}

const out = {
  updatedAt: new Date(now).toISOString(),
  source: "Wise's own rates from its comparison feed (Wise converts at the mid-market rate)",
  rates,
  previous: old && old.rates ? { updatedAt: old.updatedAt, rates: old.rates } : undefined
};
fs.writeFileSync(path.join(ROOT, "data/mid-overrides.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`Corrected ${Object.keys(rates).length} currencies: ${Object.keys(rates).join(", ")}`);
