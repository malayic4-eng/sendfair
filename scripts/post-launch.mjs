// Posts the 8-post launch campaign (data/launch-posts.json) to Facebook and Instagram.
// Facebook: POST /{page-id}/photos (image URL + caption).
// Instagram: media container -> publish (image URL + caption), with retry until ready.
// Reuses FB_PAGE_ID / FB_PAGE_TOKEN (Page or System-user token with pages + instagram permissions).
import fs from "node:fs";

const pageId = process.env.FB_PAGE_ID;
const token = process.env.FB_PAGE_TOKEN;
const version = process.env.FB_GRAPH_VERSION || "v22.0";
const base = "https://sendfair.africa/social/launch/";

if (!pageId || !token) {
  console.log("Secrets missing; skipping.");
  process.exit(0);
}

const posts = JSON.parse(fs.readFileSync("data/launch-posts.json", "utf8")).posts;
if (!posts.length) {
  console.log("No launch posts found.");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function postFacebook(pt, p) {
  const body = new URLSearchParams({ url: base + p.image, message: p.caption + "\n\n" + p.tags, access_token: pt });
  const res = await fetch(`https://graph.facebook.com/${version}/${pageId}/photos`, { method: "POST", body });
  const data = await res.json();
  if (!res.ok || data.error) {
    console.error(`FB failed (${p.image}):`, JSON.stringify(data.error || data));
    return false;
  }
  console.log(`FB posted (${p.image}): ${data.post_id || data.id}`);
  return true;
}

async function publishInstagram(igId, pt, creationId, image) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(`https://graph.facebook.com/${version}/${igId}/media_publish`, {
      method: "POST",
      body: new URLSearchParams({ creation_id: creationId, access_token: pt }),
    });
    const data = await res.json();
    if (res.ok && data.id) {
      console.log(`IG posted (${image}): ${data.id}`);
      return true;
    }
    if (data.error && data.error.code === 9007) {
      await sleep(6000);
      continue;
    }
    console.error(`IG publish failed (${image}):`, JSON.stringify(data.error || data));
    return false;
  }
  console.error(`IG publish gave up (${image}).`);
  return false;
}

async function postInstagram(igId, pt, p) {
  const caption = p.caption + "\n\n" + p.tags;
  const cRes = await fetch(`https://graph.facebook.com/${version}/${igId}/media`, {
    method: "POST",
    body: new URLSearchParams({ image_url: base + p.image, caption, access_token: pt }),
  });
  const cData = await cRes.json();
  if (!cRes.ok || cData.error) {
    console.error(`IG container failed (${p.image}):`, JSON.stringify(cData.error || cData));
    return false;
  }
  await sleep(5000);
  return await publishInstagram(igId, pt, cData.id, p.image);
}

const pt = await resolvePageToken();
const igId = await resolveIgId(pt);

let ok = true;
for (const p of posts) {
  if (!(await postFacebook(pt, p))) ok = false;
  if (igId && !(await postInstagram(igId, pt, p))) ok = false;
  await sleep(75000); // ~75s between posts to stay gentle with the platforms
}
if (!ok) process.exitCode = 1;
