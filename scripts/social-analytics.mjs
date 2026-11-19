// Per-post metrics from the Graph API, aggregation and the weekly report text.
// Used by scripts/social-weekly.mjs; pure apart from the injected Graph client.
import { contentType } from "./social-weights.mjs";

const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : undefined);
const sumObj = (o) => (o && typeof o === "object" ? Object.values(o).reduce((s, v) => s + (Number(v) || 0), 0) : num(o));

// a: a log.json attempt with platform, type, postId. g: graphClient(). Returns { metrics, permalink }.
export async function fetchPostMetrics(g, a) {
  const id = String(a.postId);
  if (a.platform === "instagram") {
    const f = await g.fields(id, ["permalink", "like_count", "comments_count", "media_product_type"], "instagram media");
    const reel = a.type === "reel" || f.media_product_type === "REELS";
    // "plays" was retired in favour of "views"; impressions was retired too. Missing names are skipped.
    let ins = await g.insights(id, "insights", reel ? ["views", "reach", "saved", "shares", "total_interactions"] : ["views", "reach", "saved", "shares"], "instagram insights");
    if (reel && ins.views === undefined) {
      const old = await g.insights(id, "insights", ["plays"], "instagram insights (old plays)");
      if (old.plays !== undefined) ins = { ...ins, views: old.plays };
    }
    return finish({
      views: num(ins.views), reach: num(ins.reach), likes: num(f.like_count), comments: num(f.comments_count),
      shares: num(ins.shares), saves: num(ins.saved)
    }, f.permalink);
  }
  if (a.platform === "facebook") {
    const counts = ["permalink_url", "reactions.summary(total_count).limit(0)", "comments.summary(total_count).limit(0)"];
    if (a.type === "reel") {
      const f = await g.fields(id, counts, "facebook video");
      const ins = await g.insights(id, "video_insights", ["blue_reels_play_count", "fb_reels_total_plays", "post_impressions_unique", "post_video_social_actions"], "facebook reel insights");
      const social = ins.post_video_social_actions || {};
      return finish({
        views: num(ins.blue_reels_play_count) ?? num(ins.fb_reels_total_plays), reach: num(ins.post_impressions_unique),
        likes: summary(f.reactions), comments: summary(f.comments) ?? num(social.COMMENT), shares: num(social.SHARE)
      }, f.permalink_url ? absolute(f.permalink_url) : "");
    }
    // Photos (image and carousel-cover posts): the photo id points at a Page post (page_story_id),
    // which carries shares and the post insights.
    const photo = await g.fields(id, ["page_story_id", "link"], "facebook photo");
    const postId = photo.page_story_id || id;
    const f = await g.fields(postId, [...counts, "shares"], "facebook post");
    // post_impressions* were retired in late 2025 in favour of "views" (post_media_view); try both.
    const ins = await g.insights(postId, "insights", ["post_media_view", "post_impressions_unique", "post_impressions"], "facebook post insights");
    return finish({
      views: num(ins.post_media_view) ?? num(ins.post_impressions), reach: num(ins.post_impressions_unique),
      likes: summary(f.reactions), comments: summary(f.comments), shares: f.shares ? num(f.shares.count) : undefined
    }, f.permalink_url ? absolute(f.permalink_url) : photo.link || "");
  }
  return { metrics: {}, permalink: "" };
}

function summary(edge) { return edge && edge.summary ? num(edge.summary.total_count) : undefined; }
function absolute(u) { return /^https?:/.test(u) ? u : `https://www.facebook.com${u.startsWith("/") ? "" : "/"}${u}`; }
function finish(m, permalink) {
  const metrics = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));
  const eng = ["likes", "comments", "shares", "saves"].reduce((s, k) => s + (metrics[k] || 0), 0);
  if (["likes", "comments", "shares", "saves"].some((k) => k in metrics)) metrics.engagement = eng;
  const base = metrics.reach || metrics.views;
  if (base > 0 && "engagement" in metrics) metrics.er = Math.round((eng / base) * 10000) / 10000;
  return { metrics, permalink: permalink || "" };
}

