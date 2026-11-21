// GET /go/<provider>?r=<route>  -> counts the click, then sends the visitor to the provider (affiliate link if set).
// An affiliateUrl may contain {route}, which is replaced with the route so networks can report earnings per route.
// Non-transfer partners (flights, eSIMs, house-calculator sponsors) come from data/partners.json:
//   /go/flights?o=LON&d=NBO&r=fly-kenya   /go/esim?r=fly-kenya   /go/<sponsor-id>?r=build-kenya
import { siteData, CLICK_PREFIX } from "../_lib.js";
import { TRAVEL_IDS, flightTarget, esimTarget, sponsorTarget, extrasFor, extraTarget } from "../../src/partner-links.mjs";

async function partnerRedirect(context, id, route) {
  const home = new URL("/", context.request.url).toString();
  let partners, receivers;
  try {
    const [pr, cr] = await Promise.all(["/data/partners.json", "/data/corridors.json"].map((p) => context.env.ASSETS.fetch(new URL(p, context.request.url))));
    if (!pr.ok || !cr.ok) return null;
    partners = await pr.json();
    receivers = (await cr.json()).receivers || [];
  } catch { return null; }
  const isSponsor = (partners.sponsors || []).some((x) => x.id === id);
  const isExtra = (((partners.travel || {}).extras) || []).some((x) => x.id === id);
  if (!TRAVEL_IDS.includes(id) && !isSponsor && !isExtra) return null;
  const q = new URL(context.request.url).searchParams;
  const m = /^(fly|build)-([a-z]+)$/.exec(route);
  const receiver = m && receivers.find((r) => r.id === m[2]);
  let target = null, safeRoute = "unknown";
  if (id === "flights" && m && m[1] === "fly" && receiver) {
    target = flightTarget(partners, { origin: q.get("o") || "", dest: q.get("d") || "", receiver: receiver.id, route, depart: q.get("dep") || undefined, ret: q.has("ret") ? q.get("ret") : undefined, adults: q.get("pax") || "1", via: q.get("via") === "kiwi" ? "kiwi" : undefined });
    safeRoute = route;
  } else if (id === "esim" && m && m[1] === "fly" && receiver) {
    target = esimTarget(partners, { countryName: receiver.name, route, receiver: receiver.id });
    safeRoute = route;
  } else if (isExtra && m && m[1] === "fly" && receiver) {
    target = extraTarget(partners, id, receiver.id);
    safeRoute = route;
  } else if (isSponsor) {
    target = sponsorTarget(partners, id);
    const sp = partners.sponsors.find((x) => x.id === id);
    if (m && m[1] === "build" && (sp.countries || []).includes(m[2])) safeRoute = route;
    if (!target) target = new URL(m && m[1] === "build" ? `/cost-to-build/${m[2]}/` : "/cost-to-build/", context.request.url).toString();
  }
  if (!target) target = home;
  return { target, safeRoute };
}

export async function onRequestGet(context) {
  const id = String(context.params.provider || "");
  const route = new URL(context.request.url).searchParams.get("r") || "";
  let data;
  try { data = await siteData(context); } catch { return Response.redirect(new URL("/", context.request.url).toString(), 302); }
  const p = data.pmap[id];
  let target, safeRoute;
  if (p) {
    safeRoute = data.routes.has(route) ? route : "unknown";
    target = (p.affiliateUrl || p.website).replace("{route}", encodeURIComponent(safeRoute));
  } else {
    const partner = await partnerRedirect(context, id, route);
    if (!partner) return Response.redirect(new URL("/", context.request.url).toString(), 302);
    ({ target, safeRoute } = partner);
  }

  const kv = context.env.SENDFAIR_KV;
  if (kv) {
    // One key per click (c:<day>:<route>:<id>:<random>), counted by listing in /api/stats. A shared
    // counter (read, add one, write) lost clicks when two landed at once; a unique key needs no read.
    // Days before this change are still stored as clicks:<day>:<route>:<id> totals and are still read.
    const day = new Date().toISOString().slice(0, 10);
    const key = `${CLICK_PREFIX}${day}:${safeRoute}:${id}:${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    context.waitUntil(kv.put(key, "1", { expirationTtl: 60 * 60 * 24 * 400 }).catch(() => {}));
  }
  return new Response(null, {
    status: 302,
    headers: { location: target, "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "strict-origin-when-cross-origin" }
  });
}
