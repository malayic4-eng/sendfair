// Posts the day's generated content to a Facebook Page using the Graph API.
// Requires environment variables (set as GitHub secrets):
//   FB_PAGE_ID    - the numeric Page ID
//   FB_PAGE_TOKEN - a Page access token with pages_manage_posts
// Optional: FB_GRAPH_VERSION (defaults to v22.0).
// If the secrets are missing it exits 0 (does nothing) so the workflow is safe before setup.
import fs from "node:fs";

const pageId = process.env.FB_PAGE_ID;
const token = process.env.FB_PAGE_TOKEN;
const version = process.env.FB_GRAPH_VERSION || "v22.0";

if (!pageId || !token) {
  console.log("Facebook secrets not set yet (FB_PAGE_ID / FB_PAGE_TOKEN). Skipping.");
  process.exit(0);
}

const q = JSON.parse(fs.readFileSync("data/social/queue.json", "utf8"));
const posts = q.posts || [];
if (!posts.length) {
  console.log("No posts in today's queue.");
  process.exit(0);
}

let resolvedPageToken = null;
async function resolvePageToken() {
  if (resolvedPageToken) return resolvedPageToken;
  try {
    const res = await fetch(`https://graph.facebook.com/${version}/me/accounts?access_token=${token}`);
    const data = await res.json();
    const page = (data.data || []).find((p) => String(p.id) === String(pageId));
    if (page && page.access_token) {
      resolvedPageToken = page.access_token;
      return resolvedPageToken;
    }
    console.error("Page not found in /me/accounts; falling back to the provided token.");
  } catch (e) {
    console.error("Page-token lookup failed:", e.message);
  }
  resolvedPageToken = token;
  return resolvedPageToken;
}

async function postOne(p) {
  const pageToken = await resolvePageToken();
  // Text without the URL, plus `link` so Facebook shows a preview card (title, image) for the page.
  // utm_* tags let analytics show how many visits each kind of post brings.
  const campaign = String(p.kind || "post").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const link = p.link ? `${p.link}${p.link.includes("?") ? "&" : "?"}utm_source=facebook&utm_medium=social&utm_campaign=${campaign}` : "";
  const message = [p.text || p.long, p.text && link ? "Compare your own amount:" : "", p.tags].filter(Boolean).join("\n\n");
  const body = new URLSearchParams({ message, access_token: pageToken });
  if (link) body.set("link", link);
  const res = await fetch(`https://graph.facebook.com/${version}/${pageId}/feed`, { method: "POST", body });
  const data = await res.json();
  if (!res.ok || data.error) {
    console.error(`Failed (${p.kind}):`, JSON.stringify(data.error || data));
    return false;
  }
  console.log(`Posted (${p.kind}): ${data.id}`);
  return true;
}

let ok = true;
for (const p of posts) {
  if (!(await postOne(p))) ok = false;
  await new Promise((r) => setTimeout(r, 1500));
}
if (!ok) process.exitCode = 1;
