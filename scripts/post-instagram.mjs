// Posts the day's content to the Instagram Business account linked to the Facebook Page.
// Reuses FB_PAGE_ID / FB_PAGE_TOKEN (a Page or System-user token with instagram_basic +
// instagram_content_publish). Instagram requires an image, so each post uses the branded
// square card at https://sendfair.africa/social-card.jpg and the caption carries the data.
import fs from "node:fs";

const pageId = process.env.FB_PAGE_ID;
const token = process.env.FB_PAGE_TOKEN;
const version = process.env.FB_GRAPH_VERSION || "v22.0";
const cardUrl = "https://sendfair.africa/social-card.jpg";

if (!pageId || !token) {
  console.log("Secrets missing; skipping Instagram.");
  process.exit(0);
}

const q = JSON.parse(fs.readFileSync("data/social/queue.json", "utf8"));
const posts = q.posts || [];
if (!posts.length) {
  console.log("No posts in today's queue.");
  process.exit(0);
}

async function resolvePageToken() {
  try {
    const res = await fetch(`https://graph.facebook.com/${version}/me/accounts?access_token=${token}`);
    const data = await res.json();
    const page = (data.data || []).find((p) => String(p.id) === String(pageId));
    if (page && page.access_token) return page.access_token;
  } catch (e) {
    console.error("Page-token lookup failed:", e.message);
  }
  return token;
}

async function resolveIgId(pt) {
  const res = await fetch(`https://graph.facebook.com/${version}/${pageId}?fields=instagram_business_account&access_token=${pt}`);
  const data = await res.json();
  if (data.instagram_business_account && data.instagram_business_account.id) return data.instagram_business_account.id;
  if (process.env.IG_USER_ID) return process.env.IG_USER_ID;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function publishMedia(igId, pt, creationId, kind) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(`https://graph.facebook.com/${version}/${igId}/media_publish`, {
      method: "POST",
      body: new URLSearchParams({ creation_id: creationId, access_token: pt }),
    });
    const data = await res.json();
    if (res.ok && data.id) {
      console.log(`Instagram posted (${kind}): ${data.id}`);
      return true;
    }
    if (data.error && data.error.code === 9007) {
      console.log(`Media not ready (${kind}), retry ${attempt}/6 in 6s...`);
      await sleep(6000);
      continue;
    }
    console.error(`Publish failed (${kind}):`, JSON.stringify(data.error || data));
    return false;
  }
  console.error(`Publish gave up (${kind}) after retries.`);
  return false;
}

async function postOne(igId, pt, p) {
  const caption = (p.long || "").replace(/https?:\/\/sendfair\.africa\/[^\s]*/, "Link in bio: sendfair.africa");
  const text = [caption, p.tags].filter(Boolean).join("\n\n");
  const cRes = await fetch(`https://graph.facebook.com/${version}/${igId}/media`, {
    method: "POST",
    body: new URLSearchParams({ image_url: cardUrl, caption: text, access_token: pt }),
  });
  const cData = await cRes.json();
  if (!cRes.ok || cData.error) {
    console.error(`Container failed (${p.kind}):`, JSON.stringify(cData.error || cData));
    return false;
  }
  await sleep(5000);
  return await publishMedia(igId, pt, cData.id, p.kind);
}

const pt = await resolvePageToken();
const igId = await resolveIgId(pt);
if (!igId) {
  console.error("No Instagram Business account found for this Page. Is Instagram linked to the Page?");
  process.exit(1);
}

let ok = true;
for (const p of posts) {
  if (!(await postOne(igId, pt, p))) ok = false;
  await new Promise((r) => setTimeout(r, 1500));
}
if (!ok) process.exitCode = 1;
