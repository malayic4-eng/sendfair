// Publishes Wise's comparison data (data/wise-feed.json) into data/quotes.json, with safety checks.
// Run every 30 minutes by the GitHub Action, after fetch-wise-feed.mjs.
//
// Rules (see applyWiseFeed in feed-lib.mjs):
// - A hand-checked quote less than 30 hours old always wins; the feed never overwrites it.
// - Feed quotes older than 24 hours are ignored.
// - On routes whose currency is used by more than one receiving country (USD: Zimbabwe, DR Congo;
//   XOF: Senegal, Côte d'Ivoire, Mali) only quotes Wise marked with that country are published, and
//   earlier currency-only copies are removed.
// - A rate more than 12% below, or more than 3% above, the mid-market rate is held back as a likely error.
// - Feed quotes are marked source "wise-feed" so the site can say they were updated automatically.
// - Prices at several amounts (feed "tiers") are kept on the quote, so other amounts are priced correctly.
// - Payout methods are kept from the provider's last hand check on that route; otherwise bank deposit only,
//   because the feed doesn't say whether mobile money or cash pickup are offered.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyWiseFeed, applyOverrides } from "./feed-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));

let feed;
try { feed = read("data/wise-feed.json"); } catch { console.log("No Wise feed yet, nothing to apply."); process.exit(0); }
const quotesFile = read("data/quotes.json");
const midmarket = read("data/midmarket.json");
midmarket.rates = midmarket.rates || {};
try { applyOverrides(midmarket, read("data/mid-overrides.json")); } catch {}
const now = Date.now();

const { added, kept, held, purged } = applyWiseFeed({
  feed, quotesFile, now,
  config: read("config.json"),
  corridors: read("data/corridors.json"),
  provList: read("data/providers.json").providers,
  mid: midmarket.rates
});
if (added || purged.length) {
  quotesFile.updatedAt = new Date(now).toISOString();
  fs.writeFileSync(path.join(ROOT, "data/quotes.json"), JSON.stringify(quotesFile, null, 1) + "\n");
}
console.log(`Wise feed: ${added} quotes published, ${kept} left to fresher hand checks, ${held.length} held back, ${purged.length} copied quotes removed`);
purged.forEach((h) => console.log("  removed (not priced for this country): " + h));
held.forEach((h) => console.log("  held: " + h));
