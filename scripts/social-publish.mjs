// Publishes the day's Reel to Instagram and the Facebook Page, with TikTok behind a flag.
// Idempotent by (platform, route, date, template): a committed log is the source of truth, so a rerun
// never posts twice. Dry-run renders and logs but calls no publishing API. If the Reel fails, it posts
// the 4:5 image instead and says so in the log.
// Links: the Facebook and Instagram text carries no URL (Facebook shows link posts to fewer people;
// Instagram captions can't link). After each post a first comment goes up: on Facebook the tagged
// link and a question, on Instagram a question. A comment that fails is logged and never stops the
// run; a rerun retries only the comment. The Graph API cannot pin a comment.
import fs from "node:fs";
import { createHash } from "node:crypto";

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const plan = read("data/social/plan.json");
const schedule = plan.schedule || read("data/social/schedule.json");
const dir = `data/social/reels/${plan.date}`;
const manifest = read(`${dir}/manifest.json`);
const logPath = "data/social/log.json";
let log = { attempts: [] };
try { log = read(logPath); } catch {}
const DRY = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
const version = process.env.FB_GRAPH_VERSION || "v22.0";
const pageId = process.env.FB_PAGE_ID;
const token = process.env.FB_PAGE_TOKEN;
const reelUrl = process.env.REEL_URL || "";
const coverUrl = process.env.COVER_URL || "";
const imageUrl = process.env.IMAGE_URL || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const links = manifest.links || (plan.reel && plan.reel.links) || {};
const comments = manifest.comments || (plan.reel && plan.reel.comments) || {};
const COMMENT_RETRY_MS = process.env.COMMENT_RETRY_MS != null ? Number(process.env.COMMENT_RETRY_MS) : 20000;
// Safety net for an old manifest: never send a URL in Facebook or Instagram post text.
const URL_RE = /https?:\/\/\S+/g;
const noLinks = (text, platform) => String(text || "").replace(URL_RE, platform === "facebook" ? "link in the first comment 👇" : "link in bio 🔗");
const fbText = (t) => noLinks(t, "facebook");
const igText = (t) => noLinks(t, "instagram");

const idem = (platform) => createHash("sha256").update(`${platform}|${plan.route}|${plan.date}|${plan.template}`).digest("hex").slice(0, 16);
const posted = (k) => (log.attempts || []).some((a) => a.idem === k && a.status === "posted");
function record(a) {
  log.attempts = log.attempts || [];
  log.attempts.push({ at: new Date().toISOString(), date: plan.date, template: plan.template, route: plan.route, ...a });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 1) + "\n");
  console.log(`[${a.platform}] ${a.type}: ${a.status}${a.error ? " — " + a.error : ""}`);
}

async function resolvePageToken() {
  if (!token) return null;
  try {
    const data = await fetch(`https://graph.facebook.com/${version}/me/accounts?access_token=${token}`).then((r) => r.json());
    const page = (data.data || []).find((p) => String(p.id) === String(pageId));
    if (page && page.access_token) return page.access_token;
  } catch (e) { console.error("page token lookup:", e.message); }
  return token;
}
async function resolveIgId(pt) {
  try {
    const data = await fetch(`https://graph.facebook.com/${version}/${pageId}?fields=instagram_business_account&access_token=${pt}`).then((r) => r.json());
    return (data.instagram_business_account && data.instagram_business_account.id) || process.env.IG_USER_ID || null;
  } catch { return process.env.IG_USER_ID || null; }
}

