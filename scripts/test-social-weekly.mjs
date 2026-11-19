// Weekly social report test: stubbed Graph API (including permission errors and a retired metric),
// metrics aggregation, the report text, weights bounds/fairness and the deterministic template pick.
// No network, writes only to a temporary folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./social-weekly.mjs";
import { computeWeights, pickTemplate, withFloors, contentType, MIN_W, MAX_W } from "./social-weights.mjs";
import { rankBy, formatTrends, performanceSection } from "./social-analytics.mjs";

const checks = [];
const ok = (name, cond) => checks.push([name, !!cond]);

const now = new Date("2026-11-23T07:00:00Z");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sf-weekly-"));
fs.mkdirSync(path.join(root, "data/social"), { recursive: true });
const A = (date, platform, type, template, route, postId, status = "posted") => ({ at: `${date}T14:00:00Z`, date, platform, type, template, route, postId, status });
const attempts = [
  A("2026-11-20", "instagram", "reel", "route", "uk-nigeria", "IG1"),
  A("2026-11-20", "facebook", "reel", "route", "uk-nigeria", "FBV1"),
  A("2026-11-21", "instagram", "carousel", "house", "ke-nairobi", "IG2"),
  A("2026-11-21", "facebook", "carousel", "house", "ke-nairobi", "FBP2"),
  A("2026-11-22", "instagram", "reel", "tip", "us-ghana", "IG3"),
  A("2026-11-22", "tiktok", "reel", "tip", "us-ghana", ""),
  A("2026-11-22", "instagram", "reel", "tip", "us-ghana", "", "failed"),
  A("2026-11-19", "instagram", "reel", "route", "uk-nigeria", "IGDRY", "dry-run")
];
fs.writeFileSync(path.join(root, "data/social/log.json"), JSON.stringify({ attempts }));
fs.writeFileSync(path.join(root, "data/social/trends.json"), JSON.stringify({ items: [{ title: "Cement prices", why: "up 8% in Nairobi searches", url: "https://example.com/t" }, "Detty December flights"] }));

const calls = [];
const J = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const permErr = { error: { message: "(#10) Application does not have permission for this action", type: "OAuthException", code: 10 } };
async function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  calls.push(u.pathname + (u.searchParams.get("metric") ? "?metric=" + u.searchParams.get("metric") : "") + (u.searchParams.get("fields") ? "?fields=" + u.searchParams.get("fields") : ""));
  if (u.hostname === "api.resend.com") return J({ id: "em_1" });
  const p = u.pathname.replace(/^\/v\d+\.\d+\//, "");
  const metric = u.searchParams.get("metric") || "";
  const fields = u.searchParams.get("fields") || "";
  if (p === "me/accounts") return J({ data: [{ id: "PAGE", access_token: "PT" }] });
  if (u.searchParams.get("access_token") !== "PT") return J({ error: { message: "wrong token", code: 190 } }, 400);
  // Instagram media
  if (p === "IG1" || p === "IG2" || p === "IG3") {
    const base = { IG1: { like_count: 40, comments_count: 5, permalink: "https://www.instagram.com/reel/IG1/", media_product_type: "REELS" }, IG2: { like_count: 30, comments_count: 2, permalink: "https://www.instagram.com/p/IG2/", media_product_type: "FEED" }, IG3: { like_count: 4, comments_count: 0, permalink: "https://www.instagram.com/reel/IG3/", media_product_type: "REELS" } }[p];
    return J(Object.fromEntries(fields.split(",").map((f) => [f, base[f]])));
  }
  if (/^IG\d\/insights$/.test(p)) {
    const id = p.split("/")[0];
    // "plays" is retired: asking for it in a list errors the whole call.
    if (metric.split(",").includes("plays")) return J({ error: { message: "(#100) metric[0] must be one of ...", code: 100 } }, 400);
    if (id === "IG3" && metric.includes("total_interactions")) return J({ error: { message: "(#100) invalid metric total_interactions", code: 100 } }, 400);
    const vals = { IG1: { views: 1000, reach: 800, saved: 10, shares: 5, total_interactions: 60 }, IG2: { views: 3000, reach: 2000, saved: 50, shares: 20 }, IG3: { views: 200, reach: 150, saved: 1, shares: 0 } }[id];
    return J({ data: metric.split(",").map((m) => ({ name: m, values: [{ value: vals[m] }] })) });
  }
  // Facebook reel: insights need read_insights, which this token does not have.
  if (p === "FBV1/video_insights") return J(permErr, 403);
  if (p === "FBV1") return J({ permalink_url: "/reel/FBV1", reactions: { summary: { total_count: 7 } }, comments: { summary: { total_count: 1 } } });
  if (p === "FBP2") return J({ page_story_id: "PAGE_222" });
  if (p === "PAGE_222") {
    if (fields.includes("shares") && fields.includes(",")) return J({ error: { message: "(#100) Tried accessing nonexisting field (shares)", code: 100 } }, 400);
    if (fields === "shares") return J({ error: { message: "(#100) Tried accessing nonexisting field (shares)", code: 100 } }, 400);
    if (fields === "permalink_url") return J({ permalink_url: "https://www.facebook.com/PAGE/posts/222" });
    if (fields.startsWith("reactions")) return J({ reactions: { summary: { total_count: 12 } } });
    if (fields.startsWith("comments")) return J({ comments: { summary: { total_count: 3 } } });
  }
  if (p === "PAGE_222/insights") {
    if (metric.includes("post_impressions,") || metric === "post_impressions") return J({ error: { message: "(#100) The value must be a valid insights metric", code: 100 } }, 400);
    if (metric.includes(",")) return J({ error: { message: "(#100) The value must be a valid insights metric", code: 100 } }, 400);
    return J({ data: [{ name: metric, values: [{ value: metric === "post_media_view" ? 900 : 600 }] }] });
  }
  return J({ error: { message: "unexpected " + p, code: 100 } }, 400);
}

