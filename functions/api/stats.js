// GET /api/stats?month=YYYY-MM  -> click counts per route and service. Private: needs the STATS_KEY via Authorization: Bearer.
// Each click is its own KV key (c:<day>:<route>:<id>:<random>), so a click is counted by listing keys, without reading
// them. Days recorded before that change are running totals under clicks:<day>:<route>:<id> and are read and added in.
import { json, month, CLICK_PREFIX, LEGACY_CLICK_PREFIX } from "../_lib.js";

// KV returns at most 1000 keys per list call; follow the cursor until the list is complete.
async function eachKey(kv, prefix, fn) {
  let cursor;
  do {
    const page = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const k of page.keys) await fn(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

export async function countClicks(kv, m) {
  const counts = {};
  const add = (route, provider, n) => {
    if (!route || !provider || !(n > 0)) return;
    const key = `${route}\u0000${provider}`;
    counts[key] = (counts[key] || 0) + n;
  };
  await eachKey(kv, `${CLICK_PREFIX}${m}-`, (name) => {
    const parts = name.split(":"); // c, day, route, provider, random
    add(parts[2], parts[3], 1);
  });
  await eachKey(kv, `${LEGACY_CLICK_PREFIX}${m}-`, async (name) => {
    const parts = name.split(":"); // clicks, day, route, provider
    add(parts[2], parts[3], Number(await kv.get(name) || 0));
  });
  return Object.entries(counts).map(([key, count]) => {
    const [route, provider] = key.split("\u0000");
    return { route, provider, count };
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const expected = context.env.STATS_KEY;
  const auth = context.request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!expected || bearer !== expected) return json({ error: "Wrong or missing stats key" }, 401);
  const kv = context.env.SENDFAIR_KV;
  const m = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : month();
  if (!kv) return json({ month: m, clicks: [], note: "Storage is not connected yet." });
  return json({ month: m, clicks: await countClicks(kv, m) });
}
