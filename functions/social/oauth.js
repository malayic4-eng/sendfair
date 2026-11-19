// OAuth for TikTok (Login Kit for Web, v2) and Google (YouTube Data API v3): start, callback, refresh.
// TikTok web login does not use PKCE (code_verifier is only for its desktop and mobile SDKs), so the
// state value is the anti-forgery check: random, stored in KV for 10 minutes, used once.
import { getCreds, getTokens, putTokens, getJSON, putJSON, cleanError, LABEL } from "./store.js";

export const TIKTOK_SCOPES = "user.info.basic,video.publish";
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const TIKTOK_TOKEN = "https://open.tiktokapis.com/v2/oauth/token/";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

export const redirectUri = (site, p) => `${site.replace(/\/+$/, "")}/admin/social/callback/${p}`;

function randomHex(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const form = (obj) => new URLSearchParams(obj).toString();
const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

// Returns the URL to send the owner to, or throws if the app credentials are missing.
export async function startAuth(kv, p, site, now = Date.now()) {
  const creds = await getCreds(kv, p);
  if (!creds || !creds.id || !creds.secret) throw new Error(`Save the ${LABEL[p]} app credentials first (step 1).`);
  const state = randomHex();
  await putJSON(kv, `social:state:${state}`, { platform: p, at: now }, 600);
  const redirect_uri = redirectUri(site, p);
  if (p === "tiktok") {
    return "https://www.tiktok.com/v2/auth/authorize/?" + form({ client_key: creds.id, scope: TIKTOK_SCOPES, response_type: "code", redirect_uri, state });
  }
  return "https://accounts.google.com/o/oauth2/v2/auth?" + form({
    client_id: creds.id, redirect_uri, response_type: "code", scope: YOUTUBE_SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state
  });
}

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

// Handles /admin/social/callback/<p>?code=…&state=…; stores the tokens. Returns a short success message.
export async function finishAuth(kv, p, params, site, { now = Date.now(), fetchImpl = fetch } = {}) {
  const state = params.get("state") || "";
  const saved = /^[0-9a-f]{16,64}$/.test(state) ? await getJSON(kv, `social:state:${state}`) : null;
  if (saved) await kv.delete(`social:state:${state}`);
  if (!saved || saved.platform !== p || now - saved.at > 600000) throw new Error("This sign-in link expired or did not start here. Press Connect again.");
  if (params.get("error")) throw new Error(`${LABEL[p]} said: ${params.get("error_description") || params.get("error")}`.slice(0, 300));
  const code = params.get("code");
  if (!code) throw new Error(`${LABEL[p]} did not send a sign-in code. Press Connect again.`);
  const creds = await getCreds(kv, p);
  if (!creds) throw new Error(`Save the ${LABEL[p]} app credentials first.`);
  const redirect_uri = redirectUri(site, p);

  if (p === "tiktok") {
    const res = await fetchImpl(TIKTOK_TOKEN, { method: "POST", headers: FORM_HEADERS, body: form({ client_key: creds.id, client_secret: creds.secret, code, grant_type: "authorization_code", redirect_uri }) });
    const j = await readJson(res);
    if (!res.ok || !j.access_token) throw new Error(`TikTok refused the sign-in: ${j.error_description || j.error || res.status}`);
    const scopes = String(j.scope || "");
    let name = "";
    try {
      const u = await fetchImpl("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", { headers: { Authorization: `Bearer ${j.access_token}` } });
      const uj = await readJson(u);
      name = (uj.data && uj.data.user && uj.data.user.display_name) || "";
    } catch {}
    await putTokens(kv, "tiktok", {
      access: j.access_token, refresh: j.refresh_token, expiresAt: now + Number(j.expires_in || 86400) * 1000,
      refreshExpiresAt: now + Number(j.refresh_expires_in || 31536000) * 1000, openId: j.open_id || "", scope: scopes, name, connectedAt: now
    });
    if (scopes && !scopes.split(",").includes("video.publish")) return `Connected, but TikTok did not grant video.publish. Add the Content Posting API (Direct Post) to your app, then connect again.`;
    return `TikTok connected${name ? ` as ${name}` : ""}.`;
  }

  const res = await fetchImpl(GOOGLE_TOKEN, { method: "POST", headers: FORM_HEADERS, body: form({ code, client_id: creds.id, client_secret: creds.secret, redirect_uri, grant_type: "authorization_code" }) });
  const j = await readJson(res);
  if (!res.ok || !j.access_token) throw new Error(`Google refused the sign-in: ${j.error_description || j.error || res.status}`);
  if (!j.refresh_token) throw new Error("Google did not give a long-term key. Open myaccount.google.com/permissions, remove SendFair, then press Connect YouTube again.");
  await putTokens(kv, "youtube", { access: j.access_token, refresh: j.refresh_token, expiresAt: now + Number(j.expires_in || 3600) * 1000, scope: j.scope || "", name: "", connectedAt: now });
  return "YouTube connected. The channel name appears here after the first upload.";
}

// Returns a valid access token (refreshing it when it expires within 5 minutes), or null when not connected.
export async function accessToken(kv, p, { now = Date.now(), fetchImpl = fetch } = {}) {
  const tok = await getTokens(kv, p);
  if (!tok || !tok.refresh) return null;
  if (tok.access && tok.expiresAt - 300000 > now) return tok.access;
  const creds = await getCreds(kv, p);
  if (!creds) throw new Error(`The ${LABEL[p]} app credentials are missing. Save them and connect again.`);
  let res, j;
  try {
    res = p === "tiktok"
      ? await fetchImpl(TIKTOK_TOKEN, { method: "POST", headers: FORM_HEADERS, body: form({ client_key: creds.id, client_secret: creds.secret, grant_type: "refresh_token", refresh_token: tok.refresh }) })
      : await fetchImpl(GOOGLE_TOKEN, { method: "POST", headers: FORM_HEADERS, body: form({ client_id: creds.id, client_secret: creds.secret, grant_type: "refresh_token", refresh_token: tok.refresh }) });
    j = await readJson(res);
  } catch (e) {
    throw new Error(`Could not reach ${LABEL[p]} to renew the sign-in: ${cleanError(e)}`);
  }
  if (!res.ok || !j.access_token) {
    const why = j.error_description || j.error || res.status;
    tok.error = `Sign-in expired or was revoked (${why}). Press Connect ${LABEL[p]} again.`;
    tok.errorAt = now;
    await putTokens(kv, p, tok);
    throw new Error(tok.error);
  }
  tok.access = j.access_token;
  tok.expiresAt = now + Number(j.expires_in || (p === "tiktok" ? 86400 : 3600)) * 1000;
  if (j.refresh_token) tok.refresh = j.refresh_token; // TikTok may rotate it; always keep the newest.
  if (j.refresh_expires_in) tok.refreshExpiresAt = now + Number(j.refresh_expires_in) * 1000;
  delete tok.error; delete tok.errorAt;
  await putTokens(kv, p, tok);
  return tok.access;
}
