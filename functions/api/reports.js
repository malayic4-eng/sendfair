// GET /api/reports?route=uk-kenya  -> typical delivery time per service, from the last two months of reports,
// plus the latest approved comments for the route.
// GET /api/reports?pending=1       -> unapproved comments across routes (x-admin-password required).
// POST /api/reports { route, id, approve } -> approve or hide a comment (x-admin-password required).
import { BUCKETS, json, month, siteData } from "../_lib.js";

// Constant-time string compare for the admin password.
function safeEqual(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length) return false;
  let out = 0;
  for (let i = 0; i < x.length; i++) out |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return out === 0;
}

async function approvedComments(kv, route) {
  const ids = JSON.parse((await kv.get(`cmtidx:${route}`)) || "[]");
  const list = await Promise.all(ids.slice(0, 60).map(async (id) => {
    const raw = await kv.get(`cmt:${route}:${id}`);
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  }));
  return list.filter((c) => c && c.approved && c.text).sort((a, b) => (a.at < b.at ? 1 : -1));
}

async function pendingComments(context, kv) {
  let data;
  try { data = await siteData(context); } catch { return null; }
  const out = [];
  for (const route of data.routes) {
    const ids = JSON.parse((await kv.get(`cmtidx:${route}`)) || "[]");
    for (const id of ids) {
      const raw = await kv.get(`cmt:${route}:${id}`);
      if (!raw) continue;
      try {
        const c = JSON.parse(raw);
        if (!c.approved) out.push({ route, id, provider: c.provider, rating: c.rating, text: c.text, at: c.at });
      } catch {}
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const kv = context.env.SENDFAIR_KV;

  if (url.searchParams.get("pending") === "1") {
    const pw = context.request.headers.get("x-admin-password") || "";
    if (!context.env.ADMIN_PASSWORD || !safeEqual(pw, context.env.ADMIN_PASSWORD)) return json({ error: "Not allowed." }, 401);
    if (!kv) return json({ pending: [] });
    const pending = await pendingComments(context, kv);
    if (pending === null) return json({ error: "Site data is unavailable." }, 503);
    return json({ pending });
  }

  const route = url.searchParams.get("route") || "";
  if (!/^[a-z]+-[a-z]+$/.test(route)) return json({ error: "Unknown route." }, 400);
  if (!kv) return json({ route, providers: {}, comments: [] });

  const [a, b] = await Promise.all([kv.get(`rep:${month()}:${route}`), kv.get(`rep:${month(-1)}:${route}`)]);
  const merged = {};
  for (const src of [a, b]) {
    const obj = JSON.parse(src || "{}");
    for (const [prov, counts] of Object.entries(obj)) {
      merged[prov] = merged[prov] || {};
      for (const [k, n] of Object.entries(counts)) if (BUCKETS[k]) merged[prov][k] = (merged[prov][k] || 0) + n;
    }
  }
  const providers = {};
  for (const [prov, counts] of Object.entries(merged)) {
    const n = Object.values(counts).reduce((x, y) => x + y, 0);
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
    providers[prov] = { n, typical: BUCKETS[top[0]], counts };
  }
  const comments = await approvedComments(kv, route).catch(() => []);
  return json({
    route,
    providers,
    comments: comments.slice(0, 10).map(({ id, provider, rating, text, at }) => ({ id, provider, rating, text, at }))
  }, 200, { "cache-control": "public, max-age=300" });
}

// Moderation: comments stay hidden until approved here. Guarded by ADMIN_PASSWORD.
export async function onRequestPost(context) {
  const env = context.env;
  const pw = context.request.headers.get("x-admin-password") || "";
  if (!env.ADMIN_PASSWORD || !safeEqual(pw, env.ADMIN_PASSWORD)) return json({ error: "Not allowed." }, 401);
  let body; try { body = await context.request.json(); } catch { return json({ error: "Send JSON." }, 400); }
  const route = String(body.route || ""), id = String(body.id || "");
  if (!/^[a-z]+-[a-z]+$/.test(route) || !id) return json({ error: "route and id are required." }, 400);
  const kv = env.SENDFAIR_KV;
  if (!kv) return json({ error: "Storage not available." }, 503);
  const raw = await kv.get(`cmt:${route}:${id}`);
  if (!raw) return json({ error: "Not found." }, 404);
  const item = JSON.parse(raw);
  item.approved = body.approve !== false;
  await kv.put(`cmt:${route}:${id}`, JSON.stringify(item), { expirationTtl: 60 * 60 * 24 * 365 });
  return json({ ok: true, approved: item.approved });
}
