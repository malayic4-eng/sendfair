// Auto-favour winners: turn the last 28 days of post performance into gentle weights, and pick a
// template for a date from those weights. Pure functions, no I/O, so social-content.mjs can import
// pickTemplate without side effects.
//
// Weights are bounded (MIN..MAX) so nothing disappears, need MIN_POSTS posts in a bucket (else 1.0),
// and are smoothed toward 1.0 with PRIOR pseudo-posts at the overall average.

export const MIN_W = 0.5, MAX_W = 2.0, MIN_POSTS = 3, PRIOR = 3;

// SendFair is more than transfers: house-building content and other services (flights home, rate
// alerts, Quote Check) matter too. Templates are grouped into content types so weights stay fair.
// A template not listed here keeps its own template bucket; its type is guessed from its name
// (anything about houses, building, materials or costs is "building"), else "other".
const TRANSFER_TEMPLATES = new Set(["route", "best-vs-average", "tip", "rate-move"]);
const BUILDING_RE = /house|build|material|cement|brick|roof|land|plot|cost-to|construction|mabati|iron-sheet/i;
export function contentType(template) {
  const t = String(template || "");
  if (TRANSFER_TEMPLATES.has(t)) return "transfers";
  if (BUILDING_RE.test(t)) return "building";
  if (/rate|transfer|send|remit|fx|exchange/i.test(t)) return "transfers";
  return "other";
}
// Minimum share of picks per content type once weights are in use. Building keeps a quarter of posts
// unless 28 days of data (>= MIN_POSTS building posts) clearly show it underperforming (type weight at
// or below 0.6), when the floor relaxes to 15%. Other services keep at least 10% when such templates exist.
export const TYPE_FLOORS = { building: 0.25, other: 0.1, transfers: 0.25 };
export const BUILDING_FLOOR_RELAXED = 0.15;

const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x) => Math.min(MAX_W, Math.max(MIN_W, x));

// posts: [{ date, template, route, platform, metrics: { views, reach } }]. One "content item" is the
// same template+route on the same date; its views are summed across platforms so a day posted to more
// platforms is not counted as several wins.
export function computeWeights(posts, { now = new Date(), days = 28 } = {}) {
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const items = new Map();
  for (const p of posts) {
    if (!p || !p.date || p.date < cutoff) continue;
    const v = score(p.metrics);
    if (v == null) continue;
    const key = `${p.date}|${p.template}|${p.route}`;
    const it = items.get(key) || { template: p.template, route: p.route, type: contentType(p.template), views: 0 };
    it.views += v;
    items.set(key, it);
  }
  const list = [...items.values()];
  const mean = list.length ? list.reduce((s, x) => s + x.views, 0) / list.length : 0;
  const bucket = (field) => {
    const groups = {};
    for (const it of list) if (it[field]) (groups[it[field]] = groups[it[field]] || []).push(it.views);
    const out = {};
    for (const [k, v] of Object.entries(groups)) {
      if (v.length < MIN_POSTS || !(mean > 0)) { out[k] = 1; continue; }
      const sum = v.reduce((s, x) => s + x, 0);
      out[k] = round2(clamp((sum + PRIOR * mean) / ((v.length + PRIOR) * mean)));
    }
    return out;
  };
  const types = bucket("type");
  const nBuilding = list.filter((x) => x.type === "building").length;
  const floors = { ...TYPE_FLOORS };
  if (nBuilding >= MIN_POSTS && types.building <= 0.6) floors.building = BUILDING_FLOOR_RELAXED;
  return {
    updatedAt: now.toISOString(),
    windowDays: days,
    basis: "views (reach when views are missing), summed per day across platforms",
    bounds: [MIN_W, MAX_W],
    minPosts: MIN_POSTS,
    items: list.length,
    templates: bucket("template"),
    routes: bucket("route"),
    types,
    typeFloors: floors
  };
}

export function score(m) {
  if (!m) return null;
  for (const k of ["views", "reach"]) if (Number.isFinite(m[k])) return m[k];
  return null;
}

// Deterministic per-date number in [0, 1) (FNV-1a).
function unit(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  // murmur3 finaliser: nearby dates ("2027-01-01", "2027-01-02") must not give nearby numbers.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function dayIndex(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000);
}
function shift(dateStr, n) {
  return new Date(Date.parse(dateStr + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
function pickOne(date, items, w, exclude) {
  const pool = items.filter((t) => t !== exclude);
  const list = pool.length ? pool : items;
  const total = list.reduce((s, t) => s + w(t), 0);
  let u = unit(date) * total;
  for (const t of list) { u -= w(t); if (u < 0) return t; }
  return list[list.length - 1];
}

// Picks the template for `date` (YYYY-MM-DD). With no weights (or all 1.0) it returns exactly the
// existing rotation, templates[dayIndex % length], so behaviour only changes once there is data.
// Otherwise a weighted, date-seeded choice that never repeats the previous day's template (the same
// "no two days in a row" rule as the rotation): it replays the 14 days before `date` so the answer
// for a date is always the same for the same weights.
export function pickTemplate(date, templates, weights) {
  if (!templates || !templates.length) return null;
  const tw = (weights && weights.templates) || {};
  const w = (t) => { const x = Number(tw[t]); return Number.isFinite(x) && x > 0 ? clamp(x) : 1; };
  if (templates.every((t) => w(t) === 1)) return templates[dayIndex(date) % templates.length];
  const eff = withFloors(templates, w, (weights && weights.typeFloors) || TYPE_FLOORS);
  const we = (t) => eff[t];
  let prev = null;
  for (let k = 14; k >= 0; k--) prev = pickOne(shift(date, -k), templates, we, prev);
  return prev;
}

// Raises any content type whose share of the total weight is under its floor (only for types that
// have at least one template in the list), taking the difference proportionally from the others.
export function withFloors(templates, w, floors) {
  const eff = Object.fromEntries(templates.map((t) => [t, w(t)]));
  const types = [...new Set(templates.map(contentType))];
  if (types.length < 2) return eff;
  const fl = Object.fromEntries(types.map((ty) => [ty, Math.max(0, Number((floors || {})[ty]) || 0)]));
  const floorSum = types.reduce((s, ty) => s + fl[ty], 0);
  if (floorSum >= 1) for (const ty of types) fl[ty] /= floorSum + 0.0001;
  for (let pass = 0; pass < 4; pass++) {
    const total = templates.reduce((s, t) => s + eff[t], 0);
    const share = (ty) => templates.filter((t) => contentType(t) === ty).reduce((s, t) => s + eff[t], 0) / total;
    const low = types.filter((ty) => share(ty) < fl[ty] - 1e-9);
    if (!low.length) break;
    const need = low.reduce((s, ty) => s + fl[ty], 0);
    const rest = types.filter((ty) => !low.includes(ty));
    const restShare = rest.reduce((s, ty) => s + share(ty), 0);
    for (const t of templates) {
      const ty = contentType(t);
      const cur = share(ty);
      eff[t] = low.includes(ty) ? (eff[t] / total) * (fl[ty] / cur) : restShare > 0 ? (eff[t] / total) * ((1 - need) / restShare) : eff[t] / total;
    }
  }
  return eff;
}

// Same idea for a list of candidate routes (no "not twice in a row" rule; routes already rotate).
export function pickWeighted(date, items, map, salt = "") {
  if (!items || !items.length) return null;
  const w = (t) => { const x = Number((map || {})[t]); return Number.isFinite(x) && x > 0 ? clamp(x) : 1; };
  return pickOne(date + salt, items, w, null);
}
