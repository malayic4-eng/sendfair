// Daily comment fetch for reply drafting (.github/workflows/social-comments.yml).
// Reads comments from the last 3 days on our Facebook and Instagram posts (posts in data/social/log.json
// from the last 30 days), skips comments by the Page/Instagram account itself, marks comments the Page
// has already replied to, and writes data/social/tmp/comments.json (git-ignored). The workflow uploads
// it to the public R2 bucket as social/comments.json, where the Worker's /admin/comments page reads it.
//
// The file is public, so it holds only what is already public on the platforms: the commenter's
// display name or username, the comment text, its time and its permalink (plus our own post link and
// topic). No user ids, no emails, nothing private. Every Graph call is non-fatal.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { graphClient, resolvePage, summarizeIssues } from "./social-graph.mjs";
import { contentType } from "./social-weights.mjs";

const ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POST_DAYS = 30, COMMENT_DAYS = 3, MAX_TEXT = 1500;

const clean = (s, n) => String(s || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n);
const httpsOnly = (u) => (/^https:\/\/([a-z0-9-]+\.)*(facebook\.com|instagram\.com|sendfair\.africa)\//i.test(String(u || "")) ? String(u) : "");
const siteLink = (u) => { const s = httpsOnly(u); if (!s) return ""; try { const x = new URL(s); x.search = ""; return x.toString(); } catch { return ""; } };

// Facebook /{object}/comments item -> comment record (or null when it is the Page's own comment).
export function parseFacebookComment(c, { pageId, post }) {
  if (!c || !c.id) return null;
  if (c.from && pageId && String(c.from.id) === String(pageId)) return null;
  const replies = (c.comments && c.comments.data) || [];
  return {
    id: `fb_${String(c.id).replace(/[^0-9A-Za-z_]/g, "_")}`,
    platform: "facebook",
    author: clean(c.from && c.from.name, 80) || "Facebook user",
    text: clean(c.message, MAX_TEXT),
    createdAt: new Date(c.created_time || 0).toISOString(),
    permalink: httpsOnly(c.permalink_url) || post.postUrl || "",
    answered: replies.some((r) => r && r.from && String(r.from.id) === String(pageId)),
    ...postInfo(post)
  };
}

// Instagram /{media}/comments item -> comment record (or null when it is our own account's comment).
export function parseInstagramComment(c, { ig, post }) {
  if (!c || !c.id) return null;
  const user = c.username || (c.from && c.from.username) || "";
  const ours = (x) => ig && x && ((ig.username && (x.username || "").toLowerCase() === ig.username.toLowerCase()) || (ig.id && x.from && String(x.from.id) === String(ig.id)) || (ig.id && x.id === ig.id));
  if (ours({ username: user, from: c.from })) return null;
  const replies = (c.replies && c.replies.data) || [];
  return {
    id: `ig_${String(c.id).replace(/[^0-9A-Za-z_]/g, "_")}`,
    platform: "instagram",
    author: clean(user ? "@" + user : "", 80) || "Instagram user",
    text: clean(c.text, MAX_TEXT),
    createdAt: new Date(c.timestamp || 0).toISOString(),
    // Instagram comments have no public permalink of their own; the post's permalink opens them.
    permalink: post.postUrl || "",
    answered: replies.some((r) => ours(r)),
    ...postInfo(post)
  };
}

function postInfo(post) {
  return { postUrl: post.postUrl || "", topic: post.topic, template: post.template || "", route: post.route || "", pageLink: post.pageLink || "" };
}

export async function collect({ env = process.env, fetchImpl = fetch, now = new Date(), root = ROOT_DEFAULT } = {}) {
  const version = env.FB_GRAPH_VERSION || "v22.0";
  const log = JSON.parse(fs.readFileSync(path.join(root, "data/social/log.json"), "utf8"));
  const postFrom = new Date(now.getTime() - POST_DAYS * 86400000).toISOString().slice(0, 10);
  const since = now.getTime() - COMMENT_DAYS * 86400000;
  const issues = [];
  const out = { generatedAt: now.toISOString(), windowDays: COMMENT_DAYS, comments: [], issues: [] };
  if (!env.FB_PAGE_TOKEN) { out.issues = ["FB_PAGE_TOKEN is not set, so no comments were fetched"]; return out; }
  const { pageToken, ig } = await resolvePage({ token: env.FB_PAGE_TOKEN, pageId: env.FB_PAGE_ID, version, fetchImpl });
  const g = graphClient({ token: pageToken, version, fetchImpl, issues });

  const seen = new Set();
  const posts = (log.attempts || []).filter((a) => a.status === "posted" && a.postId && (a.platform === "facebook" || a.platform === "instagram") && a.date >= postFrom);
  for (const a of posts) {
    const key = `${a.platform}:${a.postId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const post = { template: a.template, route: a.route, topic: contentType(a.template), pageLink: siteLink(a.link), postUrl: "" };
    if (a.platform === "facebook") {
      const meta = await g.fields(String(a.postId), ["permalink_url"], "facebook post");
      post.postUrl = httpsOnly(meta.permalink_url && !/^https?:/.test(meta.permalink_url) ? `https://www.facebook.com${meta.permalink_url}` : meta.permalink_url);
      const d = await g.get(`${a.postId}/comments`, { fields: "id,message,from{id,name},created_time,permalink_url,comments.limit(25){from{id}}", filter: "toplevel", order: "reverse_chronological", limit: "50" });
      if (d.error) { g.note("facebook comments", d.error); continue; }
      for (const c of d.data || []) {
        if (Date.parse(c.created_time) < since) continue;
        const r = parseFacebookComment(c, { pageId: env.FB_PAGE_ID, post });
        if (r && r.text) out.comments.push(r);
      }
    } else {
      const meta = await g.fields(String(a.postId), ["permalink"], "instagram media");
      post.postUrl = httpsOnly(meta.permalink);
      const d = await g.get(`${a.postId}/comments`, { fields: "id,text,username,timestamp,from{id,username},replies{username,from{id}}", limit: "50" });
      if (d.error) { g.note("instagram comments", d.error); continue; }
      for (const c of d.data || []) {
        if (Date.parse(c.timestamp) < since) continue;
        const r = parseInstagramComment(c, { ig, post });
        if (r && r.text) out.comments.push(r);
      }
    }
  }
  out.comments.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  out.issues = summarizeIssues(issues);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = await collect();
  const file = path.join(ROOT_DEFAULT, "data/social/tmp/comments.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(res, null, 1) + "\n");
  const open = res.comments.filter((c) => !c.answered).length;
  console.log(`Comments in the last ${res.windowDays} days: ${res.comments.length} (${open} without a Page reply). Written to ${path.relative(ROOT_DEFAULT, file)}`);
  for (const i of res.issues) console.log(`Issue: ${i}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Social comments\n\n${res.comments.length} comments, ${open} unanswered.\n${res.issues.map((i) => `- ${i}`).join("\n")}\n`);
  // No token: tell the workflow not to overwrite the last good file.
  if (!process.env.FB_PAGE_TOKEN) fs.writeFileSync(path.join(ROOT_DEFAULT, "data/social/tmp/comments.skip"), "no token\n");
}
