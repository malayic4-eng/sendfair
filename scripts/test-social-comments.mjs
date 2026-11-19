// Comment fetch + /admin/comments handler test. Stubbed Graph API (including a permission error),
// comment parsing (skips the Page's own comments, marks answered ones, keeps only public fields),
// and the admin handler with a fake env (KV map, AI stub, fetch stub): listing, escaping, KV draft
// cache, regenerate, mark done, CSRF/Origin checks and the no-invented-numbers guard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect, parseFacebookComment, parseInstagramComment } from "./social-comments.mjs";
import * as admin from "../functions/social/comments-admin.js";

const checks = [];
const ok = (name, cond) => checks.push([name, !!cond]);
const J = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------- collect() ----------
const now = new Date("2026-11-20T05:00:00Z");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sf-comments-"));
fs.mkdirSync(path.join(root, "data/social"), { recursive: true });
fs.writeFileSync(path.join(root, "data/social/log.json"), JSON.stringify({ attempts: [
  { date: "2026-11-19", platform: "facebook", type: "carousel", template: "house", route: "drc-country", status: "posted", postId: "PHOTO1" },
  { date: "2026-11-19", platform: "instagram", type: "reel", template: "route", route: "uk-nigeria", status: "posted", postId: "IGM1", link: "https://sendfair.africa/send-money/uk-to-nigeria/?ref=ig" },
  { date: "2026-11-18", platform: "instagram", type: "reel", template: "tip", route: "us-ghana", status: "posted", postId: "IGM2" },
  { date: "2026-11-18", platform: "tiktok", type: "reel", template: "tip", route: "us-ghana", status: "manual", postId: "" },
  { date: "2026-09-01", platform: "facebook", type: "reel", template: "route", route: "uk-kenya", status: "posted", postId: "OLD" }
] }));
const seen = [];
async function graph(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/v\d+\.\d+\//, "");
  seen.push(p);
  if (p === "me/accounts") return J({ data: [{ id: "PAGE", access_token: "PT" }] });
  if (p === "PAGE") return J({ instagram_business_account: { id: "IGBIZ", username: "sendfair" } });
  if (p === "PHOTO1") return J({ permalink_url: "https://www.facebook.com/photo/?fbid=1" });
  if (p === "PHOTO1/comments") return J({ data: [
    { id: "111_1", message: "How much is cement in Kinshasa? <script>alert(1)</script>", from: { id: "U1", name: "Amani K" }, created_time: "2026-11-19T20:00:00+0000", permalink_url: "https://www.facebook.com/x/posts/1?comment_id=1" },
    { id: "111_2", message: "Thanks for following!", from: { id: "PAGE", name: "SendFair" }, created_time: "2026-11-19T21:00:00+0000" },
    { id: "111_3", message: "Answered already", from: { id: "U2", name: "Bea" }, created_time: "2026-11-19T22:00:00+0000", comments: { data: [{ from: { id: "PAGE" } }] } },
    { id: "111_4", message: "Too old", from: { id: "U3", name: "Old" }, created_time: "2026-11-10T22:00:00+0000" },
    { id: "111_5", message: "Link", from: { id: "U4", name: "Evil" }, created_time: "2026-11-19T23:00:00+0000", permalink_url: "javascript:alert(1)" }
  ] });
  if (p === "IGM1") return J({ permalink: "https://www.instagram.com/reel/abc/" });
  if (p === "IGM1/comments") return J({ data: [
    { id: "179_1", text: "Which app is cheapest UK to Nigeria?", username: "tobi", timestamp: "2026-11-19T18:00:00+0000", from: { id: "X1", username: "tobi" } },
    { id: "179_2", text: "Check our page!", username: "SendFair", timestamp: "2026-11-19T18:30:00+0000" },
    { id: "179_3", text: "C'est combien les frais ?", username: "awa", timestamp: "2026-11-19T19:00:00+0000", replies: { data: [{ username: "sendfair", from: { id: "IGBIZ" } }] } }
  ] });
  if (p === "IGM2") return J({ permalink: "https://www.instagram.com/reel/def/" });
  if (p === "IGM2/comments") return J({ error: { message: "(#10) Application does not have permission for this action", code: 10 } }, 403);
  return J({ error: { message: "unexpected " + p, code: 100 } }, 400);
}
const res = await collect({ env: { FB_PAGE_TOKEN: "USER", FB_PAGE_ID: "PAGE" }, fetchImpl: graph, now, root });
const byId = Object.fromEntries(res.comments.map((c) => [c.id, c]));
ok("page's own comments skipped (FB and IG, case-insensitive username)", !byId.fb_111_2 && !byId.ig_179_2);
ok("old comments skipped", !byId.fb_111_4);
ok("posts older than 30 days and TikTok are not read", !seen.some((p) => p.startsWith("OLD")) && seen.every((p) => !/tiktok/.test(p)));
ok("answered flags (FB page reply, IG account reply)", byId.fb_111_3.answered === true && byId.ig_179_3.answered === true && byId.fb_111_1.answered === false);
ok("FB comment fields", byId.fb_111_1.author === "Amani K" && byId.fb_111_1.platform === "facebook" && byId.fb_111_1.createdAt === "2026-11-19T20:00:00.000Z" && byId.fb_111_1.permalink.startsWith("https://www.facebook.com/"));
ok("non-https permalink replaced with the post link", byId.fb_111_5.permalink === "https://www.facebook.com/photo/?fbid=1");
ok("IG comment uses @username and the post permalink", byId.ig_179_1.author === "@tobi" && byId.ig_179_1.permalink === "https://www.instagram.com/reel/abc/");
ok("topic and site page link (no ?ref)", byId.fb_111_1.topic === "building" && byId.ig_179_1.topic === "transfers" && byId.ig_179_1.pageLink === "https://sendfair.africa/send-money/uk-to-nigeria/");
const allowed = new Set(["id", "platform", "author", "text", "createdAt", "permalink", "answered", "postUrl", "topic", "template", "route", "pageLink"]);
ok("only public fields in the public file (no user ids)", res.comments.every((c) => Object.keys(c).every((k) => allowed.has(k))) && !JSON.stringify(res).includes("\"U1\"") && !JSON.stringify(res).includes("X1"));
ok("newest first", res.comments.map((c) => c.createdAt).join() === [...res.comments.map((c) => c.createdAt)].sort().reverse().join());
ok("permission error recorded, not fatal", res.issues.some((i) => /permission/.test(i)) && res.comments.length === 5);
const noTok = await collect({ env: {}, fetchImpl: () => { throw new Error("no"); }, now, root });
ok("no token -> empty list with a reason", noTok.comments.length === 0 && /FB_PAGE_TOKEN/.test(noTok.issues[0]));
ok("parsers return null for junk", parseFacebookComment(null, { post: {} }) === null && parseInstagramComment({}, { post: {} }) === null);
fs.rmSync(root, { recursive: true, force: true });

