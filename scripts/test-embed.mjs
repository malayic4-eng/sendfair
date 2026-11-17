// Embed widget test: runs the real /embed/widget/ handler against dist/ (ASSETS), an in-memory KV and
// edge cache, then checks size, top-3 ranking against rank(), headers, validation, caching and host counts.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const R = require("../src/rank.js");
const store = new Map();
globalThis.caches = { default: { match: async (k) => (store.has(k.url) ? store.get(k.url).clone() : undefined), put: async (k, r) => { store.set(k.url, r); } } };
const { embedWidget, embedStats } = await import("../src/embed-worker.js");
const { safeEqual } = await import("../functions/api/reports.js");
const { json } = await import("../functions/_lib.js");
const kv = new Map();
const env = {
  ADMIN_PASSWORD: "test-pw",
  SENDFAIR_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) },
  ASSETS: { fetch: async (req) => { const p = new URL(req.url).pathname; const f = new URL("../dist" + p, import.meta.url); return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response("", { status: 404 }); } }
};
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const get = (q, ref) => embedWidget(new Request("https://sendfair.africa/embed/widget/" + q, { headers: ref ? { referer: ref } : {} }), env, ctx);
const checks = [];
const ok = (name, cond, info = "") => checks.push([name, !!cond, info]);

const res = await get("?route=uk-nigeria&amount=250&theme=light", "https://www.naija-blog.example/post/1");
const html = await res.text();
ok("200 html", res.status === 200 && /text\/html/.test(res.headers.get("content-type")));
ok("under 30 KB", html.length < 30000, html.length + " bytes");
ok("frame-ancestors *", /frame-ancestors \*/.test(res.headers.get("content-security-policy") || ""));
ok("no X-Frame-Options", !res.headers.get("x-frame-options"));
ok("15-minute cache", /max-age=900/.test(res.headers.get("cache-control") || ""));
ok("noindex", res.headers.get("x-robots-tag") === "noindex");
ok("no third-party scripts", !/<script[^>]+src=/i.test(html) && !/googletagmanager|clarity|gtag/.test(html));
const names = [...html.matchAll(/<span class="p">([^<]+)<\/span>/g)].map((m) => m[1]);
ok("three services", names.length === 3, names.join(", "));
// compare with the page's own ranking
const D = (f) => JSON.parse(fs.readFileSync(new URL("../dist/data/" + f, import.meta.url)));
const q = D("quotes.json"), site = D("site.json"), cor = D("corridors.json");
const pm = Object.fromEntries(D("providers.json").providers.map((p) => [p.id, p]));
const rows = R.rank({ list: q.quotes["uk-nigeria"], feed: (D("wise-feed.json").routes || {})["uk-nigeria"] || null, providers: pm, amount: 250, payout: "all", payIn: "all", promo: false, mid: R.midRate(D("midmarket.json"), "GBP", "NGN"), now: Date.now(), staleH: site.staleAfterHours || 36, hideH: site.hideAfterHours || 72, handLockH: site.preferAutoAfterHours || site.handLockHours || 6, refAmount: site.defaultAmounts.GBP }).filter((x) => !x.stale);
const pageTop = rows.slice(0, 3).map((x) => x.p.name);
ok("matches page top 3", JSON.stringify(pageTop) === JSON.stringify(names.map((n) => n.replace(/&amp;/g, "&"))), pageTop.join(", "));
ok("checked time", /Checked \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2} UTC/.test(html));
ok("compare link", html.includes('href="https://sendfair.africa/send-money/uk-to-nigeria/?amount=250&amp;ref=embed"') && html.includes("&host="), "");
await Promise.all(waits.splice(0));
ok("cached copy stored", store.size === 1);
const again = await get("?route=uk-nigeria&amount=250&theme=light", "https://blog.example.org/");
ok("cache hit served", again.status === 200 && (await again.text()) === html);
const dark = await get("?route=uk-nigeria&amount=250&theme=dark"); ok("dark theme", (await dark.text()).includes("#111853"));
ok("bad route 400", (await get("?route=..&amount=250")).status === 400);
ok("amount 5 → 400", (await get("?route=uk-nigeria&amount=5")).status === 400);
ok("unknown route 404", (await get("?route=uk-atlantis&amount=250")).status === 404);
ok("default amount", (await get("?route=us-kenya")).status === 200);
// counting: first load per host writes, own site is ignored
await get("?route=uk-nigeria", "https://sendfair.africa/embed/");
await Promise.all(waits.splice(0));
const day = new Date().toISOString().slice(0, 10);
ok("host counted", kv.get(`embed:${day}:naija-blog.example`) === "1" && kv.get(`embed:${day}:blog.example.org`) === "1", [...kv.keys()].join(" "));
ok("own site not counted", ![...kv.keys()].some((k) => k.endsWith(":sendfair.africa")));
const st = await embedStats(new Request("https://sendfair.africa/api/embeds", { headers: { "x-admin-password": "test-pw" } }), env, safeEqual, json);
const sj = await st.json();
ok("stats with password", st.status === 200 && sj.hosts.some((h) => h.host === "naija-blog.example" && h.loads === 1));
ok("stats refused without", (await embedStats(new Request("https://sendfair.africa/api/embeds"), env, safeEqual, json)).status === 401);
fs.writeFileSync((await import("node:os")).tmpdir() + "/embed-preview.html", html);
const failed = checks.filter((c) => !c[1]);
for (const c of checks) if (!c[1] || process.env.VERBOSE) console.log((c[1] ? "ok  " : "FAIL") + " " + c[0] + (c[2] ? " — " + c[2] : ""));
console.log(`embed test: ${checks.length - failed.length}/${checks.length} checks passed; widget ${html.length} bytes; top 3: ${names.join(", ")}`);
if (failed.length) process.exit(1);
