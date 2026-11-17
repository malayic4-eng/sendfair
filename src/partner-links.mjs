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
export function flightTarget(partners, { origin, dest, receiver, route }) {
  const t = (partners && partners.travel) || {};
  const o = Object.values(partners.origins || {}).flat().find(([code]) => code === origin);
  const d = ((partners.airports || {})[receiver] || []).find(([code]) => code === dest);
  if (!o || !d || !t.flightsUrl) return null;
  const url = fill(t.flightsUrl, {
    from: o[0], to: d[0], fromCity: encodeURIComponent(o[1]), toCity: encodeURIComponent(d[1]), route: encodeURIComponent(route || "")
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