// Posts that can have metrics: posted, with a post id, on Instagram or Facebook.
export function measurable(attempts, cutoffDate) {
  return (attempts || []).filter((a) => a.status === "posted" && a.postId && (a.platform === "instagram" || a.platform === "facebook") && a.date >= cutoffDate);
}
export const perfKey = (a) => `${a.platform}:${a.postId}`;

// Groups posts by a field and ranks by average views (reach when views are missing).
export function rankBy(posts, field) {
  const groups = {};
  for (const p of posts) {
    const k = p[field] || "unknown";
    const g = (groups[k] = groups[k] || { key: k, posts: 0, measured: 0, views: 0, engagement: 0, base: 0 });
    g.posts++;
    const m = p.metrics || {};
    const v = m.views ?? m.reach;
    if (Number.isFinite(v)) { g.measured++; g.views += v; }
    if (Number.isFinite(m.engagement) && (m.reach || m.views)) { g.engagement += m.engagement; g.base += m.reach || m.views; }
  }
  return Object.values(groups).map((g) => ({
    key: g.key, posts: g.posts, measured: g.measured,
    avgViews: g.measured ? Math.round(g.views / g.measured) : null,
    er: g.base ? Math.round((g.engagement / g.base) * 1000) / 10 : null
  })).sort((a, b) => (b.avgViews ?? -1) - (a.avgViews ?? -1) || (b.er ?? -1) - (a.er ?? -1));
}

export function topPosts(posts, n = 3) {
  return posts.filter((p) => Number.isFinite((p.metrics || {}).views ?? (p.metrics || {}).reach))
    .sort((a, b) => (b.metrics.views ?? b.metrics.reach) - (a.metrics.views ?? a.metrics.reach)).slice(0, n);
}

