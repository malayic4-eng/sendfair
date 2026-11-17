// POST /api/plan  { country, state }  -> freezes the current receipt in KV and returns a short plan URL.
// The receipt is computed server-side from the calculator state with the published prices of the day.
// No personal data is stored; only the calculator state and the frozen receipt.
import { json, sha256 } from "../_lib.js";
import SFBuild from "../../src/build-cost.js";

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const STATE_KEY = /^(size|floors|m2|finish|site|quote|with|from|opt_[a-z]{2,20})$/;

function planId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => ID_ALPHABET[x % ID_ALPHABET.length]).join("");
}

async function asset(env, request, p) {
  const r = await env.ASSETS.fetch(new Request(new URL(p, request.url)));
  if (!r.ok) throw new Error(p);
  return r.json();
}

export async function onRequestPost(context) {
  const kv = context.env.SENDFAIR_KV;
  if (!kv) return json({ error: "Plans are not switched on yet." }, 503);

  let body;
  try { body = await context.request.json(); } catch { return json({ error: "Send the plan as JSON." }, 400); }
  const country = String(body.country || "");
  const state = body.state && typeof body.state === "object" ? body.state : {};
  if (!/^[a-z]{3,20}$/.test(country)) return json({ error: "Unknown country." }, 400);

  // Whitelist the calculator state. Nothing personal is accepted or stored.
  const clean = {};
  for (const [k, v] of Object.entries(state)) {
    if (!STATE_KEY.test(k) || (typeof v !== "string" && typeof v !== "number")) continue;
    clean[k] = String(v).slice(0, 40);
  }

  let data, mid;
  try {
    [data, mid] = await Promise.all([
      asset(context.env, context.request, "/data/build-costs.json"),
      asset(context.env, context.request, "/data/midmarket.json")
    ]);
  } catch { return json({ error: "Site data is unavailable. Try again shortly." }, 503); }
  if (!data.countries || !data.countries[country]) return json({ error: "Unknown country." }, 400);

  const size = clean.size === "custom" || clean.m2 ? "custom" : (clean.size || "3");
  const area = size === "custom"
    ? Math.max(20, Math.min(1000, parseFloat(clean.m2) || 120))
    : (((data.houses || []).find((h) => h.id === size) || { m2: 110 }).m2);
  const storeys = clean.floors === "2" ? 2 : 1;
  const finish = clean.finish === "economy" || clean.finish === "luxury" ? clean.finish : "standard";
  const site = clean.site === "steep" ? "steep" : "flat";
  const picks = {};
  for (const [k, v] of Object.entries(clean)) if (k.indexOf("opt_") === 0 && v) picks[k.slice(4)] = v;
  const quote = Math.max(0, parseFloat(clean.quote) || 0);

  let est;
  try { est = SFBuild.estimate(data, country, area, storeys, (mid && mid.rates) || {}, picks, { finish, site }); }
  catch { return json({ error: "Could not price that plan." }, 400); }
  if (!est || !(est.total > 0)) return json({ error: "Could not price that plan." }, 400);

  const house = (data.houses || []).find((h) => h.id === (clean.size || "3"));
  const receipt = {
    countryName: est.country.name, city: est.country.city, currency: est.currency,
    area: Math.round(area), houseName: size === "custom" ? Math.round(area) + " m²" : (house ? house.name : Math.round(area) + " m²"),
    shape: storeys === 2 ? "maisonette, two floors" : "bungalow, one floor",
    lines: est.lines, total: est.total, stages: est.stages,
    contingency: est.contingency, contractor: est.contractor, professional: est.professional,
    band: est.band, missing: est.missing, quotedLines: est.quotedLines, guideLines: est.guideLines,
    updated: data.updated, nextReview: data.nextReview
  };

  // Light rate limit: 10 new plans per hour per connection hash (the IP itself is never stored).
  const ip = context.request.headers.get("CF-Connecting-IP") || "unknown";
  const rl = "rl:plan:" + (await sha256(ip)).slice(0, 16);
  const n = Number(await kv.get(rl) || 0);
  if (n >= 10) return json({ error: "Too many plans from this connection. Try again later." }, 429);
  await kv.put(rl, String(n + 1), { expirationTtl: 3600 });

  let id;
  for (let i = 0; i < 6; i++) { id = planId(); if (!(await kv.get("plan:" + id))) break; }
  const plan = { id, country, state: clean, receipt, quote, createdAt: new Date().toISOString() };
  await kv.put("plan:" + id, JSON.stringify(plan), { expirationTtl: 60 * 60 * 24 * 365 });
  return json({ id, url: `/cost-to-build/${country}/plan/${id}/` });
}

export function onRequest() {
  return json({ error: "Use POST." }, 405, { allow: "POST" });
}
