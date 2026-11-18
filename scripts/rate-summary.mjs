// Build-time summary of one rate page's history. Pure and testable: no HTML, no I/O.
// Every line needs at least 7 days of history; the 7-day line also needs a point on or before
// "today minus 7 days". Nothing is invented when a figure is missing.
const DAY = 86400000;

function shift(dateStr, days) {
  const t = Date.parse(String(dateStr) + "T00:00:00Z");
  return Number.isFinite(t) ? new Date(t - days * DAY).toISOString().slice(0, 10) : null;
}

export function historySummary(hist, { mid = null, today = null } = {}) {
  const pts = (hist || [])
    .filter((h) => h && (h.mid > 0 || h.best > 0))
    .slice()
    .sort((a, b) => String(a.d).localeCompare(String(b.d)));
  if (!pts.length) return { days: 0, lines: [] };

  const lastD = pts[pts.length - 1].d;
  const todayD = today || lastD;
  const cutoff7 = shift(todayD, 7);
  // Prefer the latest check on/before seven days ago; with exactly seven daily checks, the first
  // check is the best available reference (six days back) and is still a real value.
  const old = cutoff7 ? pts.filter((p) => p.d <= cutoff7).slice(-1)[0] || (pts.length >= 7 ? pts[0] : null) : null;
  const change = old && old.mid > 0 && mid > 0 ? (mid / old.mid - 1) * 100 : null;

  const cutoff30 = shift(todayD, 30);
  const last30 = cutoff30 ? pts.filter((p) => p.d >= cutoff30) : pts;
  const best = last30.filter((p) => p.best > 0).sort((a, b) => b.best - a.best)[0] || null;
  const mids = last30.filter((p) => p.mid > 0).map((p) => p.mid);
  const range = mids.length ? { low: Math.min(...mids), high: Math.max(...mids) } : null;

  const lines = [];
  if (pts.length >= 7 && change != null) lines.push({ id: "change7", change: +change.toFixed(2) });
  if (pts.length >= 7 && best) lines.push({ id: "best30", date: best.d, amount: best.best });
  if (pts.length >= 7 && range) lines.push({ id: "range30", low: range.low, high: range.high });
  return { days: pts.length, lastD, change, best, range, lines };
}
