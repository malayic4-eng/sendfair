// GET /api/stats?key=<STATS_KEY>&month=YYYY-MM  -> click counts per route and service. Private: needs the STATS_KEY variable.
import { json, month } from "../_lib.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const expected = context.env.STATS_KEY;
  if (!expected || url.searchParams.get("key") !== expected) return json({ error: "Wrong or missing stats key" }, 401);
  const kv = context.env.SENDFAIR_KV;
  const m = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : month();
  if (!kv) return json({ month: m, clicks: [], note: "Storage is not connected yet." });

  const clicks = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: `clicks:${m}:`, cursor });
    const values = await Promise.all(page.keys.map((k) => kv.get(k.name)));
    page.keys.forEach((k, i) => {
      const [, , route, provider] = k.name.split(":");
      clicks.push({ route, provider, count: parseInt(values[i] || "0", 10) });
    });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return json({ month: m, clicks });
}
