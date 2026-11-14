// Publishes Wise's comparison data (data/wise-feed.json) into data/quotes.json, with safety checks.
// Run every 30 minutes by the GitHub Action, after fetch-wise-feed.mjs.
//
// Rules:
// - A hand-checked quote less than HAND_KEEP_H hours old always wins; the feed never overwrites it.
// - Feed quotes older than FEED_MAX_H hours are ignored.
// - A rate more than 12% below, or more than 3% above, the mid-market rate is held back as a likely error.
// - Feed quotes are marked source "wise-feed" so the site can say they were updated automatically.
// - Payout methods are kept from the provider's last hand check on that route; otherwise bank deposit only,
//   because the feed doesn't say whether mobile money or cash pickup are offered.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
const HAND_KEEP_H = 30, FEED_MAX_H = 24;

let feed;
try { feed = read("data/wise-feed.json"); } catch { console.log("No Wise feed yet, nothing to apply."); process.exit(0); }
const quotesFile = read("data/quotes.json");
const config = read("config.json");
const corridors = read("data/corridors.json");
const providers = new Set(read("data/providers.json").providers.map((p) => p.id));
const mid = read("data/midmarket.json").rates || {};
try { Object.assign(mid, read("data/mid-overrides.json").rates || {}); } catch {}
const cur = Object.fromEntries([...corridors.senders, ...corridors.receivers].map((x) => [x.id, x.currency]));
// The Rate Desk rewrites quotes without the "source" field, so the note also marks a feed quote.
const isFeed = (q) => q.source === "wise-feed" || /^Updated automatically from Wise/.test(q.note || "");
const now = Date.now(), age = (iso) => (now - new Date(iso).getTime()) / 3600000;

let added = 0, held = [], kept = 0;
for (const [route, list] of Object.entries(feed.routes || {})) {
  const [s, r] = route.split("-");
  if (!cur[s] || !cur[r]) continue;
  const m = mid[cur[r]] && mid[cur[s]] ? mid[cur[r]] / mid[cur[s]] : null;
  for (const [id, f] of Object.entries(list)) {
    const existing = quotesFile.quotes[route] || [];
    if (!providers.has(id) || !(f.rate > 0) || !f.collected || age(f.collected) > FEED_MAX_H) continue;
    if (m && (f.rate < m * 0.88 || f.rate > m * 1.03)) { held.push(`${route} ${id}: ${f.rate} vs mid ${m.toFixed(4)}`); continue; }
    const mine = existing.filter((q) => q.provider === id);
    const freshHand = mine.some((q) => !isFeed(q) && age(q.checkedAt) < HAND_KEEP_H);
    if (freshHand) { kept++; continue; }
    if (mine.some((q) => isFeed(q) && q.checkedAt === f.collected)) continue; // nothing new
    const payout = [...new Set(mine.flatMap((q) => q.payout || []))];
    const q = {
      provider: id, rate: +f.rate, feeFixed: +(f.fee || 0), feePct: 0,
      payout: payout.length ? payout : ["bank"], speed: f.speed || "",
      note: "Updated automatically from Wise's comparison data; confirm on the provider's site",
      refAmount: config.defaultAmounts[cur[s]], checkedAt: f.collected, source: "wise-feed"
    };
    quotesFile.quotes[route] = [q, ...existing.filter((x) => x.provider !== id)];
    added++;
  }
}
if (added) {
  quotesFile.updatedAt = new Date(now).toISOString();
  fs.writeFileSync(path.join(ROOT, "data/quotes.json"), JSON.stringify(quotesFile, null, 1) + "\n");
}
console.log(`Wise feed: ${added} quotes published, ${kept} left to fresher hand checks, ${held.length} held back`);
held.forEach((h) => console.log("  held: " + h));