// One plain-English line from the 28-day ranking. Needs two measured posts in a group to name it.
export function doMoreLine(posts28) {
  const pick = (field) => rankBy(posts28, field).filter((g) => g.measured >= 2 && g.avgViews != null);
  const all = posts28.map((p) => (p.metrics || {}).views ?? (p.metrics || {}).reach).filter(Number.isFinite);
  const avg = all.length ? all.reduce((s, x) => s + x, 0) / all.length : 0;
  const t = pick("template")[0], r = pick("route")[0], pl = pick("platform")[0];
  const types = rankBy(posts28.map((p) => ({ ...p, contentType: contentType(p.template) })), "contentType").filter((g) => g.measured >= 2 && g.avgViews != null);
  if (!t || !(avg > 0)) return "Not enough measured posts yet to say what works best. Keep posting the normal mix; the report will name winners once each template has at least two posts with views.";
  const x = (g) => (g.avgViews / avg).toFixed(1);
  let line = `Do more "${t.key}" posts: they averaged ${t.avgViews.toLocaleString("en")} views, ${x(t)}x the 28-day average.`;
  if (r && r.avgViews > avg) line += ` The strongest route was ${r.key} (${x(r)}x).`;
  if (types.length > 1) line += ` By content type, ${types[0].key} led (${x(types[0])}x)${types[types.length - 1].key !== types[0].key ? `; ${types[types.length - 1].key} trailed (${x(types[types.length - 1])}x) but keeps its share of posts` : ""}.`;
  if (pl) line += ` ${cap(pl.key)} brought the most views per post.`;
  return line;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Trends file written by another process: { items: [...] } or [...], items are strings or objects.
export function formatTrends(trends) {
  const items = Array.isArray(trends) ? trends : (trends && (trends.items || trends.trends)) || [];
  return items.slice(0, 8).map((it) => {
    if (typeof it === "string") return { text: it, url: "" };
    const title = it.title || it.name || it.topic || it.keyword || it.sound || "";
    const why = it.why || it.note || it.summary || it.description || "";
    const url = /^https?:\/\//.test(it.url || it.link || "") ? (it.url || it.link) : "";
    const src = it.source || it.platform || "";
    return { text: [title, why].filter(Boolean).join(": ") + (src ? ` (${src})` : ""), url };
  }).filter((t) => t.text);
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function performanceSection({ posts7, posts28, issues, weights, trends }) {
  const typed = (list) => list.map((p) => ({ ...p, contentType: contentType(p.template) }));
  posts7 = typed(posts7); posts28 = typed(posts28);
  const fmt = (v) => (v == null ? "n/a" : Number(v).toLocaleString("en"));
  const table = (title, rows) => ({ title, rows: rows.map((g) => `${g.key}: ${fmt(g.avgViews)} avg views, ${g.er == null ? "n/a" : g.er + "%"} engagement (${g.measured}/${g.posts} measured)`) });
  const sections = [
    table("By content type: transfers, building, other (28 days)", rankBy(posts28, "contentType")),
    table("By template (28 days)", rankBy(posts28, "template")),
    table("By route (28 days)", rankBy(posts28, "route")),
    table("By platform (7 days)", rankBy(posts7, "platform"))
  ];
  const top = topPosts(posts7).map((p, i) => ({ text: `${i + 1}. ${p.date} ${p.platform} ${p.type} ${p.template} / ${p.route}: ${fmt(p.metrics.views ?? p.metrics.reach)} ${p.metrics.views != null ? "views" : "reach"}${p.metrics.er != null ? `, ${(p.metrics.er * 100).toFixed(1)}% engagement` : ""}`, url: p.permalink || "" }));
  const more = doMoreLine(posts28);
  const w = weights ? Object.entries(weights.templates || {}).filter(([, v]) => v !== 1).map(([k, v]) => `${k} ${v}`) : [];
  if (w.length && weights.typeFloors) w.push(`minimum share: ${Object.entries(weights.typeFloors).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ")}`);
  const trendItems = trends ? formatTrends(trends) : [];

  let text = `\nWhat to do more of: ${more}\n\nTop posts this week:\n${top.map((t) => `${t.text}${t.url ? ` — ${t.url}` : ""}`).join("\n") || "No measured posts yet."}\n`;
  for (const s of sections) text += `\n${s.title}:\n${s.rows.map((r) => `- ${r}`).join("\n") || "- no posts"}\n`;
  if (w.length) text += `\nTemplate weights for the next 4 weeks: ${w.join(", ")} (others 1.0)\n`;
  if (trendItems.length) text += `\nTrending in your niche:\n${trendItems.map((t) => `- ${t.text}${t.url ? ` — ${t.url}` : ""}`).join("\n")}\n`;
  if (issues.length) text += `\nMissing permissions or API errors (metrics may be incomplete):\n${issues.map((i) => `- ${i}`).join("\n")}\n`;

  let html = `<p><strong>What to do more of:</strong> ${esc(more)}</p>`;
  html += `<p><strong>Top posts this week</strong></p><ol>${top.map((t) => `<li>${esc(t.text.replace(/^\d+\.\s*/, ""))}${t.url ? ` — <a href="${esc(t.url)}">open</a>` : ""}</li>`).join("") || "<li>No measured posts yet.</li>"}</ol>`;
  for (const s of sections) html += `<p><strong>${esc(s.title)}</strong></p><ul>${s.rows.map((r) => `<li>${esc(r)}</li>`).join("") || "<li>no posts</li>"}</ul>`;
  if (w.length) html += `<p>Template weights for the next 4 weeks: ${esc(w.join(", "))} (others 1.0).</p>`;
  if (trendItems.length) html += `<p><strong>Trending in your niche</strong></p><ul>${trendItems.map((t) => `<li>${t.url ? `<a href="${esc(t.url)}">${esc(t.text)}</a>` : esc(t.text)}</li>`).join("")}</ul>`;
  if (issues.length) html += `<p><strong>Missing permissions or API errors</strong> (metrics may be incomplete):</p><ul>${issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  return { text, html, more, top };
}
