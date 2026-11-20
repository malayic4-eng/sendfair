// Offline test of scripts/social-publish.mjs against a fake Graph API (global fetch is stubbed; no
// network). Each case runs the publisher in its own temp folder with a plan built by
// social-content.mjs and a minimal manifest. Checks:
//  - the Facebook Reel description and the Instagram caption carry no URL;
//  - a first comment goes on the Facebook Reel with the ?ref=fb link, and on the Instagram post;
//  - a comment that fails is logged {platform, type: "comment", status: "failed", error} and the run
//    goes on (TikTok still logged), and a rerun retries only the comment;
//  - idempotency: a rerun posts nothing twice;
//  - carousel days: Instagram carousel + comment, Facebook Reel + comment;
//  - FORCE_REEL: Instagram only;
//  - DRY_RUN logs and calls nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPlan } from "./social-content.mjs";

const REPO = process.cwd();
const PUBLISH = pathToFileURL(path.join(REPO, "scripts/social-publish.mjs")).href;
const fails = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails.push(msg); console.error("FAIL: " + msg); } };

function setup(dateIso, { carousel }) {
  const plan = buildPlan(new Date(dateIso));
  if (!plan) throw new Error("no plan for " + dateIso);
  if (!!plan.carousel !== carousel) throw new Error(`${dateIso}: expected carousel=${carousel}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-publish-"));
  const reelDir = path.join(dir, "data/social/reels", plan.date);
  fs.mkdirSync(reelDir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data/social/plan.json"), JSON.stringify(plan));
  fs.writeFileSync(path.join(dir, "data/social/schedule.json"), JSON.stringify(plan.schedule));
  fs.writeFileSync(path.join(dir, "data/social/log.json"), JSON.stringify({ attempts: [] }));
  fs.writeFileSync(path.join(reelDir, "reel.mp4"), Buffer.alloc(2048, 1));
  const manifest = {
    date: plan.date, template: plan.template, route: plan.route,
    captions: plan.reel.captions, links: plan.reel.links, comments: plan.reel.comments, series: plan.reel.series, question: plan.reel.question,
    carousel: plan.carousel ? { slides: ["carousel-1.jpg", "carousel-2.jpg", "carousel-3.jpg"], captions: plan.carousel.captions } : null
  };
  fs.writeFileSync(path.join(reelDir, "manifest.json"), JSON.stringify(manifest));
  return { dir, plan };
}

// Fake Graph API. failComments: comment calls return an OAuth permission error.
function fakeGraph(opts = {}) {
  const calls = [];
  let n = 0;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const fetchStub = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body instanceof FormData ? { form: true } : {};
    const call = { method: init.method || "GET", host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), body };
    calls.push(call);
    const p = u.pathname.replace(/^\/v[\d.]+/, "");
    if (u.host === "rupload.facebook.com") return new Response("{}", { status: 200 });
    if (u.host === "open.tiktokapis.com") return json({ error: { code: "not_used" } });
    if (p === "/me/accounts") return json({ data: [{ id: "PAGE1", access_token: "PAGE_TOKEN" }] });
    if (p === "/PAGE1" && call.method === "GET") return json({ instagram_business_account: { id: "IG1" } });
    if (p === "/ig_audio") return json({ data: [] });
    if (p === "/PAGE1/video_reels") {
      if (body.upload_phase === "start") return json({ video_id: "VID" + ++n, upload_url: "https://rupload.facebook.com/video-upload/v22.0/VID" + n });
      return json({ success: true });
    }
    if (p === "/PAGE1/photos") return json({ id: "PHOTO" + ++n, post_id: "PAGE1_" + n });
    if (p === "/IG1/media" && call.method === "POST") return json({ id: "CONT" + ++n });
    if (p === "/IG1/media_publish") return json({ id: "IGMEDIA" + ++n });
    if (/\/comments$/.test(p)) {
      if (opts.failComments) return json({ error: { message: "(#200) Permissions error", type: "OAuthException", code: 200 } }, 403);
      return json({ id: "C" + ++n });
    }
    if (/^\/CONT\d+$/.test(p)) return json({ status_code: "FINISHED" });
    return json({ error: { message: "unexpected call " + p } }, 400);
  };
  return { calls, fetchStub };
}

let runN = 0;
async function run(dir, graph, env = {}) {
  const realFetch = globalThis.fetch;
  const saved = {};
  const vars = { FB_PAGE_ID: "PAGE1", FB_PAGE_TOKEN: "USER_TOKEN", R2_PUBLIC_BASE: "https://r2.example", REEL_URL: "https://r2.example/reel.mp4", COVER_URL: "https://r2.example/cover.png", IMAGE_URL: "https://r2.example/image.png", COMMENT_RETRY_MS: "0", DRY_RUN: "0", FORCE_REEL: "0", TIKTOK_ACCESS_TOKEN: "", ...env };
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  const log = console.log;
  console.log = () => {};
  process.chdir(dir);
  globalThis.fetch = graph.fetchStub;
  try { await import(`${PUBLISH}?run=${++runN}`); }
  finally {
    globalThis.fetch = realFetch;
    process.chdir(REPO);
    console.log = log;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return JSON.parse(fs.readFileSync(path.join(dir, "data/social/log.json"), "utf8")).attempts;
}
const finishCall = (calls) => calls.find((c) => /\/video_reels$/.test(c.path) && c.body.upload_phase === "finish");
const commentCalls = (calls, re) => calls.filter((c) => /\/comments$/.test(c.path) && (!re || re.test(c.path)));
const URL_RE = /https?:\/\//;

// 1. A normal (Reel) day, everything works.
{
  const { dir, plan } = setup("2026-11-18T12:00:00Z", { carousel: false });
  const g = fakeGraph();
  const log = await run(dir, g);
  const fin = finishCall(g.calls);
  // schedule.fbLinkInComment is false until Meta approves comment permissions: the link goes in the caption.
  ok(fin && fin.body.description && fin.body.description.includes("https://sendfair.africa/"), "Facebook Reel description carries the site link");
  ok(fin && !fin.body.description.includes("first comment"), "Facebook description doesn't point to a comment that can't be posted");
  ok(fin && fin.body.description.startsWith(`${plan.reel.series.emoji} ${plan.reel.series.name} | `), "Facebook description opens with the series name");
  const igCont = g.calls.find((c) => c.path.endsWith("/IG1/media") && c.body.media_type === "REELS");
  ok(igCont && !URL_RE.test(igCont.body.caption), "Instagram caption has no URL");
  const fbC = commentCalls(g.calls, /\/VID\d+\/comments$/);
  ok(fbC.length === 1, `one Facebook comment on the Reel (got ${fbC.length})`);
  ok(fbC[0] && fbC[0].body.message.includes(plan.reel.links.facebook) && plan.reel.links.facebook.endsWith("?ref=fb"), "Facebook comment carries the ?ref=fb link");
  ok(fbC[0] && /\?/.test(fbC[0].body.message.replace(plan.reel.links.facebook, "")), "Facebook comment asks a question");
  ok(fbC[0] && fbC[0].body.access_token === "PAGE_TOKEN", "Facebook comment uses the Page token");
  const igC = commentCalls(g.calls, /\/IGMEDIA\d+\/comments$/);
  ok(igC.length === 1 && igC[0].body.message === plan.reel.comments.instagram, "Instagram first comment posted with the question");
  ok(log.filter((a) => a.type === "comment" && a.status === "posted").length === 2, "both comments logged as posted");
  ok(log.some((a) => a.platform === "facebook" && a.type === "reel" && a.status === "posted" && a.link === plan.reel.links.facebook), "Facebook Reel logged with its link");

  // 1b. Rerun: idempotency, nothing posted twice.
  const g2 = fakeGraph();
  const log2 = await run(dir, g2);
  ok(!g2.calls.some((c) => /video_reels|media_publish|\/photos$/.test(c.path)), "rerun posts no Reel again");
  ok(commentCalls(g2.calls).length === 0, "rerun posts no comment again");
  ok(log2.filter((a) => a.status === "posted").length === log.filter((a) => a.status === "posted").length, "rerun adds no posted entries");
}

// 2. Comments fail (e.g. the token lacks pages_manage_engagement / instagram_manage_comments).
{
  const { dir } = setup("2026-11-18T12:00:00Z", { carousel: false });
  const g = fakeGraph({ failComments: true });
  let threw = null;
  let log = [];
  try { log = await run(dir, g); } catch (e) { threw = e; }
  ok(!threw, "a failing comment does not stop the run" + (threw ? ": " + threw.message : ""));
  ok(log.some((a) => a.platform === "facebook" && a.type === "reel" && a.status === "posted"), "Facebook Reel still posted when the comment fails");
  ok(log.some((a) => a.platform === "instagram" && a.type === "reel" && a.status === "posted"), "Instagram Reel still posted when the comment fails");
  const fbF = log.find((a) => a.platform === "facebook" && a.type === "comment");
  const igF = log.find((a) => a.platform === "instagram" && a.type === "comment");
  ok(fbF && fbF.status === "failed" && /Permissions/.test(fbF.error), "failed Facebook comment logged {platform, type: comment, status: failed, error}");
  ok(igF && igF.status === "failed" && igF.error, "failed Instagram comment logged");
  ok(log.some((a) => a.platform === "tiktok"), "run continued to TikTok after the failed comments");
  ok(commentCalls(g.calls).length === 6, `each comment tried 3 times (got ${commentCalls(g.calls).length})`);
  // 2b. Rerun with comments working: only the comments are retried.
  const g2 = fakeGraph();
  const log2 = await run(dir, g2);
  ok(!g2.calls.some((c) => /video_reels|media_publish/.test(c.path)), "comment retry does not repost the Reel");
  ok(commentCalls(g2.calls).length === 2, "rerun retries the two missing comments");
  ok(log2.filter((a) => a.type === "comment" && a.status === "posted").length === 2, "retried comments logged as posted");
}

// 3. Carousel day: Instagram carousel + comment, Facebook Reel + comment.
{
  const { dir, plan } = setup("2026-11-17T12:00:00Z", { carousel: true });
  const g = fakeGraph();
  const log = await run(dir, g);
  const parent = g.calls.find((c) => c.path.endsWith("/IG1/media") && c.body.media_type === "CAROUSEL");
  ok(parent && !URL_RE.test(parent.body.caption) && /Swipe/.test(parent.body.caption), "carousel caption has the swipe line and no URL");
  ok(log.some((a) => a.platform === "instagram" && a.type === "carousel" && a.status === "posted"), "carousel posted");
  ok(!g.calls.some((c) => c.body.media_type === "REELS"), "no Instagram Reel on a carousel day");
  const fin = finishCall(g.calls);
  ok(fin && !fin.body.description.includes("first comment"), "carousel day: Facebook Reel description has no dangling first-comment line");
  ok(commentCalls(g.calls, /\/IGMEDIA\d+\/comments$/).length === 1, "carousel day: Instagram comment on the carousel");
  const fbC = commentCalls(g.calls, /\/VID\d+\/comments$/);
  ok(fbC.length === 1 && fbC[0].body.message.includes(plan.reel.links.facebook), "carousel day: Facebook comment with the link");
}

// 4. FORCE_REEL: Instagram Reel (and its comment) only, on a carousel day.
{
  const { dir } = setup("2026-11-17T12:00:00Z", { carousel: true });
  // The plan is rebuilt with FORCE_REEL=1 by the workflow; emulate by dropping the carousel.
  const p = JSON.parse(fs.readFileSync(path.join(dir, "data/social/plan.json"), "utf8"));
  p.carousel = null;
  fs.writeFileSync(path.join(dir, "data/social/plan.json"), JSON.stringify(p));
  const g = fakeGraph();
  const log = await run(dir, g, { FORCE_REEL: "1" });
  ok(log.some((a) => a.platform === "instagram" && a.type === "reel" && a.status === "posted"), "FORCE_REEL posts the Instagram Reel");
  ok(!log.some((a) => a.platform === "facebook" || a.platform === "tiktok"), "FORCE_REEL posts nothing to Facebook or TikTok");
}

// 5. DRY_RUN: logs, calls nothing.
{
  const { dir } = setup("2026-11-18T12:00:00Z", { carousel: false });
  const g = fakeGraph();
  const log = await run(dir, g, { DRY_RUN: "1" });
  ok(g.calls.length === 0, "dry run makes no API call");
  ok(log.some((a) => a.type === "comment" && a.status === "dry-run" && a.platform === "facebook"), "dry run logs the Facebook comment");
}

// 6. An old manifest whose captions still hold URLs: the publisher strips them from FB/IG text.
{
  const { dir, plan } = setup("2026-11-18T12:00:00Z", { carousel: false });
  const mf = path.join(dir, "data/social/reels", plan.date, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m.captions.facebook = m.captions.facebook.replace("link in the first comment 👇", plan.reel.links.facebook);
  m.captions.instagram = m.captions.instagram.replace("link in bio 🔗", plan.reel.links.instagram);
  fs.writeFileSync(mf, JSON.stringify(m));
  const g = fakeGraph();
  await run(dir, g);
  const fin = finishCall(g.calls);
  ok(fin && !fin.body.description.includes("first comment"), "old manifest: Facebook description has no dangling first-comment line");
  const igCont = g.calls.find((c) => c.path.endsWith("/IG1/media") && c.body.media_type === "REELS");
  ok(igCont && !URL_RE.test(igCont.body.caption), "old manifest: URL stripped from the Instagram caption");
}

console.log(`social-publish test: ${checks - fails.length}/${checks} checks passed`);
if (fails.length) process.exitCode = 1;