const out = [];
const env = { FB_PAGE_TOKEN: "USER", FB_PAGE_ID: "PAGE", RESEND_API_KEY: "re", OWNER_ALERT_EMAIL: "owner@example.com" };
const res = await run({ env, fetchImpl: fakeFetch, now, root, log: (s) => out.push(String(s)) });

const perf = JSON.parse(fs.readFileSync(path.join(root, "data/social/performance.json"), "utf8"));
const P = perf.posts;
ok("five measurable posts stored (no tiktok, no failed, no dry-run)", Object.keys(P).length === 5);
ok("IG reel views/reach/likes/comments/saves", P["instagram:IG1"].metrics.views === 1000 && P["instagram:IG1"].metrics.reach === 800 && P["instagram:IG1"].metrics.likes === 40 && P["instagram:IG1"].metrics.saves === 10);
ok("IG engagement rate = (40+5+5+10)/800", P["instagram:IG1"].metrics.engagement === 60 && P["instagram:IG1"].metrics.er === 0.075);
ok("invalid IG metric falls back per metric", P["instagram:IG3"].metrics.views === 200);
ok("IG permalink kept", P["instagram:IG2"].permalink === "https://www.instagram.com/p/IG2/");
ok("FB reel without read_insights still gets reactions/comments", P["facebook:FBV1"].metrics.likes === 7 && P["facebook:FBV1"].metrics.comments === 1 && P["facebook:FBV1"].metrics.views === undefined);
ok("FB reel relative permalink made absolute", P["facebook:FBV1"].permalink === "https://www.facebook.com/reel/FBV1");
ok("FB photo -> page post with views (post_media_view) and reach", P["facebook:FBP2"].metrics.views === 900 && P["facebook:FBP2"].metrics.reach === 600 && P["facebook:FBP2"].metrics.likes === 12);
ok("permission issue recorded in performance.json", perf.issues.some((i) => /permission/i.test(i)));
ok("report lists the missing permission", /Missing permissions/.test(res.text) && /does not have permission/.test(res.text));
ok("report has 'what to do more of'", /What to do more of:/.test(res.text));
ok("report groups by content type", /By content type/.test(res.text) && /building:/.test(res.text) && /transfers:/.test(res.text));
ok("top post is the carousel (3000 views)", res.text.indexOf("2026-11-21 instagram carousel house") > -1 && /1\. 2026-11-21 instagram carousel house/.test(res.text));
ok("trends section shown when trends.json exists", /Trending in your niche/.test(res.text) && /Cement prices: up 8%/.test(res.text));
ok("html escapes and links", /<a href="https:\/\/www.instagram.com\/p\/IG2\/">open<\/a>/.test(res.html));
ok("log.json keeps plays/reach", JSON.parse(fs.readFileSync(path.join(root, "data/social/log.json"), "utf8")).attempts[0].plays === 1000);
ok("no Buttondown key -> owner email via Resend", res.delivered === true && calls.some((c) => c.startsWith("/emails")));
ok("weights.json written", fs.existsSync(path.join(root, "data/social/weights.json")));

// No trends file -> no section.
fs.rmSync(path.join(root, "data/social/trends.json"));
const res2 = await run({ env: { ...env, RESEND_API_KEY: "" }, fetchImpl: fakeFetch, now, root, send: false, log: () => {} });
ok("no trends section without trends.json", !/Trending in your niche/.test(res2.text));
// No token at all: nothing fetched, report still produced, previous metrics kept.
const res3 = await run({ env: {}, fetchImpl: async () => { throw new Error("must not call"); }, now, root, send: false, log: () => {} });
ok("no token: report still produced and says why", /FB_PAGE_TOKEN is not set/.test(res3.text) && res3.perf.posts["instagram:IG1"].metrics.views === 1000);

