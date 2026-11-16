// GET /api/stats?month=YYYY-MM  -> click counts per route and service. Private: needs the STATS_KEY via Authorization: Bearer.
import { json, month } from "../_lib.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const expected = context.env.STATS_KEY;
  const auth = context.request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!expected || bearer !== expected) return json({ error: "Wrong or missing stats key" }, 401);
  const kv = context.env.SENDFAIR_KV;
  const m = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : month();
  if (!kv) return json({ month: m, clicks: [], note: "Storage is not connected yet." });

  const counts = {};
  let cursor;
  do {
    const page = await kv.list({ prefix: `clicks:${m}-`, cursor });
    for (const k of page.keys) {
      const parts = k.name.split(":");
      const route = parts[2], provider = parts[3];
      const count = Number(await kv.get(k.name) || 0);
      const key = `${route}\u0000${provider}`;
      counts[key] = (counts[key] || 0) + count;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const clicks = Object.entries(counts).map(([key, count]) => {
    const [route, provider] = key.split("\u0000");
    return { route, provider, count };
  });
  return json({ month: m, clicks });
}
