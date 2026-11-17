// POST /api/report  { route, provider, bucket, rating?, comment? }  -> saves one delivery-time report,
// plus an optional 1–5 rating and a 200-character comment held for moderation.
import { BUCKETS, json, siteData, month, sha256 } from "../_lib.js";

// Strip links, emails and phone numbers before anything reaches the KV store.
function cleanComment(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);
  t = t.replace(/https?:\/\/\S+|www\.\S+/gi, "[link removed]");
  t = t.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[email removed]");
  t = t.replace(/\+?\d[\d\s().-]{7,}\d/g, "[number removed]");
  t = t.replace(/<[^>]*>/g, "").trim();
  return t.slice(0, 200);
}

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

  // Optional rating/comment. Stored unapproved; /api/reports only returns approved comments.
  const rating = Math.round(Number(body.rating));
  const comment = cleanComment(body.comment);
  if (comment || (rating >= 1 && rating <= 5)) {
    const id = crypto.randomUUID();
    const item = { id, route, provider, rating: rating >= 1 && rating <= 5 ? rating : null, text: comment, at: new Date().toISOString(), approved: false };
    await kv.put(`cmt:${route}:${id}`, JSON.stringify(item), { expirationTtl: 60 * 60 * 24 * 365 });
    const idx = JSON.parse((await kv.get(`cmtidx:${route}`)) || "[]");
    idx.unshift(id);
    await kv.put(`cmtidx:${route}`, JSON.stringify(idx.slice(0, 200)), { expirationTtl: 60 * 60 * 24 * 365 });
  }

  return json({ ok: true, pending: !!comment });
}

export function onRequest() {
  return json({ error: "Use POST." }, 405, { allow: "POST" });
}
