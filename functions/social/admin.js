// /admin/social: connect TikTok and YouTube, switch automatic posting on or off, post today's Reel by hand.
// Runs after the Rate Desk sign-in (adminGate in src/worker.js). Every POST also checks Origin.
// App secrets and tokens are stored in KV and are never written into the page or the logs.
import { startAuth, finishAuth, redirectUri, TIKTOK_SCOPES } from "./oauth.js";
import { postPlatform } from "./post.js";
import {
  PLATFORMS, LABEL, getCreds, putCreds, getTokens, getSettings, setEnabled, getNote, setNote,
  getPosted, lastDates, nairobiDate, getJSON, cleanError
} from "./store.js";

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const HTML_HEADERS = {
  ...NO_STORE, "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self' https://www.tiktok.com https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'"
};

export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// The OAuth callback arrives from tiktok.com / google.com. Browsers don't send the SameSite=Strict
// sign-in cookie on that cross-site hop, so this tiny page (served before the sign-in check, with no
// data and no side effects) reloads the same address from sendfair.africa itself; that same-site
// request carries the cookie and goes through the normal sign-in check.
export function callbackBounce(url) {
  if (!/^\/admin\/social\/callback\/(tiktok|youtube)\/?$/.test(url.pathname) || url.searchParams.get("sf") === "1") return null;
  const next = new URL(url);
  next.searchParams.set("sf", "1");
  const href = next.pathname + next.search;
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${esc(href)}"><title>Connecting…</title><p>Connecting… <a href="${esc(href)}">Continue</a></p>`, {
    headers: { ...NO_STORE, "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" }
  });
}

function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (origin) return origin === url.origin;
  const ref = request.headers.get("Referer") || "";
  return ref.startsWith(url.origin + "/");
}
const back = (url) => new Response(null, { status: 303, headers: { ...NO_STORE, Location: url.origin + "/admin/social/" } });

// Returns a Response for /admin/social routes, or null when the path isn't one of them.
// opts: { base: public R2 base URL, site: https://sendfair.africa, fetchImpl, now }
export async function handleSocialAdmin(request, env, url, opts) {
  const path = url.pathname.replace(/\/+$/, "");
  if (!/^\/admin\/social(\/|$)/.test(path)) return null;
  const kv = env.SENDFAIR_KV;
  if (!kv) return new Response("Storage (SENDFAIR_KV) is not connected to this Worker.", { status: 503, headers: NO_STORE });
  const site = opts.site || url.origin;

  if (path === "/admin/social") {
    if (request.method !== "GET") return new Response("Method not allowed.", { status: 405, headers: NO_STORE });
    return new Response(await renderPage(kv, site, opts.now), { headers: HTML_HEADERS });
  }

  const cb = path.match(/^\/admin\/social\/callback\/(tiktok|youtube)$/);
  if (cb) {
    if (request.method !== "GET") return new Response("Method not allowed.", { status: 405, headers: NO_STORE });
    const p = cb[1];
    try {
      const msg = await finishAuth(kv, p, url.searchParams, site, { fetchImpl: opts.fetchImpl, now: opts.now });
      await setNote(kv, p, msg, true);
    } catch (e) {
      await setNote(kv, p, "Connect failed: " + cleanError(e), false);
    }
    return back(url);
  }

  const m = path.match(/^\/admin\/social\/(creds|connect|toggle|post|disconnect)\/(tiktok|youtube)$/);
  if (!m) return new Response("Not found.", { status: 404, headers: NO_STORE });
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: NO_STORE });
  if (!sameOrigin(request, url)) return new Response("Forbidden (bad origin).", { status: 403, headers: NO_STORE });
  const [, action, p] = m;
  let fd;
  try { fd = await request.formData(); } catch { fd = new FormData(); }
  const field = (k) => String(fd.get(k) || "").trim();

  if (action === "creds") {
    const id = field("id"), secret = field("secret");
    if (!id || !secret || id.length > 200 || secret.length > 400 || /\s/.test(id + secret)) {
      await setNote(kv, p, "Not saved: paste both values, without spaces.", false);
    } else {
      await putCreds(kv, p, { id, secret, savedAt: Date.now() });
      await setNote(kv, p, "App credentials saved ✓", true);
    }
    return back(url);
  }
  if (action === "connect") {
    try {
      const to = await startAuth(kv, p, site, opts.now);
      return new Response(null, { status: 303, headers: { ...NO_STORE, Location: to } });
    } catch (e) {
      await setNote(kv, p, cleanError(e), false);
      return back(url);
    }
  }
  if (action === "toggle") {
    const on = field("on") === "1";
    await setEnabled(kv, p, on);
    await setNote(kv, p, `Daily automatic posting turned ${on ? "ON" : "OFF"}.`, true);
    return back(url);
  }
  if (action === "disconnect") {
    await kv.delete(`social:tok:${p}`);
    await setNote(kv, p, `${LABEL[p]} disconnected on SendFair. (You can also remove access in your ${LABEL[p]} account settings.)`, true);
    return back(url);
  }
  // action === "post": manual run. Waits for the upload so the result shows when the page reloads.
  const r = await postPlatform(env, p, { manual: true, base: opts.base, fetchImpl: opts.fetchImpl, now: opts.now, sleep: opts.sleep });
  await setNote(kv, p, `Post now: ${r.message}`, r.status !== "failed");
  return back(url);
}

