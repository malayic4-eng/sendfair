// Where non-transfer partner links go: flights home, travel eSIMs and house-calculator sponsors.
// Shared by the site build (scripts/build.mjs) and the /go/ redirect (functions/go/[provider].js),
// so a link on the page and the redirect behind it can never disagree.
// Data lives in data/partners.json.

export const TRAVEL_IDS = ["flights", "esim"];

const today = (now) => new Date(now).toISOString().slice(0, 10);

// A sponsor shows (and its /go/ link forwards) only between its start and end dates, inclusive.
export function sponsorLive(sp, now = Date.now()) {
  const d = today(now);
  return !!sp && (!sp.starts || sp.starts <= d) && (!sp.ends || d <= sp.ends);
}

export function sponsorsFor(partners, countryId, now = Date.now()) {
  return ((partners && partners.sponsors) || []).filter((sp) => (sp.countries || []).includes(countryId) && sponsorLive(sp, now));
}

const fill = (tpl, vals) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vals ? vals[k] : m));
const wrap = (w, url) => (w ? fill(w, { url: encodeURIComponent(url) }) : url);

// Flight search from an origin city code to a destination airport code.
// Returns null if either code is not one we list, so the redirect can't be pointed anywhere else.
// Travel dates for a flight search. Aviasales needs them in the link (DDMM, no year): without a
// date it cannot run the search. Bad, past or missing dates fall back to "in 3 weeks, back 2 weeks
// later"; a bad return date becomes 2 weeks after departure; an empty return means one-way.
const DAY = 86400000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export function tripDates({ depart, ret, now = Date.now() } = {}) {
  const today = Date.parse(isoDay(now));
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !Number.isNaN(Date.parse(s));
  let dep = ok(depart) ? Date.parse(depart) : NaN;
  if (!(dep >= today && dep <= today + 330 * DAY)) dep = today + 21 * DAY;
  let back;
  if (ret === "") back = NaN; // one-way, asked for
  else {
    back = ok(ret) ? Date.parse(ret) : dep + 14 * DAY;
    if (!(back > dep && back <= today + 360 * DAY)) back = dep + 14 * DAY;
  }
  return { depart: isoDay(dep), ret: Number.isNaN(back) ? "" : isoDay(back) };
}
const ddmm = (iso) => iso ? iso.slice(8, 10) + iso.slice(5, 7) : "";

export function flightTarget(partners, { origin, dest, receiver, route, depart, ret, adults, now }) {
  const t = (partners && partners.travel) || {};
  const o = Object.values(partners.origins || {}).flat().find(([code]) => code === origin);
  const d = ((partners.airports || {})[receiver] || []).find(([code]) => code === dest);
  if (!o || !d || !t.flightsUrl) return null;
  const dates = tripDates({ depart, ret, now });
  const pax = Math.min(9, Math.max(1, parseInt(adults, 10) || 1));
  const url = fill(t.flightsUrl, {
    from: o[0], to: d[0], fromCity: encodeURIComponent(o[1]), toCity: encodeURIComponent(d[1]), route: encodeURIComponent(route || ""),
    dep: ddmm(dates.depart), ret: ddmm(dates.ret), adults: String(pax), depart: dates.depart, return: dates.ret
  });
  return wrap(t.flightsWrap, url);
}

export function esimTarget(partners, { countryName, route }) {
  const t = (partners && partners.travel) || {};
  if (!t.esimUrl) return null;
  return wrap(t.esimWrap, fill(t.esimUrl, { country: encodeURIComponent(countryName || ""), route: encodeURIComponent(route || "") }));
}

export function sponsorTarget(partners, id, now = Date.now()) {
  const sp = ((partners && partners.sponsors) || []).find((x) => x.id === id);
  return sponsorLive(sp, now) ? sp.url : null;
}

// More trip-home partners (transfers, car hire, other eSIMs, flight-delay claims, activities).
export function extrasFor(partners, countryId) {
  return (((partners && partners.travel) || {}).extras || []).filter((x) => x && x.id && x.url && (!x.countries || x.countries.includes(countryId)));
}

export function extraTarget(partners, id, countryId) {
  const x = extrasFor(partners, countryId).find((e) => e.id === id);
  return x ? wrap(x.wrap, x.url) : null;
}
