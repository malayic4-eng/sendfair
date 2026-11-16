// GET /go/<provider>?r=<route>  -> counts the click, then sends the visitor to the provider (affiliate link if set).
// An affiliateUrl may contain {route}, which is replaced with the route so networks can report earnings per route.
import { siteData } from "../_lib.js";

export async function onRequestGet(context) {
  const id = String(context.params.provider || "");
  const route = new URL(context.request.url).searchParams.get("r") || "";
  let data;
  try { data = await siteData(context); } catch { return Response.redirect(new URL("/", context.request.url).toString(), 302); }
  const p = data.pmap[id];
  if (!p) return Response.redirect(new URL("/", context.request.url).toString(), 302);

  const safeRoute = data.routes.has(route) ? route : "unknown";
  const target = (p.affiliateUrl || p.website).replace("{route}", encodeURIComponent(safeRoute));

  const kv = context.env.SENDFAIR_KV;
  if (kv) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `clicks:${day}:${safeRoute}:${id}`;
    context.waitUntil((async () => {
      const n = Number(await kv.get(key) || 0);
      await kv.put(key, String(n + 1), { expirationTtl: 60 * 60 * 24 * 400 });
    })());
  }
  return new Response(null, {
    status: 302,
    headers: { location: target, "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "strict-origin-when-cross-origin" }
  });
}