const when = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");

async function platformCard(kv, p, site, settings, now) {
  const [creds, tok, note, info] = await Promise.all([getCreds(kv, p), getTokens(kv, p), getNote(kv, p), p === "tiktok" ? getJSON(kv, "social:info:tiktok") : null]);
  const dates = lastDates(7, now);
  const history = await Promise.all(dates.map((d) => getPosted(kv, p, d)));
  const idLabel = p === "tiktok" ? "Client key" : "Client ID";
  const secretLabel = "Client secret";
  const connected = !!(tok && tok.refresh);
  const rows = dates.map((d, i) => {
    const h = history[i];
    if (!h) return `<tr><td>${esc(d)}</td><td class="muted">—</td><td></td></tr>`;
    const link = h.url ? ` <a href="${esc(h.url)}" rel="noopener" target="_blank">open</a>` : h.postId ? ` post ${esc(h.postId)}` : h.id ? ` <span class="muted">id ${esc(h.id)}</span>` : "";
    const detail = h.status === "posted"
      ? `${esc(h.privacy || "")}${h.processing ? " (still processing)" : ""}${link}${h.note ? `<br><span class="warn">${esc(h.note)}</span>` : ""}`
      : h.status === "failed" ? `<span class="bad">${esc(h.error || "")}</span>` : `started ${esc(when(h.startedAt))}`;
    return `<tr><td>${esc(d)}</td><td class="st-${esc(h.status)}">${esc(h.status)}${h.manual ? " (manual)" : ""} · try ${esc(h.attempts || 1)}<br><span class="muted">${esc(when(h.postedAt || h.failedAt || h.startedAt))}</span></td><td>${detail}</td></tr>`;
  }).join("");
  const audit = p === "tiktok" && info && !info.audited
    ? `<p class="warn"><b>TikTok app not audited yet: posts are private until TikTok approves your app.</b> TikTok currently allows: ${esc((info.options || []).join(", "))}.</p>` : "";
  return `<section class="card" id="${p}">
<h2>${LABEL[p]}${p === "youtube" ? " Shorts" : ""}</h2>
${note ? `<p class="${note.ok ? "ok" : "bad"}">${esc(note.msg)} <span class="muted">(${esc(when(note.at))})</span></p>` : ""}
<table class="facts">
<tr><th>App credentials</th><td>${creds ? `saved ✓ <span class="muted">${esc(when(creds.savedAt))}</span>` : `<span class="bad">not saved</span>`}</td></tr>
<tr><th>Account</th><td>${connected ? `connected ✓ ${tok.name ? "· " + esc(tok.name) : ""} <span class="muted">since ${esc(when(tok.connectedAt))}</span>` : `<span class="bad">not connected</span>`}${tok && tok.error ? `<br><span class="bad">${esc(tok.error)}</span>` : ""}</td></tr>
<tr><th>Daily auto-post</th><td>${settings[p] ? "<b>ON</b>" : "OFF"} <span class="muted">(checks every 20 min, 20:00–00:59 Nairobi time, until today's Reel is posted)</span></td></tr>
</table>
${audit}
<div class="actions">
<form method="post" action="/admin/social/connect/${p}"><button ${creds ? "" : "disabled"}>${connected ? "Reconnect" : "Connect"} ${LABEL[p]}</button></form>
<form method="post" action="/admin/social/toggle/${p}"><input type="hidden" name="on" value="${settings[p] ? "0" : "1"}"><button class="ghost">Turn auto-post ${settings[p] ? "OFF" : "ON"}</button></form>
<form method="post" action="/admin/social/post/${p}" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Posting… (up to a minute)'"><button class="ghost" ${connected ? "" : "disabled"}>Post today's Reel now</button></form>
${connected ? `<form method="post" action="/admin/social/disconnect/${p}" onsubmit="return confirm('Disconnect ${LABEL[p]}?')"><button class="ghost">Disconnect</button></form>` : ""}
</div>
<details><summary>Save or replace the app credentials</summary>
<form method="post" action="/admin/social/creds/${p}" class="creds" autocomplete="off">
<label>${idLabel}<input name="id" required spellcheck="false"></label>
<label>${secretLabel}<input name="secret" type="password" required spellcheck="false"></label>
<button>Save</button> <span class="muted">Saved values are never shown again.</span>
</form></details>
<p class="muted">Redirect URI to paste in the ${p === "tiktok" ? "TikTok developer portal" : "Google Cloud console"}: <code>${esc(redirectUri(site, p))}</code></p>
<h3>Last 7 days</h3>
<table class="hist"><tr><th>Date (Nairobi)</th><th>Result</th><th>Details</th></tr>${rows}</table>
</section>`;
}

