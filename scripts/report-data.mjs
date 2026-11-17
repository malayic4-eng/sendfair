// Monthly report data, shared by the site build and the Buttondown sender.
// Source: data/history.json (one snapshot per route per day: mid, amount, best, by).
import R from "../src/rank.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (m) => { const [y, mm] = m.split("-"); return `${MONTHS[Number(mm) - 1]} ${y}`; };
export const monthKey = (d) => String(d).slice(0, 7);

function routeName(s, r) { return `${s.label} to ${r.name}`; }

export function buildReport({ month, history, config, quotes, corridors, providers, midmarket }) {
  const days = Object.entries(history.days || {}).filter(([d]) => d.startsWith(month));
  const routes = [];
  const providerName = (id) => (providers[id] && providers[id].name) || id;
  for (const s of corridors.senders) for (const r of corridors.receivers) {
    const key = `${s.id}-${r.id}`;
    const snaps = days.map(([, snap]) => snap[key]).filter((x) => x && x.best > 0 && x.mid > 0 && x.amount > 0);
    if (!snaps.length) continue;
    const costs = snaps.map((x) => 1 - x.best / (x.amount * x.mid));
    const avg = costs.reduce((a, b) => a + b, 0) / costs.length;
    const best = Math.min(...costs);
    const counts = {};
    for (const x of snaps) for (const id of x.by || []) counts[id] = (counts[id] || 0) + 1;
    const cheapest = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    routes.push({
      key, from: s.id, to: r.id, name: routeName(s, r), amount: snaps[0].amount, currency: r.currency,
      days: snaps.length, avg, best,
      cheapest: cheapest ? { id: cheapest[0], name: providerName(cheapest[0]), count: cheapest[1] } : null
    });
  }
  // Month-on-month change, against the previous calendar month.
  const [y, mm] = month.split("-").map(Number);
  const prev = new Date(Date.UTC(y, mm - 2, 1)).toISOString().slice(0, 7);
  const prevDays = Object.entries(history.days || {}).filter(([d]) => d.startsWith(prev));
  for (const route of routes) {
    const snaps = prevDays.map(([, snap]) => snap[route.key]).filter((x) => x && x.best > 0 && x.mid > 0 && x.amount > 0);
    route.mom = snaps.length ? route.avg - snaps.reduce((a, x) => a + (1 - x.best / (x.amount * x.mid)), 0) / snaps.length : null;
  }
  const sorted = [...routes].sort((a, b) => a.avg - b.avg);
  const index = routes.length ? routes.reduce((a, x) => a + x.avg, 0) / routes.length : 0;
  const mover = routes.filter((x) => x.mom != null).sort((a, b) => Math.abs(b.mom) - Math.abs(a.mom))[0] || null;

  // Saving from comparing, on the latest quotes: best vs worst service on each corridor.
  const spreads = [];
  for (const route of routes) {
    const list = (quotes || {})[route.key] || [];
    const snap = days.map(([, s2]) => s2[route.key]).filter((x) => x && x.mid > 0 && x.amount > 0).pop();
    if (!list.length || !snap) continue;
    const vals = list.map((q) => R.evaluate(q, snap.amount)).filter(Boolean).map((ev) => ev.gets);
    if (vals.length < 2) continue;
    const hi = Math.max(...vals), lo = Math.min(...vals);
    if (hi > 0) spreads.push((hi - lo) / (snap.amount * snap.mid));
  }
  const compareSaving = spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null;
  const wb = config.regionalAverageCost || { percent: 8.46, label: "World Bank average cost of sending money to Sub-Saharan Africa (Q3 2025)" };
  return {
    month, label: monthLabel(month), routes, sorted, index, mover,
    cheapest10: sorted.slice(0, 10), expensive10: sorted.slice(-10).reverse(),
    compareSaving, wbPct: (wb.percent || 0) / 100, wbLabel: wb.label,
    costAvg: index, bestCorridor: sorted[0] || null, worstCorridor: sorted[sorted.length - 1] || null,
    savingsVsWb: index > 0 ? (wb.percent / 100) - index : null
  };
}

export function buildReports({ history, config, quotes, corridors, providers, midmarket, currentMonth }) {
  const months = [...new Set(Object.keys(history.days || {}).map(monthKey))].filter((m) => m < currentMonth).sort();
  const reports = months.map((month) => buildReport({ month, history, config, quotes, corridors, providers, midmarket }));
  return reports;
}

// One paragraph a journalist can quote, written from the report data.
export function reportSummary(r) {
  const pct = (v) => (v * 100).toFixed(2) + "%";
  const bits = [];
  bits.push(`In ${r.label}, the average best total cost of a transfer to Africa across the ${r.routes.length} corridors SendFair checked was ${pct(r.index)}.`);
  if (r.bestCorridor) bits.push(`The cheapest corridor was ${r.bestCorridor.name}, at ${pct(r.bestCorridor.avg)}; the dearest was ${r.worstCorridor.name}, at ${pct(r.worstCorridor.avg)}.`);
  if (r.mover) bits.push(`The biggest month-on-month move was ${r.mover.name}, ${r.mover.mom > 0 ? "up" : "down"} ${Math.abs(r.mover.mom * 100).toFixed(2)} percentage points.`);
  if (r.compareSaving != null) bits.push(`On the latest check, picking the best service instead of the worst on each corridor was worth an average of ${(r.compareSaving * 100).toFixed(2)} percentage points.`);
  const q = (r.wbLabel.match(/\(([^)]+)\)/) || [])[1] || "";
  const diff = r.savingsVsWb;
  bits.push(`The World Bank's Sub-Saharan Africa average is ${(r.wbPct * 100).toFixed(2)}%${q ? ` (${q})` : ""}${diff != null ? `; the average best option here was ${Math.abs(diff * 100).toFixed(2)} points ${diff >= 0 ? "below" : "above"} it` : ""}.`);
  return bits.join(" ");
}
