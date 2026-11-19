// Weekly social report (Mondays): what was posted, its link, and per-post metrics from the Graph API
// (views/plays, reach, likes, comments, shares, saves). Ranks by template, route and platform, names
// the top 3 posts, says in one line what to do more of, and writes:
//   data/social/performance.json  per-post metrics (refreshed for posts from the last 28 days)
//   data/social/weights.json      template/route weights from the last 28 days (scripts/social-weights.mjs)
// Sends as before: a Buttondown DRAFT with a preview copy to SOCIAL_REPORT_EMAIL. If Buttondown is not
// set up (or fails), the text goes to the owner via notifyOwner (Resend or webhook) instead.
// Every Graph call is non-fatal; missing permissions are listed in the report.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { graphClient, resolvePage, summarizeIssues } from "./social-graph.mjs";
import { fetchPostMetrics, measurable, perfKey, performanceSection } from "./social-analytics.mjs";
import { computeWeights } from "./social-weights.mjs";
import { notifyOwner } from "./providers/notify.mjs";

const ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const day = (now, n) => new Date(now.getTime() - n * 86400000).toISOString().slice(0, 10);
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };

export async function run({ env = process.env, fetchImpl = fetch, now = new Date(), root = ROOT_DEFAULT, send = true, log: say = console.log } = {}) {
  const P = (f) => path.join(root, "data/social", f);
  const log = readJson(P("log.json"), { attempts: [] });
  const version = env.FB_GRAPH_VERSION || "v22.0";
  const runUrl = env.RUN_URL || "";
  const cutoff7 = day(now, 7), cutoff28 = day(now, 28);
  const rows = (log.attempts || []).filter((a) => a.date >= cutoff7 && a.status !== "dry-run");

  // ---- Metrics ----
  const perf = readJson(P("performance.json"), { posts: {} });
  perf.posts = perf.posts || {};
  const issues = [];
  let pageToken = "";
  if (env.FB_PAGE_TOKEN) {
    pageToken = (await resolvePage({ token: env.FB_PAGE_TOKEN, pageId: env.FB_PAGE_ID, version, fetchImpl })).pageToken || env.FB_PAGE_TOKEN;
  } else {
    issues.push({ kind: "token", where: "all", message: "FB_PAGE_TOKEN is not set, so no metrics were fetched" });
  }
  const g = graphClient({ token: pageToken, version, fetchImpl, issues });
  const seen = new Set();
  for (const a of measurable(log.attempts, cutoff28)) {
    const k = perfKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!pageToken) continue;
    const { metrics, permalink } = await fetchPostMetrics(g, a);
    const prev = perf.posts[k] || {};
    perf.posts[k] = {
      date: a.date, platform: a.platform, type: a.type, template: a.template, route: a.route, postId: String(a.postId),
      permalink: permalink || prev.permalink || "", fetchedAt: now.toISOString(),
      metrics: Object.keys(metrics).length ? metrics : prev.metrics || {}
    };
  }
  // Keep six months of history.
  const keepFrom = day(now, 183);
  for (const [k, p] of Object.entries(perf.posts)) if (p.date < keepFrom) delete perf.posts[k];
  const issueLines = summarizeIssues(issues);
  perf.updatedAt = now.toISOString();
  perf.issues = issueLines;
  fs.writeFileSync(P("performance.json"), JSON.stringify(perf, null, 1) + "\n");

  const all = Object.values(perf.posts);
  const posts7 = all.filter((p) => p.date >= cutoff7), posts28 = all.filter((p) => p.date >= cutoff28);
  const weights = computeWeights(all, { now, days: 28 });
  fs.writeFileSync(P("weights.json"), JSON.stringify(weights, null, 1) + "\n");

  // Keep the old log fields (plays/reach) for anything that reads them.
  for (const a of log.attempts || []) {
    const p = a.postId && perf.posts[perfKey(a)];
    if (p && a.date >= cutoff7 && p.metrics) {
      if (p.metrics.views != null) a.plays = p.metrics.views;
      if (p.metrics.reach != null) a.reach = p.metrics.reach;
    }
  }
  fs.writeFileSync(P("log.json"), JSON.stringify(log, null, 1) + "\n");

  // ---- Existing summary (unchanged in spirit) ----
  const enriched = rows.map((a) => ({ ...a, ...(a.postId && perf.posts[perfKey(a)] ? { plays: perf.posts[perfKey(a)].metrics.views, reach: perf.posts[perfKey(a)].metrics.reach, permalink: perf.posts[perfKey(a)].permalink } : {}) }));
  // Two consecutive weeks under half the average views is a flag.
  const byTemplate = {};
  for (const a of enriched) if (a.type === "reel" && a.plays) (byTemplate[a.template] = byTemplate[a.template] || []).push(a.plays);
  const allPlays = Object.values(byTemplate).flat();
  const avg = allPlays.length ? allPlays.reduce((x, y) => x + y, 0) / allPlays.length : 0;
  const weak = Object.entries(byTemplate).filter(([, v]) => v.length >= 2 && v.reduce((x, y) => x + y, 0) / v.length < avg / 2).map(([k]) => k);

  const lines = enriched.map((a) => `- ${a.date} ${a.platform} ${a.type}: ${a.status}${a.permalink ? ` — ${a.permalink}` : a.link ? ` — ${a.link}` : ""}${a.plays ? ` — ${a.plays} views` : ""}${a.reach ? `, ${a.reach} reach` : ""}${a.error ? ` — ${String(a.error).slice(0, 160)}` : ""}`);
  const last14 = [...new Set((log.attempts || []).map((a) => a.date))].sort().slice(-14);
  const downloads = last14.map((d) => `- ${d}: ${runUrl || "workflow artifacts"} (reel-${d})`);

  const trends = fs.existsSync(P("trends.json")) ? readJson(P("trends.json"), null) : null;
  const perfSec = performanceSection({ posts7, posts28, issues: issueLines, weights, trends });

  const subject = `SendFair social, week ending ${now.toISOString().slice(0, 10)}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const body = perfSec.html
    + `<p>Posts in the last 7 days:</p><ul>${lines.map((l) => `<li>${esc(l.replace(/^- /, ""))}</li>`).join("") || "<li>No posts.</li>"}</ul>`
    + (weak.length ? `<p><strong>Templates under half the average for two weeks:</strong> ${esc(weak.join(", "))}</p>` : "")
    + `<p>Download the last 14 days' Reels (MP4, cover, captions) from the workflow artifacts:</p><ul>${downloads.map((l) => `<li>${esc(l.replace(/^- /, ""))}</li>`).join("")}</ul>`
    + `<p>SendFair, sendfair.africa</p>`;
  const text = `${subject}\n${perfSec.text}\nPosts in the last 7 days:\n${lines.join("\n") || "No posts."}\n\n${weak.length ? `Under half the average: ${weak.join(", ")}\n` : ""}${downloads.join("\n")}`;

  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## ${subject}\n\n${text}\n`);
  say(text);

  // This is an internal report for the owner, never a newsletter. It is saved as a Buttondown DRAFT
  // (drafts never go to subscribers) and, if SOCIAL_REPORT_EMAIL is set, a preview copy is sent to that
  // address only (send-draft delivers to the listed recipients, not the list).
  let delivered = false;
  if (send) {
    const key = env.BUTTONDOWN_API_KEY, to = (env.SOCIAL_REPORT_EMAIL || "").trim();
    if (key) {
      try {
        const H = { Authorization: `Token ${key}`, "content-type": "application/json" };
        const res = await fetchImpl("https://api.buttondown.com/v1/emails", { method: "POST", headers: H, body: JSON.stringify({ subject: `[Internal] ${subject}`, body, status: "draft" }) });
        const draft = await res.json().catch(() => ({}));
        say(`Buttondown draft: ${res.status} ${draft.id || JSON.stringify(draft).slice(0, 200)}`);
        if (res.ok && draft.id) delivered = true;
        if (res.ok && draft.id && to) {
          const s = await fetchImpl(`https://api.buttondown.com/v1/emails/${draft.id}/send-draft`, { method: "POST", headers: H, body: JSON.stringify({ recipients: [to] }) });
          say(`Preview sent to the owner only: ${s.status} ${(await s.text()).slice(0, 120)}`);
        }
      } catch (e) { say(`Buttondown failed: ${e.message || e}`); }
    }
    if (!delivered) {
      const r = await notifyOwner({ subject, text }, { env, fetchImpl });
      say(`Owner email: ${JSON.stringify(r)}`);
      delivered = !!r.sent;
    }
  }
  return { perf, weights, text, html: body, issues: issueLines, delivered, posts7, posts28 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