async function renderPage(kv, site, now = Date.now()) {
  const settings = await getSettings(kv);
  const cards = await Promise.all(PLATFORMS.map((p) => platformCard(kv, p, site, settings, now)));
  const tt = esc(redirectUri(site, "tiktok")), yt = esc(redirectUri(site, "youtube")), s = esc(site.replace(/\/+$/, ""));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Social posting · SendFair</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f5f1;color:#1a1a1a;margin:0;padding:1rem;line-height:1.45}
main{max-width:860px;margin:0 auto}h1{font-size:1.4rem}h2{margin-top:0}.card{background:#fff;border-radius:12px;padding:1.2rem;margin:1rem 0;box-shadow:0 2px 10px rgba(0,0,0,.06)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #eee;vertical-align:top;font-size:.92rem}.facts th{width:11rem}
.actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}.actions form{margin:0}
button{padding:.55rem .9rem;font-size:.95rem;border:0;border-radius:8px;background:#0b6e4f;color:#fff;cursor:pointer}button.ghost{background:#e7efe9;color:#0b6e4f}button:disabled{opacity:.45;cursor:not-allowed}
.creds label{display:block;margin:.5rem 0}.creds input{display:block;width:100%;max-width:420px;padding:.5rem;border:1px solid #ccc;border-radius:8px;font-size:1rem}
.ok{color:#0b6e4f}.bad{color:#b00020}.warn{color:#8a5a00}.muted{color:#777;font-size:.85rem}.st-posted{color:#0b6e4f}.st-failed{color:#b00020}
code{background:#f0f0ec;padding:.1rem .3rem;border-radius:4px;word-break:break-all}ol li{margin:.35rem 0}details{margin:.5rem 0}summary{cursor:pointer;font-weight:600}</style></head><body><main>
<p><a href="/admin/">← Rate Desk</a></p>
<h1>Daily Reel → TikTok and YouTube Shorts</h1>
<p>Every evening the Reel is made and uploaded automatically. Once a platform below is <b>connected</b> and <b>auto-post is ON</b>, SendFair posts that day's Reel there by itself (it checks every 20 minutes between 20:00 and 00:59 Nairobi time and never posts twice on the same day). Today in Nairobi: <b>${esc(nairobiDate(now))}</b>.</p>
${cards.join("\n")}
<section class="card"><h2>One-time setup: TikTok</h2>
<ol>
<li>Go to <b>developers.tiktok.com</b>, log in with the TikTok account SendFair posts from (or a developer account), open <b>Manage apps</b> and <b>Create an app</b> (choose “Individual” or your company, Continental Flow Ltd).</li>
<li>Fill in the app details: name <b>SendFair</b>, category, a short description, an icon, website <code>${s}</code>, Terms of Service <code>${s}/terms/</code>, Privacy Policy <code>${s}/privacy/</code>. Platform: <b>Web</b>.</li>
<li>Click <b>Add products</b> and add <b>Login Kit</b> and <b>Content Posting API</b>. In Content Posting API, switch on <b>Direct Post</b>.</li>
<li>In Login Kit, add this <b>Redirect URI</b> exactly: <code>${tt}</code></li>
<li>Under <b>Scopes</b>, make sure <b>user.info.basic</b> and <b>video.publish</b> are added (video.upload is optional).</li>
<li>Copy the <b>Client key</b> and <b>Client secret</b> from the app page into “Save or replace the app credentials” in the TikTok box above, and press Save.</li>
<li>Press <b>Connect TikTok</b>, log in to TikTok and press Authorize. You come back here and it says “connected ✓”.</li>
<li>Submit the app for review in the TikTok portal. <b>Until TikTok approves (audits) the app, posts can only be private (“only me”)</b>, and TikTok may require the TikTok account itself to be set to Private. TikTok's review may ask for a screen recording of how posting works; approval is not guaranteed for fully automatic posting.</li>
</ol>
<p class="muted">Scopes requested: ${esc(TIKTOK_SCOPES)}. TikTok's sign-in lasts about a day and is renewed automatically; the long-term key lasts up to a year (press Connect again if it ever says “expired”).</p>
</section>
<section class="card"><h2>One-time setup: YouTube</h2>
<ol>
<li>Go to <b>console.cloud.google.com</b> with the Google account that owns the SendFair YouTube channel. At the top, open the project menu and choose <b>New project</b>, name it <b>SendFair</b>, and create it.</li>
<li>Open <b>APIs &amp; Services → Library</b>, search for <b>YouTube Data API v3</b> and press <b>Enable</b>.</li>
<li>Open <b>APIs &amp; Services → OAuth consent screen</b> (it may be called “Google Auth Platform → Branding/Audience”). Choose <b>External</b>, app name <b>SendFair</b>, your email, home page <code>${s}</code>, privacy <code>${s}/privacy/</code>, terms <code>${s}/terms/</code>.</li>
<li>Under <b>Scopes</b> (or “Data access”) add <code>https://www.googleapis.com/auth/youtube.upload</code>. Under <b>Test users</b> (“Audience”) add your own Gmail address.</li>
<li>Then press <b>Publish app</b> (“In production”). While the app is in “Testing”, Google stops the connection after 7 days. Google may show a “Google hasn't verified this app” warning when you connect; as the owner you can click <b>Advanced → Go to SendFair</b>.</li>
<li>Open <b>APIs &amp; Services → Credentials → Create credentials → OAuth client ID</b>. Type: <b>Web application</b>, name SendFair. Under <b>Authorized redirect URIs</b> add exactly: <code>${yt}</code> and press Create.</li>
<li>Copy the <b>Client ID</b> and <b>Client secret</b> into the YouTube box above and press Save.</li>
<li>Press <b>Connect YouTube</b>, choose the account and the SendFair channel, and allow access.</li>
<li>Note: YouTube may keep videos uploaded from a new, unverified Google Cloud project <b>private</b> until the project passes YouTube's API audit (a form in the Google Cloud console / YouTube API Services). The history table above shows when that happens.</li>
</ol>
</section>
</main></body></html>`;
}