// ---- Weights ----
const mk = (n, template, route, views, start = 1) => Array.from({ length: n }, (_, i) => ({ date: `2026-11-${String(start + i).padStart(2, "0")}`, template, route, platform: "instagram", metrics: { views } }));
const posts = [...mk(4, "route", "uk-nigeria", 100000), ...mk(4, "house", "ke-nairobi", 10, 5), ...mk(2, "tip", "us-ghana", 5000, 9), ...mk(3, "best-vs-average", "us-kenya", 0, 11)];
const w = computeWeights(posts, { now: new Date("2026-11-20T00:00:00Z") });
const allW = [...Object.values(w.templates), ...Object.values(w.routes), ...Object.values(w.types)];
ok("weights bounded 0.5..2.0", allW.every((x) => x >= MIN_W && x <= MAX_W));
ok("winner gets > 1, loser < 1", w.templates.route > 1 && w.templates.house < 1);
ok("bucket with < 3 posts stays 1.0", w.templates.tip === 1 && w.routes["us-ghana"] === 1);
ok("extreme winner capped at 2.0 or below", w.templates.route <= 2);
ok("loser floored at 0.5 or above", w.templates["best-vs-average"] >= 0.5);
ok("building floor relaxes only with clear 28-day data", w.typeFloors.building === 0.15);
const wOld = computeWeights(posts, { now: new Date("2027-02-01T00:00:00Z") });
ok("posts older than 28 days ignored", wOld.items === 0 && Object.keys(wOld.templates).length === 0);
const wFew = computeWeights(mk(2, "house", "x", 1), { now: new Date("2026-11-20T00:00:00Z") });
ok("building floor stays 25% with too little data", wFew.typeFloors.building === 0.25);
ok("unknown templates are their own bucket", contentType("material-price-of-the-week") === "building" && contentType("flights-home") === "other" && computeWeights(mk(3, "material-price-of-the-week", "ke", 5), { now: new Date("2026-11-20T00:00:00Z") }).templates["material-price-of-the-week"] === 1);

// ---- pickTemplate ----
const T = ["route", "best-vs-average", "house", "tip", "rate-move"];
const dayIdx = (d) => Math.floor((Date.parse(d + "T00:00:00Z") - Date.UTC(Number(d.slice(0, 4)), 0, 1)) / 86400000);
ok("no weights -> existing rotation", ["2026-11-20", "2026-11-21", "2026-12-31"].every((d) => pickTemplate(d, T, null) === T[dayIdx(d) % T.length]) && pickTemplate("2026-11-20", T, { templates: { route: 1 } }) === T[dayIdx("2026-11-20") % T.length]);
const W = { templates: { route: 2, "best-vs-average": 2, house: 0.5, tip: 2, "rate-move": 2 }, typeFloors: { building: 0.25, transfers: 0.25, other: 0.1 } };
ok("deterministic for a date", pickTemplate("2026-12-05", T, W) === pickTemplate("2026-12-05", T, W));
const count = {}; let repeats = 0, prev = null;
for (let i = 0; i < 1000; i++) { const d = new Date(Date.UTC(2027, 0, 1) + i * 86400000).toISOString().slice(0, 10); const t = pickTemplate(d, T, W); if (t === prev) repeats++; prev = t; count[t] = (count[t] || 0) + 1; }
ok("never the same template two days running", repeats === 0);
ok("every template still appears", T.every((t) => count[t] > 50));
ok(`building keeps about a quarter of posts even when weighted down (${count.house / 10}%)`, count.house >= 220);
const eff = withFloors(T, (t) => W.templates[t], W.typeFloors);
const tot = Object.values(eff).reduce((a, b) => a + b, 0);
ok("withFloors gives building exactly its floor share", Math.abs(eff.house / tot - 0.25) < 0.001);

// ---- helpers ----
const r = rankBy([{ template: "a", metrics: { views: 10, engagement: 1, reach: 10 } }, { template: "a", metrics: {} }, { template: "b", metrics: { views: 30 } }], "template");
ok("rankBy orders by average views and counts unmeasured", r[0].key === "b" && r[1].measured === 1 && r[1].posts === 2 && r[1].er === 10);
ok("formatTrends accepts strings, objects and drops bad urls", formatTrends(["x", { name: "y", link: "javascript:alert(1)" }]).map((t) => t.url).join("") === "");
const sec = performanceSection({ posts7: [], posts28: [], issues: [], weights: null, trends: [{ title: "<script>" }] });
ok("html escapes trend text", sec.html.includes("&lt;script&gt;") && !sec.html.includes("<script>"));

fs.rmSync(root, { recursive: true, force: true });
let bad = 0;
for (const [name, pass] of checks) if (!pass) { bad++; console.log("FAIL:", name); }
console.log(`social weekly test: ${checks.length - bad}/${checks.length} checks passed`);
if (bad) process.exitCode = 1;
