// Shared result model for the share card and its test. Uses the site's own ranking engine so the
// card's "best" always matches the page: feed merge, 36h/72h freshness and the hand-lock rule included.
import R from "./rank.js";

export function resultModel(data, route, amount, now) {
  const { quotes, feed, providers, corridors, midmarket, site } = data;
  const list = (quotes && quotes.quotes && quotes.quotes[route]) || [];
  const [fromId, toId] = route.split("-");
  const s = ((corridors && corridors.senders) || []).find((x) => x.id === fromId);
  const r = ((corridors && corridors.receivers) || []).find((x) => x.id === toId);
  if (!s || !r) return null;
  const pmap = Object.fromEntries((((providers && providers.providers) || []).map((p) => [p.id, p])));
  const rows = R.rank({
    list,
    feed: (feed && feed.routes && feed.routes[route]) || null,
    providers: pmap,
    amount,
    payout: "all",
    payIn: "all",
    promo: false,
    mid: R.midRate(midmarket, s.currency, r.currency),
    now,
    staleH: (site && site.staleAfterHours) || 36,
    hideH: (site && site.hideAfterHours) || 72,
    handLockH: (site && site.handLockH) || 6,
    refAmount: ((site && site.defaultAmounts) || {})[s.currency]
  });
  const fresh = rows.filter((x) => !x.stale);
  if (!fresh.length) return null;
  return { s, r, amount, rows, fresh, best: fresh[0], lowest: fresh[fresh.length - 1] };
}
