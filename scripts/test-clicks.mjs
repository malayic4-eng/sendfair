// Click counting: /go/<provider> writes one KV key per click, /api/stats counts them (paginated) and still
// adds the old clicks:<day>:<route>:<id> totals. Uses an in-memory KV with Cloudflare's 1000-keys-per-page list.
//   node scripts/test-clicks.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onRequestGet as go } from "../functions/go/[provider].js";
import { onRequestGet as stats } from "../functions/api/stats.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok" : "FAIL"} ${msg}`); if (!ok) failures++; };

function memoryKV() {
  const store = new Map();
  return {
    store,
    async get(k) { await new Promise((r) => setTimeout(r, Math.random() * 3)); return store.has(k) ? store.get(k) : null; },
    async put(k, v, opts) { await new Promise((r) => setTimeout(r, Math.random() * 3)); store.set(k, String(v)); this.lastOpts = opts; },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const size = Math.min(limit, 1000);
      const keys = names.slice(start, start + size).map((name) => ({ name }));
      const end = start + keys.length;
      return end < names.length ? { keys, list_complete: false, cursor: String(end) } : { keys, list_complete: true };
    }
  };
}

const assets = {
  async fetch(u) {
    const p = new URL(u).pathname;
    const file = path.join(ROOT, p.replace(/^\//, ""));
    if (!p.startsWith("/data/") || !fs.existsSync(file)) return new Response("nf", { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { "content-type": "application/json" } });
  }
};

const kv = memoryKV();
const env = { SENDFAIR_KV: kv, ASSETS: assets, STATS_KEY: "secret" };
const today = new Date().toISOString().slice(0, 10);
const m = today.slice(0, 7);

// 1. 60 simultaneous clicks on one route/provider: none may be lost.
const pending = [];
const clicks = Array.from({ length: 60 }, () => go({
  params: { provider: "wise" }, env,
  request: new Request("https://sendfair.africa/go/wise?r=uk-nigeria"),
  waitUntil: (p) => pending.push(p)
}));
const responses = await Promise.all(clicks);
await Promise.all(pending);
check(responses.every((r) => r.status === 302 && r.headers.get("location")), "every click redirects (302 with a location)");
const keys = [...kv.store.keys()].filter((k) => k.startsWith(`c:${today}:uk-nigeria:wise:`));
check(keys.length === 60, `60 concurrent clicks stored as 60 keys (got ${keys.length})`);
check(kv.lastOpts && kv.lastOpts.expirationTtl === 60 * 60 * 24 * 400, "click keys keep the 400-day TTL");
check(![...kv.store.keys()].some((k) => k.startsWith("clicks:")), "no legacy read-modify-write counter is written");

// 2. Unknown route is stored as "unknown"; unknown provider is not counted.
pending.length = 0;
await go({ params: { provider: "wise" }, env, request: new Request("https://sendfair.africa/go/wise?r=nope"), waitUntil: (p) => pending.push(p) });
await go({ params: { provider: "not-a-provider" }, env, request: new Request("https://sendfair.africa/go/not-a-provider?r=uk-nigeria"), waitUntil: (p) => pending.push(p) });
await Promise.all(pending);
check([...kv.store.keys()].filter((k) => k.startsWith(`c:${today}:unknown:wise:`)).length === 1, "unknown route counted under 'unknown'");
check(![...kv.store.keys()].some((k) => k.includes(":not-a-provider")), "unknown provider not counted");

// 3. Pagination: 2,345 more click keys on another pair, plus legacy totals for the same month and another month.
for (let i = 0; i < 2345; i++) kv.store.set(`c:${m}-01:us-kenya:remitly:${String(i).padStart(8, "0")}`, "1");
kv.store.set(`clicks:${m}-01:us-kenya:remitly`, "7");
kv.store.set(`clicks:${m}-02:uk-ghana:lemfi`, "4");
kv.store.set(`clicks:1999-01-01:uk-ghana:lemfi`, "100");
kv.store.set(`cmt:${m}-01:x`, "should not be read");
const res = await stats({ env, request: new Request(`https://sendfair.africa/api/stats?month=${m}`, { headers: { Authorization: "Bearer secret" } }) });
const body = await res.json();
const count = (route, provider) => (body.clicks.find((c) => c.route === route && c.provider === provider) || {}).count || 0;
check(res.status === 200, "stats answers 200 with the key");
check(count("uk-nigeria", "wise") === 60, `uk-nigeria/wise = 60 (got ${count("uk-nigeria", "wise")})`);
check(count("us-kenya", "remitly") === 2352, `us-kenya/remitly = 2345 new + 7 legacy over 3 list pages (got ${count("us-kenya", "remitly")})`);
check(count("uk-ghana", "lemfi") === 4, `legacy-only total read for uk-ghana/lemfi (got ${count("uk-ghana", "lemfi")})`);
check(count("unknown", "wise") === 1, "unknown route reported");
const other = await (await stats({ env, request: new Request("https://sendfair.africa/api/stats?month=1999-01", { headers: { Authorization: "Bearer secret" } }) })).json();
check(other.clicks.length === 1 && other.clicks[0].count === 100, "an old month with only legacy totals still reports them");
const denied = await stats({ env, request: new Request(`https://sendfair.africa/api/stats?month=${m}`) });
check(denied.status === 401, "stats without the key is refused");

console.log(`clicks: ${failures} failure(s)`);
if (failures) process.exit(1);