// ---------- admin handler ----------
class KV { constructor() { this.m = new Map(); this.ttl = new Map(); } async get(k) { return this.m.has(k) ? this.m.get(k) : null; } async put(k, v, o = {}) { this.m.set(k, String(v)); this.ttl.set(k, o.expirationTtl); } async delete(k) { this.m.delete(k); } }
const file = { generatedAt: "2026-11-20T05:00:00Z", issues: [], comments: [
  ...res.comments,
  { id: "ig_bad\"><x", platform: "instagram", author: "x", text: "dropped", createdAt: "2026-11-20T00:00:00Z" },
  { id: "fb_999", platform: "facebook", author: "<img src=x onerror=alert(1)>", text: "Is it 1500 naira per pound today?", createdAt: "2026-11-20T04:00:00Z", permalink: "https://www.facebook.com/c/999", topic: "transfers" }
] };
let aiCalls = 0, aiNext = null;
const env = {
  SENDFAIR_KV: new KV(),
  SOCIAL_MEDIA_BASE: "https://media.example.com",
  AI: { run: async (model, input) => {
    aiCalls++;
    if (aiNext) { const v = aiNext; aiNext = null; return { response: v }; }
    const sys = input.messages[0].content, user = input.messages[1].content;
    if (model !== admin.MODEL || !/same language/.test(sys)) throw new Error("bad prompt");
    if (/cement/.test(user)) return { response: "Great question! See the latest building estimates on https://sendfair.africa/cost-to-build/drc/." };
    if (/1500/.test(user)) return { response: "\"Today it is 1,980 naira per pound with Lemfi.\"" };
    return { response: "Reply: Thanks! Compare today's amounts on https://sendfair.africa 🙂" };
  } }
};
const realFetch = globalThis.fetch;
let fetched = [];
globalThis.fetch = async (url) => { fetched.push(String(url)); return String(url) === "https://media.example.com/social/comments.json" ? J(file) : J({}, 404); };
const ORIGIN = "https://sendfair.africa";
const call = (p, { method = "GET", body, headers = {} } = {}) => admin.handle({ request: new Request(ORIGIN + p, { method, headers, body: body ? JSON.stringify(body) : undefined }), env });

