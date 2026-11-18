// Adapter over the stored Wise comparison feed (data/wise-feed.json).
// fetch-wise-feed.mjs still does the API call; this adapter shows the same interface as the partner
// feeds and returns Wise's rows in the internal quote format. It is only run with --all, because the
// existing update-rates workflow already publishes the Wise feed through apply-wise-feed.mjs.
import fs from "node:fs";
import { toIso, withinHours } from "./adapter.mjs";

export class WiseFeedAdapter {
  constructor(config = {}) {
    this.config = config;
    this.id = "wise";
    this.name = "Wise";
    this.kind = "wise-feed";
  }

  supports() { return true; }

  async fetchQuotes({ now = Date.now(), feedFile = "data/wise-feed.json", routes = null } = {}) {
    let feed;
    try { feed = JSON.parse(fs.readFileSync(feedFile, "utf8")); }
    catch { return { skipped: "no feed file", quotes: {} }; }
    const allowed = routes ? new Set(routes) : null;
    const quotes = {};
    for (const [route, list] of Object.entries(feed.routes || {})) {
      if (allowed && !allowed.has(route)) continue;
      for (const [id, f] of Object.entries(list || {})) {
        if (!(f && f.rate > 0)) continue;
        const checkedAt = toIso(f.collected);
        if (!checkedAt || !withinHours(checkedAt, now, 24)) continue;
        (quotes[route] = quotes[route] || []).push({
          provider: id,
          rate: f.rate,
          feeFixed: f.fee || 0,
          feePct: 0,
          payout: ["bank"],
          speed: f.speed || "",
          note: "Updated automatically from Wise's comparison data; confirm on the provider's site",
          refAmount: null,
          checkedAt,
          source: "wise-feed"
        });
      }
    }
    return { quotes };
  }
}
