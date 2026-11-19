// Shared storage helpers for automatic Reel posting to TikTok and YouTube Shorts.
// Everything lives in the SENDFAIR_KV namespace; the owner types the app credentials on /admin/social,
// so no Worker or GitHub secrets are needed.
//
// KV keys:
//   social:cfg:<platform>       app credentials {id, secret} (never shown or logged)
//   social:tok:<platform>       {access, refresh, expiresAt, refreshExpiresAt, name, connectedAt, error}
//   social:settings             {tiktok: bool, youtube: bool}  auto-post switches (missing = on)
//   social:state:<random>       OAuth state {platform, at}, 10-minute expiry
//   social:info:tiktok          what TikTok last allowed {privacy, options, audited, at}
//   social:note:<platform>      last admin action message {msg, ok, at}
//   posted:<platform>:<date>    one record per platform per Nairobi date (idempotency + history)

export const PLATFORMS = ["tiktok", "youtube"];
export const LABEL = { tiktok: "TikTok", youtube: "YouTube" };
export const MAX_AUTO_ATTEMPTS = 3;
export const STALE_MS = 30 * 60 * 1000;
const DAY = 86400;

export async function getJSON(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export function putJSON(kv, key, value, ttl) {
  return kv.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined);
}

// Nairobi is UTC+3 all year (no daylight saving).
export function nairobiDate(now = Date.now()) {
  return new Date(now + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
export function lastDates(n, now = Date.now()) {
  return Array.from({ length: n }, (_, i) => nairobiDate(now - i * DAY * 1000));
}

export const postedKey = (platform, date) => `posted:${platform}:${date}`;
export const getPosted = (kv, platform, date) => getJSON(kv, postedKey(platform, date));
export const putPosted = (kv, platform, date, rec) => putJSON(kv, postedKey(platform, date), { ...rec, date }, 30 * DAY);

export const getCreds = (kv, p) => getJSON(kv, `social:cfg:${p}`);
export const putCreds = (kv, p, creds) => putJSON(kv, `social:cfg:${p}`, creds);
export const getTokens = (kv, p) => getJSON(kv, `social:tok:${p}`);
export const putTokens = (kv, p, tok) => putJSON(kv, `social:tok:${p}`, tok);

export async function getSettings(kv) {
  const s = (await getJSON(kv, "social:settings")) || {};
  return { tiktok: s.tiktok !== false, youtube: s.youtube !== false };
}
export async function setEnabled(kv, p, on) {
  const s = await getSettings(kv);
  s[p] = !!on;
  await putJSON(kv, "social:settings", s);
}

export const setNote = (kv, p, msg, ok) => putJSON(kv, `social:note:${p}`, { msg: String(msg).slice(0, 500), ok: !!ok, at: Date.now() }, 7 * DAY);
export const getNote = (kv, p) => getJSON(kv, `social:note:${p}`);

// Error text for the status page: short, and never containing anything that looks like a token.
export function cleanError(e) {
  const msg = String((e && e.message) || e || "Unknown error");
  return msg.replace(/(Bearer\s+)\S+/gi, "$1…").replace(/[A-Za-z0-9._~+/=-]{60,}/g, "…").slice(0, 400);
}