let r = await call("/admin/comments");
let html = await r.text();
ok("page 200, html, no-store, CSP with nonce", r.status === 200 && /text\/html/.test(r.headers.get("content-type")) && r.headers.get("cache-control") === "no-store" && /script-src 'nonce-/.test(r.headers.get("content-security-policy")));
ok("reads socialMediaBase/social/comments.json", fetched[0] === "https://media.example.com/social/comments.json");
ok("lists unanswered only (answered and malformed dropped)", (html.match(/<article /g) || []).length === 4 && !html.includes("Answered already") && !html.includes("dropped"));
ok("newest first", html.indexOf("data-id=\"fb_999\"") < html.indexOf("data-id=\"fb_111_1\""));
ok("everything escaped", !html.includes("<script>alert(1)</script>") && html.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !html.includes("<img src=x") && !html.includes("javascript:"));
ok("building draft points to cost-to-build", html.includes("https://sendfair.africa/cost-to-build/drc/"));
ok("prefix and quotes stripped from drafts", html.includes("Thanks! Compare today&#39;s amounts on https://sendfair.africa") && !html.includes("Reply: Thanks"));
ok("invented rate rejected -> standard reply with note", !html.includes("1,980") && html.includes("Rates change every day") && html.includes("a number that is not in the comment"));
ok("buttons present", ["Copy reply", "Open comment", "Regenerate", "Mark done"].every((b) => html.includes(b)));
ok("drafts cached in KV for 7 days", env.SENDFAIR_KV.m.has("cmt:draft:fb_111_1") && env.SENDFAIR_KV.ttl.get("cmt:draft:fb_111_1") === 7 * 86400);
const before = aiCalls;
await (await call("/admin/comments")).text();
ok("second load uses the KV cache (no AI calls)", aiCalls === before);

const good = { "content-type": "application/json", Origin: ORIGIN, "x-sf-admin": "1" };
r = await call("/admin/comments/done", { method: "POST", body: { id: "fb_111_1" }, headers: { ...good, Origin: "https://evil.example" } });
ok("cross-origin POST refused", r.status === 403);
r = await call("/admin/comments/done", { method: "POST", body: { id: "fb_111_1" }, headers: { "content-type": "application/json", Origin: ORIGIN } });
ok("POST without x-sf-admin refused", r.status === 403);
r = await call("/admin/comments/done", { method: "POST", body: { id: "../x" }, headers: good });
ok("bad id refused", r.status === 400);
r = await call("/admin/comments/done", { method: "GET" });
ok("GET on an action refused", r.status === 405);
r = await call("/admin/comments/done", { method: "POST", body: { id: "fb_111_1" }, headers: good });
ok("mark done stored", r.status === 200 && env.SENDFAIR_KV.m.has("cmt:done:fb_111_1"));
html = await (await call("/admin/comments")).text();
ok("done comment hidden", !html.includes("data-id=\"fb_111_1\""));
aiNext = "Asante! Angalia viwango vya leo kwenye https://sendfair.africa";
r = await call("/admin/comments/regenerate", { method: "POST", body: { id: "ig_179_1" }, headers: good });
const rd = await r.json();
ok("regenerate returns and caches a new draft", r.status === 200 && rd.draft.text.startsWith("Asante") && JSON.parse(env.SENDFAIR_KV.m.get("cmt:draft:ig_179_1")).text.startsWith("Asante"));
aiNext = "Use https://evil.example/promo for a better rate";
r = await call("/admin/comments/regenerate", { method: "POST", body: { id: "ig_179_1" }, headers: good });
ok("off-site link rejected", (await r.json()).draft.note.includes("link to another site"));
aiNext = "SKIP";
r = await call("/admin/comments/regenerate", { method: "POST", body: { id: "ig_179_1" }, headers: good });
ok("SKIP -> empty draft with a note", (await r.json()).draft.text === "");
r = await call("/admin/comments/regenerate", { method: "POST", body: { id: "fb_424242" }, headers: good });
ok("regenerate unknown id -> 404", r.status === 404);
ok("unknown sub-path -> 404", (await call("/admin/comments/other")).status === 404);
ok("system prompt: building rules, no numbers, same language", /cost-to-build/.test(admin.systemPrompt({ topic: "building", pageLink: "" })) && /Never state a price/.test(admin.systemPrompt({ topic: "building" })) && /same language/.test(admin.systemPrompt({ topic: "transfers" })));
ok("checkDraft allows numbers from the comment", admin.checkDraft("Yes, 500 works on sendfair.africa", { text: "can I send 500?" }) === "");

// Missing file and no AI.
globalThis.fetch = async () => J({}, 404);
html = await (await admin.handle({ request: new Request(ORIGIN + "/admin/comments"), env: { SENDFAIR_KV: new KV() } })).text();
ok("missing comments file -> friendly error", html.includes("HTTP 404") && html.includes("No unanswered comments"));
ok("default media base when nothing set", (await admin.mediaBase({})) === admin.DEFAULT_MEDIA_BASE);
globalThis.fetch = async () => J(file);
const noAi = await admin.makeDraft({}, { topic: "building", text: "hi", pageLink: "" });
ok("no AI binding -> standard building reply", noAi.text.includes("https://sendfair.africa/cost-to-build/"));
globalThis.fetch = realFetch;

let bad = 0;
for (const [name, pass] of checks) if (!pass) { bad++; console.log("FAIL:", name); }
console.log(`social comments test: ${checks.length - bad}/${checks.length} checks passed`);
if (bad) process.exitCode = 1;
