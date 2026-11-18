// Publishes the day's Reel to Instagram and the Facebook Page, with TikTok behind a flag.
// Idempotent by (platform, route, date, template): a committed log is the source of truth, so a rerun
// never posts twice. Dry-run renders and logs but calls no publishing API. If the Reel fails, it posts
// the 4:5 image instead and says so in the log.
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
  return start.video_id;
}
// Music from Instagram's own library (Instagram Audio API, Facebook Login). Tries the configured
// searches, then trending; skips very short clips and tracks used in the last 14 posts; picks one
// per day deterministically. Any failure returns null and the reel posts without music.
async function pickIgAudio(igId, pt) {
  if (schedule.igMusic === false) return null;
  const queries = (schedule.igAudioQueries && schedule.igAudioQueries.length ? schedule.igAudioQueries : ["afrobeats", "amapiano", "afropop", "highlife"]).concat([""]);
  const recent = new Set((log.attempts || []).filter((a) => a.audioId).slice(-14).map((a) => a.audioId));
  const day = parseInt(createHash("sha256").update(plan.date).digest("hex").slice(0, 8), 16);
  for (let i = 0; i < queries.length; i++) {
    const q = queries[(day + i) % (queries.length - 1)] ;
    const query = i === queries.length - 1 ? "" : q;
    for (const tk of [token, pt]) {
      try {
        const u = `https://graph.facebook.com/${version}/ig_audio?audio_type=music&user_id=${igId}${query ? "&search_query=" + encodeURIComponent(query) : ""}&access_token=${encodeURIComponent(tk)}`;
        const data = await fetch(u).then((r) => r.json());
        const list = (data.audio || data.data || []).filter((a) => a.audio_id && (a.duration_in_ms || 30000) >= 15000 && !recent.has(String(a.audio_id)));
        if (data.error) { console.log(`[instagram] audio search "${query || "trending"}": ${data.error.message}`); continue; }
        if (list.length) { const a = list[day % Math.min(list.length, 5)]; return { id: String(a.audio_id), title: a.title || "", artist: a.display_artist || "", query: query || "trending" }; }
        break;
      } catch (e) { console.log("[instagram] audio search failed:", e.message); }
    }
  }
  return null;
}
async function igContainer(igId, pt, caption, audio) {
  const body = { media_type: "REELS", video_url: reelUrl, caption, cover_url: coverUrl, share_to_feed: "true", access_token: pt };
  if (audio) body.audio_configuration = JSON.stringify({ audio_id: audio.id, audio_volume: 80, video_volume: 100 });
  return fetch(`https://graph.facebook.com/${version}/${igId}/media`, { method: "POST", body: new URLSearchParams(body) }).then((r) => r.json());
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
async function igImage(igId, pt, caption) {
  const c = await fetch(`https://graph.facebook.com/${version}/${igId}/media`, { method: "POST", body: new URLSearchParams({ image_url: imageUrl, caption, access_token: pt }) }).then((r) => r.json());
  if (!c.id) throw new Error(JSON.stringify(c.error || c));
  await sleep(5000);
  const pub = await fetch(`https://graph.facebook.com/${version}/${igId}/media_publish`, { method: "POST", body: new URLSearchParams({ creation_id: c.id, access_token: pt }) }).then((r) => r.json());
  if (!pub.id) throw new Error(JSON.stringify(pub.error || pub));
  return pub.id;
}
async function fbImage(pt, message) {
  const res = await fetch(`https://graph.facebook.com/${version}/${pageId}/photos`, { method: "POST", body: new URLSearchParams({ url: imageUrl, message, access_token: pt }) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(JSON.stringify(data.error || data));
  return data.id || data.post_id;
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
  const reelCaption = manifest.captions;

  if (DRY) {
    record({ platform: "instagram", type: "reel", status: "dry-run", idem: kIg, link: manifest.captions.instagram.match(/https?:\S+/)?.[0] || "" });
    record({ platform: "facebook", type: "reel", status: "dry-run", idem: kFb, link: manifest.captions.facebook.match(/https?:\S+/)?.[0] || "" });
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

  // Instagram Reel
  if (doneIg) console.log("[instagram] reel already posted today; skipping.");
  else if (igId) {
    try {
      if (!reelUrl) throw new Error("no public REEL_URL");
      const id = await igReel(igId, pt, reelCaption.instagram);
      record({ platform: "instagram", type: "reel", status: "posted", postId: id, idem: kIg, link: reelCaption.instagram.match(/https?:\S+/)?.[0] || "", ...(igAudioUsed ? { audioId: igAudioUsed.id, audio: `${igAudioUsed.title} — ${igAudioUsed.artist}` } : {}) });
    } catch (e) {
      record({ platform: "instagram", type: "reel", status: "failed", idem: kIg, error: String(e.message || e).slice(0, 300) });
      if (imageUrl) { try { const id = await igImage(igId, pt, reelCaption.instagram); record({ platform: "instagram", type: "image", status: "posted", postId: id, idem: idem("instagram-image"), fallback: true }); } catch (e2) { record({ platform: "instagram", type: "image", status: "failed", idem: idem("instagram-image"), fallback: true, error: String(e2.message || e2).slice(0, 300) }); } }
    }
  } else { record({ platform: "instagram", type: "reel", status: "skipped", idem: kIg, error: "no Instagram Business account" }); }

  // Facebook Page Reel
  if (doneFb) console.log("[facebook] reel already posted today; skipping.");
  else try {
    if (!reelUrl) throw new Error("no public REEL_URL");
    const id = await fbReel(pt, reelCaption.facebook);
    record({ platform: "facebook", type: "reel", status: "posted", postId: id, idem: kFb, link: reelCaption.facebook.match(/https?:\S+/)?.[0] || "" });
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

  // TikTok
  if (posted(idem("tiktok"))) console.log("[tiktok] already posted today; skipping.");
  else try {
    const t = await tiktok();
    record({ platform: "tiktok", type: "reel", status: t.status, postId: t.postId || "", idem: idem("tiktok"), error: t.error || "", note: t.note || "" });
  } catch (e) { record({ platform: "tiktok", type: "reel", status: "failed", idem: idem("tiktok"), error: String(e.message || e).slice(0, 300) }); }
}

await main();
