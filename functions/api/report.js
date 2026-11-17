// POST /api/report  { route, provider, bucket }  -> saves one delivery-time report.
import { BUCKETS, json, siteData, month, sha256 } from "../_lib.js";

export async function onRequestPost(context) {
  const kv = context.env.SENDFAIR_KV;
  if (!kv) return json({ error: "Delivery reports are not switched on yet." }, 503);

  let body;
  try { body = await context.request.json(); } catch { return json({ error: "Send the report as JSON." }, 400); }
  const route = String(body.route || ""), provider = String(body.provider || ""), bucket = String(body.bucket || "");

  let data;
  try { data = await siteData(context); } catch { return json({ error: "Site data is unavailable. Try again shortly." }, 503); }
  if (!data.routes.has(route)) return json({ error: "Unknown route." }, 400);
  if (!data.pmap[provider]) return json({ error: "Unknown service." }, 400);
  if (!BUCKETS[bucket]) return json({ error: "Choose how long it took." }, 400);

  // One report per visitor, route and service per day. Only a one-way hash is stored, never the IP.
  const ip = context.request.headers.get("CF-Connecting-IP") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const limitKey = "rl:" + (await sha256(`${ip}|${route}|${provider}|${day}`));
  if (await kv.get(limitKey)) return json({ error: "You already reported this service today. Thank you." }, 429);
  await kv.put(limitKey, "1", { expirationTtl: 172800 });

  const key = `rep:${month()}:${route}`;
  const agg = JSON.parse((await kv.get(key)) || "{}");
  agg[provider] = agg[provider] || {};
  agg[provider][bucket] = (agg[provider][bucket] || 0) + 1;
  await kv.put(key, JSON.stringify(agg), { expirationTtl: 60 * 60 * 24 * 120 });

  return json({ ok: true });
}

export function onRequest() {
  return json({ error: "Use POST." }, 405, { allow: "POST" });
}
