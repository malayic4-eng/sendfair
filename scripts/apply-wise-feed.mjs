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
// - Payout methods come from the provider's last hand check on that route, else from what hand checks on other
//   routes to the same country recorded (data/payout-methods.json), else the previous quote, else bank only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyWiseFeed, applyOverrides, learnPayoutMethods } from "./feed-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));

let feed;
try { feed = read("data/wise-feed.json"); } catch { console.log("No Wise feed yet, nothing to apply."); process.exit(0); }
const quotesFile = read("data/quotes.json");
const midmarket = read("data/midmarket.json");
midmarket.rates = midmarket.rates || {};
try { applyOverrides(midmarket, read("data/mid-overrides.json")); } catch {}
const now = Date.now();

let payoutMethods = {};
try { payoutMethods = read("data/payout-methods.json").providers || {}; } catch {}
payoutMethods = learnPayoutMethods(quotesFile, payoutMethods);
fs.writeFileSync(path.join(ROOT, "data/payout-methods.json"), JSON.stringify({ note: "Payout methods per provider and receiving country, learned from hand checks of the provider's own page (scripts/feed-lib.mjs learnPayoutMethods). Used for feed quotes, which don't say how money is paid out.", providers: payoutMethods }, null, 1) + "\n");
// Published feed quotes get the payout methods we know for that provider and country.
let payFixed = 0;
for (const [route, list] of Object.entries(quotesFile.quotes || {})) {
  const receiver = route.split("-").slice(1).join("-");
  for (const q of list || []) {
    if (q.source !== "wise-feed") continue;
    const known = (payoutMethods[q.provider] || {})[receiver] || [];
    if (known.length && known.join() !== (q.payout || []).join()) { q.payout = [...known]; payFixed++; }
  }
}
const { added, kept, held, purged } = applyWiseFeed({
  feed, quotesFile, now, payoutMethods,
  config: read("config.json"),
  corridors: read("data/corridors.json"),
  provList: read("data/providers.json").providers,
  mid: midmarket.rates
});
if (added || purged.length || payFixed) {
  quotesFile.updatedAt = new Date(now).toISOString();
  fs.writeFileSync(path.join(ROOT, "data/quotes.json"), JSON.stringify(quotesFile, null, 1) + "\n");
}
console.log(`Wise feed: ${payFixed} payout lists filled from hand checks, ${added} quotes published, ${kept} left to fresher hand checks, ${held.length} held back, ${purged.length} copied quotes removed`);
purged.forEach((h) => console.log("  removed (not priced for this country): " + h));
held.forEach((h) => console.log("  held: " + h));