async function fbReel(pt, description) {
  const start = await fetch(`https://graph.facebook.com/${version}/${pageId}/video_reels`, { method: "POST", body: new URLSearchParams({ upload_phase: "start", access_token: pt }) }).then((r) => r.json());
  if (!start.video_id || !start.upload_url) throw new Error(JSON.stringify(start.error || start));
  const buf = fs.readFileSync(`${dir}/reel.mp4`);
  const up = await fetch(start.upload_url, { method: "POST", headers: { Authorization: `OAuth ${pt}`, offset: "0", file_size: String(buf.length), "Content-Type": "application/octet-stream" }, body: buf });
  if (!up.ok) throw new Error("upload " + up.status + " " + (await up.text()).slice(0, 200));
  const fin = await fetch(`https://graph.facebook.com/${version}/${pageId}/video_reels`, { method: "POST", body: new URLSearchParams({ upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED", description, access_token: pt }) }).then((r) => r.json());
  if (fin.error || fin.success === false) throw new Error(JSON.stringify(fin));
  await fbCaptions(start.video_id, pt);
  return start.video_id;
}
// Closed captions (Facebook can't auto-caption reels with no speech). Never fails the post.
async function fbCaptions(videoId, pt) {
  const file = `${dir}/captions.en_US.srt`;
  if (!fs.existsSync(file)) return;
  for (let i = 0; i < 6; i++) {
    try {
      const form = new FormData();
      form.append("captions_file", new Blob([fs.readFileSync(file)], { type: "application/octet-stream" }), "captions.en_US.srt");
      form.append("default_locale", "en_US");
      form.append("access_token", pt);
      const r = await fetch(`https://graph.facebook.com/${version}/${videoId}/captions`, { method: "POST", body: form }).then((x) => x.json());
      if (r.success || r.id) { console.log("[facebook] captions: added"); return; }
      console.log("[facebook] captions:", JSON.stringify(r.error || r).slice(0, 200));
    } catch (e) { console.log("[facebook] captions failed:", e.message); }
    await sleep(20000); // the video may still be processing
  }
}
// Music from Instagram's own library (Instagram Audio API, Facebook Login). Tries the configured
// searches, then trending; skips very short clips and tracks used in the last 14 posts; picks one
// per day deterministically. Any failure returns null and the reel posts without music.
async function pickIgAudio(igId, pt) {
  if (schedule.igMusic === false) return null;
  const genres = schedule.igAudioQueries && schedule.igAudioQueries.length ? schedule.igAudioQueries : ["afrobeats", "amapiano", "afropop", "highlife"];
  const recent = new Set((log.attempts || []).filter((a) => a.audioId).slice(-14).map((a) => a.audioId));
  const day = parseInt(createHash("sha256").update(plan.date).digest("hex").slice(0, 8), 16);
  const rotated = genres.map((_, i) => genres[(day + i) % genres.length]);
  // An empty query returns Instagram's trending audio (Audio API docs). Trending goes first unless
  // igAudioTrendingFirst is false; the genre searches are the fallback.
  const queries = schedule.igAudioTrendingFirst === false ? [...rotated, ""] : ["", ...rotated];
  for (const query of queries) {
    for (const tk of [token, pt]) {
      try {
        const u = `https://graph.facebook.com/${version}/ig_audio?audio_type=music&user_id=${igId}${query ? "&search_query=" + encodeURIComponent(query) : ""}&access_token=${encodeURIComponent(tk)}`;
        const data = await fetch(u).then((r) => r.json());
        if (data.error) { console.log(`[instagram] audio search "${query || "trending"}": ${data.error.message}`); continue; }
        const list = (data.audio || data.data || []).filter((a) => a.audio_id && (a.duration_in_ms || 30000) >= 15000 && !recent.has(String(a.audio_id)));
        if (list.length) { const a = list[day % Math.min(list.length, 5)]; return { id: String(a.audio_id), title: a.title || "", artist: a.display_artist || "", query: query || "trending" }; }
        break;
      } catch (e) { console.log("[instagram] audio search failed:", e.message); }
    }
  }
  return null;
}
// Trial Reels (trial_params, Reels only): shown to non-followers first. SS_PERFORMANCE shares the Reel
// with followers automatically if it performs well; MANUAL waits for you in the app. If Instagram
// refuses trial_params (for example an account not eligible yet), the Reel posts as a normal Reel.
const trialParams = () => schedule.igTrialReels ? JSON.stringify({ graduation_strategy: schedule.igTrialGraduation || "SS_PERFORMANCE" }) : null;
let igTrialUsed = false;
async function igContainer(igId, pt, caption, audio) {
  const make = (trial) => {
    const body = { media_type: "REELS", video_url: reelUrl, caption, cover_url: coverUrl, share_to_feed: "true", access_token: pt };
    if (audio) body.audio_configuration = JSON.stringify({ audio_id: audio.id, audio_volume: 80, video_volume: 100 });
    if (trial) body.trial_params = trial;
    return fetch(`https://graph.facebook.com/${version}/${igId}/media`, { method: "POST", body: new URLSearchParams(body) }).then((r) => r.json());
  };
  const trial = trialParams();
  if (trial) {
    const c = await make(trial);
    if (c.id) { igTrialUsed = true; return c; }
    console.log("[instagram] trial Reel refused, posting as a normal Reel:", JSON.stringify(c.error || c).slice(0, 200));
  }
  igTrialUsed = false;
  return make(null);
}
let igAudioUsed = null;
async function igReel(igId, pt, caption) {
  const audio = await pickIgAudio(igId, pt);
  let c = await igContainer(igId, pt, caption, audio);
  if (!c.id && audio) { console.log("[instagram] reel with music refused, posting without:", JSON.stringify(c.error || c).slice(0, 200)); c = await igContainer(igId, pt, caption, null); }
  else if (audio) { igAudioUsed = audio; console.log(`[instagram] music: ${audio.title} — ${audio.artist} (${audio.query})`); }
  if (!c.id) throw new Error(JSON.stringify(c.error || c));
  const wait = async (id) => {
    for (let i = 0; i < 36; i++) {
      const st = await fetch(`https://graph.facebook.com/${version}/${id}?fields=status_code,status&access_token=${pt}`).then((r) => r.json());
      if (st.status_code === "FINISHED") return null;
      if (st.status_code === "ERROR") return st;
      await sleep(5000);
    }
    return null;
  };
  let err = await wait(c.id);
  if (err && igAudioUsed) {
    // Processing with music failed: post the same reel without music rather than falling back to the image.
    console.log("[instagram] processing with music failed, retrying without:", JSON.stringify(err).slice(0, 200));
    igAudioUsed = null;
    c = await igContainer(igId, pt, caption, null);
    if (!c.id) throw new Error(JSON.stringify(c.error || c));
    err = await wait(c.id);
  }
  if (err) throw new Error(JSON.stringify(err));
  const pub = await fetch(`https://graph.facebook.com/${version}/${igId}/media_publish`, { method: "POST", body: new URLSearchParams({ creation_id: c.id, access_token: pt }) }).then((r) => r.json());
  if (!pub.id) throw new Error(JSON.stringify(pub.error || pub));
  return pub.id;
}
async function igImage(igId, pt, caption, url = imageUrl) {
  const c = await fetch(`https://graph.facebook.com/${version}/${igId}/media`, { method: "POST", body: new URLSearchParams({ image_url: url, caption, access_token: pt }) }).then((r) => r.json());
  if (!c.id) throw new Error(JSON.stringify(c.error || c));
  await sleep(5000);
  const pub = await fetch(`https://graph.facebook.com/${version}/${igId}/media_publish`, { method: "POST", body: new URLSearchParams({ creation_id: c.id, access_token: pt }) }).then((r) => r.json());
  if (!pub.id) throw new Error(JSON.stringify(pub.error || pub));
  return pub.id;
}
async function fbImage(pt, message, url = imageUrl) {
  const res = await fetch(`https://graph.facebook.com/${version}/${pageId}/photos`, { method: "POST", body: new URLSearchParams({ url, message, access_token: pt }) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(JSON.stringify(data.error || data));
  return data.id || data.post_id;
}

// Instagram carousel (feed post, 2–10 slides): one child container per slide with is_carousel_item,
// then a CAROUSEL parent that lists the children, then publish. Counts as one post toward the 50/day limit.
async function waitFinished(id, pt) {
  for (let i = 0; i < 36; i++) {
    const st = await fetch(`https://graph.facebook.com/${version}/${id}?fields=status_code,status&access_token=${pt}`).then((r) => r.json());
    if (st.status_code === "FINISHED") return;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error(JSON.stringify(st));
    await sleep(5000);
  }
  throw new Error("container not finished: " + id);
}
async function igCarousel(igId, pt, caption, urls) {
  if (urls.length < 2 || urls.length > 10) throw new Error(`carousel needs 2–10 slides, got ${urls.length}`);
  const children = [];
  for (const url of urls) {
    const c = await fetch(`https://graph.facebook.com/${version}/${igId}/media`, { method: "POST", body: new URLSearchParams({ image_url: url, is_carousel_item: "true", access_token: pt }) }).then((r) => r.json());
    if (!c.id) throw new Error(JSON.stringify(c.error || c));
    children.push(c.id);
  }
  for (const id of children) await waitFinished(id, pt);
  const parent = await fetch(`https://graph.facebook.com/${version}/${igId}/media`, { method: "POST", body: new URLSearchParams({ media_type: "CAROUSEL", children: children.join(","), caption, access_token: pt }) }).then((r) => r.json());
  if (!parent.id) throw new Error(JSON.stringify(parent.error || parent));
  await waitFinished(parent.id, pt);
  const pub = await fetch(`https://graph.facebook.com/${version}/${igId}/media_publish`, { method: "POST", body: new URLSearchParams({ creation_id: parent.id, access_token: pt }) }).then((r) => r.json());
  if (!pub.id) throw new Error(JSON.stringify(pub.error || pub));
  return pub.id;
}
// Carousel days: slides go to Instagram as a carousel and to Facebook as the cover photo. The Reel is
// not posted to Instagram or Facebook on those days (the mix is set in schedule.json).
const carouselUrls = () => (manifest.carousel && manifest.carousel.slides ? manifest.carousel.slides.map((f) => `${process.env.R2_PUBLIC_BASE}/social/${plan.date}/${f}`) : []);
async function postCarouselDay(igId, pt) {
  const kIg = idem("instagram-carousel");
  const urls = carouselUrls();
  if (posted(kIg)) console.log("[instagram] carousel already posted today; skipping.");
  else if (igId) {
    try {
      if (!process.env.R2_PUBLIC_BASE) throw new Error("no public R2_PUBLIC_BASE");
      const id = await igCarousel(igId, pt, igText(plan.carousel.captions.instagram), urls);
      record({ platform: "instagram", type: "carousel", status: "posted", postId: id, idem: kIg, slides: urls.length, link: links.instagram || "" });
    } catch (e) {
      record({ platform: "instagram", type: "carousel", status: "failed", idem: kIg, error: String(e.message || e).slice(0, 300) });
      // Fallback: the cover slide as a single image, recorded as such.
      if (urls[0]) { try { const id = await igImage(igId, pt, igText(plan.carousel.captions.instagram), urls[0]); record({ platform: "instagram", type: "image", status: "posted", postId: id, idem: idem("instagram-carousel-cover"), fallback: true }); } catch (e2) { record({ platform: "instagram", type: "image", status: "failed", idem: idem("instagram-carousel-cover"), fallback: true, error: String(e2.message || e2).slice(0, 300) }); } }
    }
  } else record({ platform: "instagram", type: "carousel", status: "skipped", idem: kIg, error: "no Instagram Business account" });
}
async function postCarouselFb(pt) {
  const kFb = idem("facebook-carousel");
  if (posted(kFb)) { console.log("[facebook] carousel cover already posted today; skipping."); return; }
  try {
    if (!urls0()) throw new Error("no public R2_PUBLIC_BASE");
    const id = await fbImage(pt, fbText(plan.carousel.captions.facebook), urls0());
    record({ platform: "facebook", type: "carousel", status: "posted", postId: id, idem: kFb, note: "cover slide as a photo" });
  } catch (e) { record({ platform: "facebook", type: "carousel", status: "failed", idem: kFb, error: String(e.message || e).slice(0, 300) }); }
}
const urls0 = () => carouselUrls()[0] || "";

// First comment under each of today's posts on a platform (Reel, carousel, or an image, including
// a fallback). Keyed by the post, so a rerun comments only where today's comment is still missing.
// Facebook: POST /{video-or-photo-id}/comments with the Page token (needs pages_manage_engagement).
// Instagram: POST /{ig-media-id}/comments (needs instagram_manage_comments).
async function graphComment(objectId, pt, message) {
  const res = await fetch(`https://graph.facebook.com/${version}/${objectId}/comments`, { method: "POST", body: new URLSearchParams({ message, access_token: pt }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.id) throw new Error(JSON.stringify(data.error || data).slice(0, 300));
  return data.id;
}
const commentIdem = (a) => createHash("sha256").update(`comment|${a.platform}|${a.idem}|${a.postId}`).digest("hex").slice(0, 16);
async function firstComments(platform, pt) {
  const message = comments[platform];
  if (!message) return;
  const targets = (log.attempts || []).filter((a) => a.date === plan.date && a.platform === platform && a.status === "posted" && ["reel", "carousel", "image"].includes(a.type) && a.postId);
  for (const a of targets) {
    const k = commentIdem(a);
    if (posted(k)) continue;
    let lastErr = null;
    // A Reel can still be processing just after it publishes; try a few times before giving up.
    for (let i = 0; i < 3; i++) {
      try {
        const id = await graphComment(a.postId, pt, message);
        record({ platform, type: "comment", status: "posted", postId: id, on: a.postId, onType: a.type, idem: k, link: platform === "facebook" ? links.facebook || "" : "" });
        lastErr = null;
        break;
      } catch (e) { lastErr = e; if (i < 2) await sleep(COMMENT_RETRY_MS); }
    }
    if (lastErr) record({ platform, type: "comment", status: "failed", on: a.postId, onType: a.type, idem: k, error: String(lastErr.message || lastErr).slice(0, 300) });
  }
}

async function tiktok() {
  const file = `${dir}/reel.mp4`;
  if (!schedule.tiktok || !process.env.TIKTOK_ACCESS_TOKEN) return { status: "manual", note: "TikTok flag off or no token; files saved in data/social/tiktok/" };
  if (!fs.existsSync(file)) return { status: "skipped", note: "no MP4" };
  const size = fs.statSync(file).size;
  const init = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TIKTOK_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ post_info: { title: manifest.captions.tiktok, privacy_level: "PUBLIC_TO_EVERYONE", disable_comment: false }, source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 } })
  }).then((r) => r.json());
  if (!init.data || !init.data.upload_url) return { status: "failed", error: JSON.stringify(init.error || init) };
  const up = await fetch(init.data.upload_url, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${size - 1}/${size}` }, body: fs.readFileSync(file) });
  if (!up.ok) return { status: "failed", error: "upload " + up.status };
  return { status: "posted", postId: init.data.publish_id };
}

async function main() {
  const kIg = idem("instagram"), kFb = idem("facebook");
  const reelCaption = { ...manifest.captions, instagram: igText(manifest.captions.instagram), facebook: fbText(manifest.captions.facebook) };

  if (DRY) {
    if (plan.carousel) {
      record({ platform: "instagram", type: "carousel", status: "dry-run", idem: idem("instagram-carousel"), slides: ((manifest.carousel || {}).slides || []).length });
      if (schedule.fbReelOnCarouselDays !== false) record({ platform: "facebook", type: "reel", status: "dry-run", idem: kFb, link: links.facebook || "" });
      else record({ platform: "facebook", type: "carousel", status: "dry-run", idem: idem("facebook-carousel"), note: "cover slide as a photo" });
    } else {
      record({ platform: "instagram", type: "reel", status: "dry-run", idem: kIg, trial: !!trialParams(), link: links.instagram || "" });
      record({ platform: "facebook", type: "reel", status: "dry-run", idem: kFb, link: links.facebook || "" });
    }
    if (comments.instagram) record({ platform: "instagram", type: "comment", status: "dry-run", idem: idem("instagram-comment"), message: comments.instagram });
    if (comments.facebook) record({ platform: "facebook", type: "comment", status: "dry-run", idem: idem("facebook-comment"), message: comments.facebook });
    record({ platform: "tiktok", type: "reel", status: "dry-run", idem: idem("tiktok") });
    if (plan.image) record({ platform: "instagram", type: "image", status: "dry-run", idem: idem("instagram-image") });
    return;
  }

  if (!pageId || !token) { console.log("FB_PAGE_ID / FB_PAGE_TOKEN not set; not publishing."); return; }
  const pt = await resolvePageToken();
  const igId = await resolveIgId(pt);
  // Idempotency is per platform: a rerun after a partial failure posts only what is still missing.
  const doneIg = posted(kIg), doneFb = posted(kFb);
  if (doneIg && doneFb) { console.log("Already posted today on Instagram and Facebook (idempotency); skipping."); }
  if (!reelUrl || !coverUrl) { console.error("REEL_URL / COVER_URL are not set; the APIs need a public URL. Falling back."); }

  // Instagram Reel (not on carousel days, which post the carousel instead)
  if (plan.carousel) await postCarouselDay(igId, pt);
  else if (doneIg) console.log("[instagram] reel already posted today; skipping.");
  else if (igId) {
    try {
      if (!reelUrl) throw new Error("no public REEL_URL");
      const id = await igReel(igId, pt, reelCaption.instagram);
      record({ platform: "instagram", type: "reel", status: "posted", postId: id, idem: kIg, trial: igTrialUsed, link: links.instagram || "", ...(igAudioUsed ? { audioId: igAudioUsed.id, audio: `${igAudioUsed.title} — ${igAudioUsed.artist}` } : {}) });
    } catch (e) {
      record({ platform: "instagram", type: "reel", status: "failed", idem: kIg, error: String(e.message || e).slice(0, 300) });
      if (imageUrl) { try { const id = await igImage(igId, pt, reelCaption.instagram); record({ platform: "instagram", type: "image", status: "posted", postId: id, idem: idem("instagram-image"), fallback: true }); } catch (e2) { record({ platform: "instagram", type: "image", status: "failed", idem: idem("instagram-image"), fallback: true, error: String(e2.message || e2).slice(0, 300) }); } }
    }
  } else { record({ platform: "instagram", type: "reel", status: "skipped", idem: kIg, error: "no Instagram Business account" }); }
  await firstComments("instagram", pt).catch((e) => console.log("[instagram] comments:", e.message));

  // FORCE_REEL=1 is a manual Instagram-only test: no Facebook, image or TikTok posts.
  if (process.env.FORCE_REEL === "1") { console.log("FORCE_REEL: Instagram Reel only; skipping Facebook, image and TikTok."); return; }

  // Facebook Page Reel, every day. Reels reach far beyond followers on Facebook; a still photo does not.
  // On carousel days Instagram gets the carousel and Facebook still gets the Reel, unless
  // schedule.fbReelOnCarouselDays is false (then Facebook gets the cover slide as before).
  const fbReelToday = !plan.carousel || schedule.fbReelOnCarouselDays !== false;
  if (!fbReelToday) await postCarouselFb(pt);
  else if (doneFb) console.log("[facebook] reel already posted today; skipping.");
  else try {
    if (!reelUrl) throw new Error("no public REEL_URL");
    const id = await fbReel(pt, reelCaption.facebook);
    record({ platform: "facebook", type: "reel", status: "posted", postId: id, idem: kFb, link: links.facebook || "" });
  } catch (e) {
    record({ platform: "facebook", type: "reel", status: "failed", idem: kFb, error: String(e.message || e).slice(0, 300) });
    if (imageUrl) { try { const id = await fbImage(pt, reelCaption.facebook); record({ platform: "facebook", type: "image", status: "posted", postId: id, idem: idem("facebook-image"), fallback: true }); } catch (e2) { record({ platform: "facebook", type: "image", status: "failed", idem: idem("facebook-image"), fallback: true, error: String(e2.message || e2).slice(0, 300) }); } }
  }

  // Optional image post on the configured weekdays (still within maxPerDay).
  // Image posts go to both Instagram and the Facebook Page on the image days.
  if (plan.image && imageUrl && igId && !posted(idem("instagram-image"))) {
    try { const id = await igImage(igId, pt, reelCaption.instagram); record({ platform: "instagram", type: "image", status: "posted", postId: id, idem: idem("instagram-image") }); } catch (e) { record({ platform: "instagram", type: "image", status: "failed", idem: idem("instagram-image"), error: String(e.message || e).slice(0, 300) }); }
  }
  if (plan.image && imageUrl && !posted(idem("facebook-image"))) {
    try { const id = await fbImage(pt, reelCaption.facebook); record({ platform: "facebook", type: "image", status: "posted", postId: id, idem: idem("facebook-image") }); } catch (e) { record({ platform: "facebook", type: "image", status: "failed", idem: idem("facebook-image"), error: String(e.message || e).slice(0, 300) }); }
  }

  await firstComments("facebook", pt).catch((e) => console.log("[facebook] comments:", e.message));

  // TikTok
  if (posted(idem("tiktok"))) console.log("[tiktok] already posted today; skipping.");
  else try {
    const t = await tiktok();
    record({ platform: "tiktok", type: "reel", status: t.status, postId: t.postId || "", idem: idem("tiktok"), error: t.error || "", note: t.note || "" });
  } catch (e) { record({ platform: "tiktok", type: "reel", status: "failed", idem: idem("tiktok"), error: String(e.message || e).slice(0, 300) }); }
}

await main();
