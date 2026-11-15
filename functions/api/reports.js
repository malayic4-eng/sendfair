// GET /api/reports?route=uk-kenya  -> typical delivery time per service, from the last two months of reports.
import { BUCKETS, json, month } from "../_lib.js";

export async function onRequestGet(context) {
  const route = new URL(context.request.url).searchParams.get("route") || "";
  if (!/^[a-z]+-[a-z]+$/.test(route)) return json({ error: "Unknown route." }, 400);
  const kv = context.env.SENDFAIR_KV;
  if (!kv) return json({ route, providers: {} });

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
  return json({ route, providers }, 200, { "cache-control": "public, max-age=300" });
}
