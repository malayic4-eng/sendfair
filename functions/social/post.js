// Posts today's Reel to TikTok and YouTube Shorts from the Worker (cron or the admin "Post now" button).
// The video is streamed from the public R2 bucket straight into the upload request: the Worker never
// decodes or buffers it, so CPU time stays tiny (network waiting is not counted on the free plan).
import { accessToken } from "./oauth.js";
import {
  nairobiDate, getPosted, putPosted, getSettings, getTokens, putTokens, putJSON,
  cleanError, LABEL, PLATFORMS, MAX_AUTO_ATTEMPTS, STALE_MS
} from "./store.js";

export const SOCIAL_CRON = "*/20 17-21 * * *";
const TT = "https://open.tiktokapis.com";
const MAX_SINGLE_CHUNK = 64 * 1024 * 1024;
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

// Pass the R2 response body through with a fixed length so the upload carries Content-Length
// (TikTok and Google both need it). FixedLengthStream only exists on Cloudflare; tests pass the body as is.
function streamBody(res, size) {
  if (typeof FixedLengthStream === "function" && res.body) {
    const { readable, writable } = new FixedLengthStream(size);
    res.body.pipeTo(writable).catch(() => {});
    return readable;
  }
  return res.body;
}

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

async function fetchVideo(base, date, fetchImpl) {
  const res = await fetchImpl(`${base}/social/${date}/reel.mp4`);
  if (!res.ok) throw new Error(`The Reel video for ${date} could not be downloaded (${res.status}).`);
  const size = Number(res.headers.get("content-length") || 0);
  if (!size) throw new Error("The Reel video has no size (Content-Length missing).");
  if (size > MAX_SINGLE_CHUNK) throw new Error(`The Reel is ${Math.round(size / 1048576)} MB; over the 64 MB single-upload limit.`);
  return { res, size };
}

const runes = (s, n) => Array.from(String(s || "")).slice(0, n).join("");

async function postTikTok(env, ctx) {
  const { token, manifest, base, date, fetchImpl, sleep } = ctx;
  const kv = env.SENDFAIR_KV;
  const api = async (path, body) => {
    const res = await fetchImpl(TT + path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body) });
    const j = await readJson(res);
    const code = j.error && j.error.code;
    if (!res.ok || (code && code !== "ok")) {
      const msg = (j.error && j.error.message) || `HTTP ${res.status}`;
      const hint = code === "unaudited_client_can_only_post_to_private_accounts"
        ? " Until TikTok audits the app, the TikTok account itself must be set to Private (TikTok app → Settings and privacy → Privacy → Private account)."
        : "";
      throw new Error(`TikTok ${path.split("/").slice(-2, -1)[0]}: ${code || "error"} – ${msg}.${hint}`);
    }
    return j.data || {};
  };

  const creator = await api("/v2/post/publish/creator_info/query/", {});
  const options = Array.isArray(creator.privacy_level_options) ? creator.privacy_level_options : [];
  const privacy = options.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : options[0];
  if (!privacy) throw new Error("TikTok did not offer any privacy option for this account.");
  const audited = privacy === "PUBLIC_TO_EVERYONE";
  await putJSON(kv, "social:info:tiktok", { privacy, options, audited, username: creator.creator_username || "", at: Date.now() });
  if (creator.creator_nickname || creator.creator_username) {
    const tok = await getTokens(kv, "tiktok");
    const name = creator.creator_nickname || creator.creator_username;
    if (tok && tok.name !== name) { tok.name = name; await putTokens(kv, "tiktok", tok); }
  }

  const { res: video, size } = await fetchVideo(base, date, fetchImpl);
  const caption = typeof manifest.captions.tiktok === "string" ? manifest.captions.tiktok : (manifest.captions.tiktok && manifest.captions.tiktok.caption) || "";
  const init = await api("/v2/post/publish/video/init/", {
    post_info: {
      title: runes(caption, 2200), privacy_level: privacy,
      disable_comment: !!creator.comment_disabled, disable_duet: !!creator.duet_disabled, disable_stitch: !!creator.stitch_disabled,
      brand_content_toggle: false, brand_organic_toggle: false
    },
    // One chunk holding the whole file: allowed for any file up to 64 MB (and required under 5 MB).
    source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 }
  });
  if (!init.publish_id || !init.upload_url) throw new Error("TikTok did not return an upload address.");
  const put = await fetchImpl(init.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(size), "Content-Range": `bytes 0-${size - 1}/${size}` },
    body: streamBody(video, size)
  });
  if (put.status !== 201 && !put.ok) throw new Error(`TikTok rejected the video upload (HTTP ${put.status}).`);

  let status = "PROCESSING_UPLOAD", postId = "";
  for (let i = 0; i < 5; i++) {
    await sleep(i === 0 ? 3000 : 6000);
    const s = await api("/v2/post/publish/status/fetch/", { publish_id: init.publish_id });
    status = s.status || status;
    if (status === "FAILED") throw new Error(`TikTok could not publish the video: ${s.fail_reason || "unknown reason"}.`);
    if (status === "PUBLISH_COMPLETE") {
      postId = (s.publicaly_available_post_id || s.publicly_available_post_id || [])[0] || "";
      break;
    }
  }
  return {
    id: init.publish_id, postId: postId ? String(postId) : "", privacy, processing: status !== "PUBLISH_COMPLETE",
    note: audited ? "" : `Posted as ${privacy}: TikTok app not audited yet, so posts are private until TikTok approves your app.`
  };
}

const ytClean = (s, n) => Array.from(String(s || "").replace(/[<>]/g, "")).slice(0, n).join("");

