// Guard for the share card: for every route at its typical amount, the card's "best" provider and
// amount must equal what rank() returns with the same options the site uses. Exits 1 on any mismatch.
import fs from "node:fs";
import R from "../src/rank.js";
import { resultModel } from "../src/og-model.js";

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
const config = read("../config.json");
const data = {
  quotes: read("../data/quotes.json"),
  feed: read("../data/wise-feed.json"),
  providers: read("../data/providers.json"),
  corridors: read("../data/corridors.json"),
  midmarket: read("../data/midmarket.json"),
  site: {
    staleAfterHours: config.staleAfterHours,
    hideAfterHours: config.hideAfterHours,
    handLockH: config.preferAutoAfterHours || config.handLockHours || 6,
    defaultAmounts: config.defaultAmounts
  }
};
const pmap = Object.fromEntries(data.providers.providers.map((p) => [p.id, p]));
const now = Date.now();
let checked = 0, skipped = 0, bad = 0;

for (const s of data.corridors.senders) {
  for (const r of data.corridors.receivers) {
    const route = `${s.id}-${r.id}`;
    const amount = config.defaultAmounts[s.currency];
    const opts = {
      list: data.quotes.quotes[route] || [],
      feed: (data.feed.routes || {})[route] || null,
      providers: pmap,
      amount,
      payout: "all",
      payIn: "all",
      promo: false,
      mid: R.midRate(data.midmarket, s.currency, r.currency),
      now,
      staleH: data.site.staleAfterHours || 36,
      hideH: data.site.hideAfterHours || 72,
      handLockH: data.site.handLockH || 6,
      refAmount: (config.defaultAmounts || {})[s.currency]
    };
    const fresh = R.rank(opts).filter((x) => !x.stale);
    const model = resultModel(data, route, amount, now);
    if (!fresh.length) { skipped++; if (model) { bad++; console.log("model should be null:", route); } continue; }
    checked++;
    if (!model) { bad++; console.log("model unexpectedly null:", route); continue; }
    if (model.best.p.id !== fresh[0].p.id || Math.round(model.best.gets) !== Math.round(fresh[0].gets)) {
      bad++;
      console.log(`mismatch ${route}: card=${model.best.p.id} ${Math.round(model.best.gets)} rank=${fresh[0].p.id} ${Math.round(fresh[0].gets)}`);
    }
  }
}

console.log(`og-rank: ${checked} routes checked, ${skipped} without live data, ${bad} mismatch(es)`);
if (bad) process.exitCode = 1;