async function postYouTube(env, ctx) {
  const { token, manifest, base, date, fetchImpl } = ctx;
  const kv = env.SENDFAIR_KV;
  const cap = manifest.captions.youtube || {};
  let title = ytClean(cap.title, 100).trim();
  if (!title) title = "Cheapest way to send money home today #Shorts";
  const tags = Array.isArray(cap.tags) ? cap.tags.slice(0, 15) : ["SendFair", "remittance", "send money", "Africa", "Shorts"];
  const { res: video, size } = await fetchVideo(base, date, fetchImpl);
  const start = await fetchImpl("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(size) },
    body: JSON.stringify({
      snippet: { title, description: ytClean(cap.description, 4900), categoryId: "22", tags },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false }
    })
  });
  const location = start.headers.get("location");
  if (!start.ok || !location) {
    const j = await readJson(start);
    const e = j.error || {};
    const reason = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || "";
    throw new Error(`YouTube refused to start the upload (HTTP ${start.status}${reason ? ", " + reason : ""}): ${e.message || "no details"}`);
  }
  const put = await fetchImpl(location, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(size) }, body: streamBody(video, size) });
  const j = await readJson(put);
  if (!put.ok || !j.id) throw new Error(`YouTube upload failed (HTTP ${put.status}): ${(j.error && j.error.message) || "no details"}`);
  const channel = j.snippet && j.snippet.channelTitle;
  if (channel) {
    const tok = await getTokens(kv, "youtube");
    if (tok && tok.name !== channel) { tok.name = channel; await putTokens(kv, "youtube", tok); }
  }
  const privacy = (j.status && j.status.privacyStatus) || "public";
  return {
    id: j.id, url: `https://youtube.com/shorts/${j.id}`, privacy,
    note: privacy === "public" ? "" : `YouTube set the video to ${privacy}. Unverified Google Cloud projects may only upload private videos until the project passes YouTube's API audit.`
  };
}

// Runs one platform for today's Nairobi date. Returns {status, message}; status is one of
// posted | failed | skipped. Never throws.
export async function postPlatform(env, p, { manual = false, base, now = Date.now(), fetchImpl = fetch, sleep = sleepDefault } = {}) {
  const kv = env.SENDFAIR_KV;
  if (!kv) return { status: "skipped", message: "Storage (SENDFAIR_KV) is not connected." };
  if (!PLATFORMS.includes(p)) return { status: "skipped", message: "Unknown platform." };
  const date = nairobiDate(now);
  const rec = await getPosted(kv, p, date);
  if (rec && rec.status === "posted") return { status: "skipped", message: `Already posted to ${LABEL[p]} today (${date}).` };
  if (rec && rec.status === "in-progress") {
    if (now - rec.startedAt < STALE_MS) return { status: "skipped", message: `A ${LABEL[p]} upload for ${date} is already running.` };
    if (!manual) {
      // A run that died mid-upload may or may not have posted. Don't risk a duplicate: stop retrying automatically.
      await putPosted(kv, p, date, { ...rec, status: "failed", interrupted: true, error: "The upload was interrupted. Check the account; if the video is missing, press \"Post today's Reel now\".", failedAt: now });
      return { status: "skipped", message: "Previous upload was interrupted; not retrying automatically." };
    }
  }
  if (!manual && rec && rec.status === "failed" && (rec.interrupted || (rec.attempts || 0) >= MAX_AUTO_ATTEMPTS)) {
    return { status: "skipped", message: `Stopped after ${rec.attempts} failed attempts today. Use the manual button.` };
  }

  let manifest;
  try {
    const res = await fetchImpl(`${base}/social/${date}/manifest.json?t=${now}`);
    if (!res.ok) return { status: "skipped", message: `Today's Reel (${date}) is not ready yet.` };
    manifest = await res.json();
  } catch {
    return { status: "skipped", message: `Today's Reel (${date}) is not ready yet.` };
  }
  if (!manifest || !manifest.captions) return { status: "skipped", message: `Today's Reel (${date}) has no captions yet.` };

  let token;
  try {
    token = await accessToken(kv, p, { now, fetchImpl });
  } catch (e) {
    const attempts = ((rec && rec.attempts) || 0) + 1;
    await putPosted(kv, p, date, { status: "failed", attempts, error: cleanError(e), failedAt: now });
    return { status: "failed", message: cleanError(e) };
  }
  if (!token) return { status: "skipped", message: `${LABEL[p]} is not connected.` };

  const attempts = ((rec && rec.attempts) || 0) + 1;
  // Claim the day before any upload starts, so a parallel run can't post twice.
  await putPosted(kv, p, date, { status: "in-progress", attempts, startedAt: now, manual });
  try {
    const out = await (p === "tiktok" ? postTikTok : postYouTube)(env, { token, manifest, base, date, fetchImpl, sleep });
    await putPosted(kv, p, date, { status: "posted", attempts, manual, postedAt: Date.now(), ...out });
    return { status: "posted", message: `Posted to ${LABEL[p]}${out.note ? ". " + out.note : "."}` };
  } catch (e) {
    const error = cleanError(e);
    await putPosted(kv, p, date, { status: "failed", attempts, manual, error, failedAt: Date.now() });
    return { status: "failed", message: error };
  }
}

// Cron entry: each switched-on platform, one after the other. Quiet when the Reel isn't rendered yet.
export async function runSocialCron(env, opts = {}) {
  const out = {};
  if (!env.SENDFAIR_KV) return out;
  const settings = await getSettings(env.SENDFAIR_KV);
  for (const p of PLATFORMS) {
    if (!settings[p]) { out[p] = "off"; continue; }
    const tok = await getTokens(env.SENDFAIR_KV, p);
    if (!tok) { out[p] = "not connected"; continue; }
    const r = await postPlatform(env, p, opts);
    out[p] = r.status === "skipped" ? "skipped: " + r.message : r.status;
  }
  return out;
}
