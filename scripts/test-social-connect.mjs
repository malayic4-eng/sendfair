// Tests automatic Reel posting to TikTok and YouTube (functions/social/): saving app credentials,
// OAuth start/callback with state checks, token refresh, both posting flows (SELF_ONLY fallback,
// missing manifest, idempotency, retries, error recording) and that the cron dispatch leaves the
// existing scheduled jobs alone. Uses an in-memory KV and a stubbed fetch; nothing leaves the machine.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { handleSocialAdmin, callbackBounce, esc } from "../functions/social/admin.js";
import { postPlatform, runSocialCron, SOCIAL_CRON } from "../functions/social/post.js";
import { accessToken } from "../functions/social/oauth.js";
import { nairobiDate } from "../functions/social/store.js";

const SITE = "https://sendfair.africa";
const BASE = "https://media.example";
const NOW = Date.UTC(2026, 10, 20, 17, 40); // 20:40 in Nairobi
const DATE = "2026-11-20";

class MemoryKV {
  constructor() { this.map = new Map(); this.ttl = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v, o) { this.map.set(k, String(v)); if (o && o.expirationTtl) this.ttl.set(k, o.expirationTtl); }
  async delete(k) { this.map.delete(k); }
}
const J = (kv, k) => JSON.parse(kv.map.get(k));
const jsonRes = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

// A fetch stub that routes by URL; records every call.
function stub(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, init });
    for (const [match, handler] of routes) {
      if (typeof match === "string" ? url.startsWith(match) : match.test(url)) return handler(url, init, calls);
    }
    return new Response("not found", { status: 404 });
  };
  f.calls = calls;
  return f;
}
const VIDEO = new Uint8Array(1234);
const mediaRoutes = (manifest = { captions: { tiktok: "Cheapest way to send £250 to Kenya today #SendFair", youtube: { title: "Send £250 to Kenya: cheapest today #Shorts", description: "Compare at sendfair.africa <now>" } } }) => [
  [`${BASE}/social/${DATE}/manifest.json`, () => manifest ? jsonRes(manifest) : new Response("no", { status: 404 })],
  [`${BASE}/social/${DATE}/reel.mp4`, () => new Response(VIDEO, { headers: { "content-length": String(VIDEO.length), "content-type": "video/mp4" } })]
];

function env() { return { SENDFAIR_KV: new MemoryKV() }; }
async function connect(e, p, extra = {}) {
  await e.SENDFAIR_KV.put(`social:cfg:${p}`, JSON.stringify({ id: p + "-id", secret: p + "-SECRET-VALUE" }));
  await e.SENDFAIR_KV.put(`social:tok:${p}`, JSON.stringify({ access: "AT-" + p, refresh: "RT-" + p, expiresAt: NOW + 3600e3, connectedAt: NOW, ...extra }));
}
const post = (path, body, headers = { Origin: SITE }) => new Request(SITE + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() });
const call = (e, req, fetchImpl) => handleSocialAdmin(req, e, new URL(req.url), { base: BASE, site: SITE, fetchImpl, now: NOW, sleep: async () => {} });

function tiktokRoutes({ options = ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], initError, status = "PUBLISH_COMPLETE", putStatus = 201 } = {}) {
  return [
    ["https://open.tiktokapis.com/v2/post/publish/creator_info/query/", () => jsonRes({ data: { privacy_level_options: options, creator_nickname: "SendFair", creator_username: "sendfair" }, error: { code: "ok" } })],
    ["https://open.tiktokapis.com/v2/post/publish/video/init/", () => initError ? jsonRes({ data: {}, error: { code: initError, message: "nope" } }, 403) : jsonRes({ data: { publish_id: "v_pub_1", upload_url: "https://upload.tiktokapis.com/u/1" }, error: { code: "ok" } })],
    ["https://upload.tiktokapis.com/", () => new Response("", { status: putStatus })],
    ["https://open.tiktokapis.com/v2/post/publish/status/fetch/", () => jsonRes({ data: { status, fail_reason: status === "FAILED" ? "file_format_check_failed" : undefined, publicaly_available_post_id: status === "PUBLISH_COMPLETE" ? [7312345] : [] }, error: { code: "ok" } })]
  ];
}
function youtubeRoutes({ startStatus = 200, privacy = "public" } = {}) {
  return [
    ["https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable", () => startStatus === 200
      ? new Response("", { status: 200, headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc" } })
      : jsonRes({ error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } }, startStatus)],
    ["https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc", () => jsonRes({ id: "yt123", snippet: { channelTitle: "SendFair" }, status: { privacyStatus: privacy } })]
  ];
}

test("nairobi date is UTC+3", () => {
  assert.equal(nairobiDate(Date.UTC(2026, 10, 20, 20, 59)), "2026-11-20");
  assert.equal(nairobiDate(Date.UTC(2026, 10, 20, 21, 0)), "2026-11-21");
});

test("saving app credentials stores them in KV and never echoes the secret", async () => {
  const e = env();
  let r = await call(e, post("/admin/social/creds/tiktok", { id: "awkey", secret: "TOP-SECRET-123" }));
  assert.equal(r.status, 303);
  assert.deepEqual({ id: J(e.SENDFAIR_KV, "social:cfg:tiktok").id, secret: J(e.SENDFAIR_KV, "social:cfg:tiktok").secret }, { id: "awkey", secret: "TOP-SECRET-123" });
  r = await call(e, new Request(SITE + "/admin/social/"));
  const html = await r.text();
  assert.match(html, /saved ✓/);
  assert.ok(!html.includes("TOP-SECRET-123"));
  assert.match(html, /https:\/\/sendfair\.africa\/admin\/social\/callback\/tiktok/);
  assert.match(html, /https:\/\/sendfair\.africa\/admin\/social\/callback\/youtube/);
  // Missing fields don't overwrite.
  await call(e, post("/admin/social/creds/tiktok", { id: "x", secret: "" }));
  assert.equal(J(e.SENDFAIR_KV, "social:cfg:tiktok").id, "awkey");
});

test("POST actions require a same-origin request", async () => {
  const e = env();
  const r = await call(e, post("/admin/social/creds/youtube", { id: "a", secret: "b" }, { Origin: "https://evil.example" }));
  assert.equal(r.status, 403);
  assert.equal(e.SENDFAIR_KV.map.has("social:cfg:youtube"), false);
  const r2 = await call(e, post("/admin/social/creds/youtube", { id: "a", secret: "b" }, {}));
  assert.equal(r2.status, 403);
  const r3 = await call(e, new Request(SITE + "/admin/social/post/youtube"));
  assert.equal(r3.status, 405);
});

test("TikTok OAuth: start stores a 10-minute state; callback checks it and stores tokens", async () => {
  const e = env();
  await call(e, post("/admin/social/creds/tiktok", { id: "awkey", secret: "sek" }));
  const r = await call(e, post("/admin/social/connect/tiktok", {}));
  assert.equal(r.status, 303);
  const to = new URL(r.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(to.searchParams.get("client_key"), "awkey");
  assert.equal(to.searchParams.get("redirect_uri"), SITE + "/admin/social/callback/tiktok");
  assert.equal(to.searchParams.get("scope"), "user.info.basic,video.publish");
  const state = to.searchParams.get("state");
  assert.equal(e.SENDFAIR_KV.ttl.get("social:state:" + state), 600);

  const f = stub([
    ["https://open.tiktokapis.com/v2/oauth/token/", (u, init) => {
      const b = new URLSearchParams(init.body);
      assert.equal(b.get("grant_type"), "authorization_code");
      assert.equal(b.get("client_secret"), "sek");
      assert.equal(b.get("redirect_uri"), SITE + "/admin/social/callback/tiktok");
      return jsonRes({ access_token: "act.1", expires_in: 86400, refresh_token: "rft.1", refresh_expires_in: 31536000, open_id: "o1", scope: "user.info.basic,video.publish" });
    }],
    ["https://open.tiktokapis.com/v2/user/info/", () => jsonRes({ data: { user: { display_name: "SendFair" } }, error: { code: "ok" } })]
  ]);
  // A wrong state is refused and stores nothing.
  await call(e, new Request(`${SITE}/admin/social/callback/tiktok?code=abc&state=${"0".repeat(48)}&sf=1`), f);
  assert.equal(e.SENDFAIR_KV.map.has("social:tok:tiktok"), false);
  assert.match(J(e.SENDFAIR_KV, "social:note:tiktok").msg, /expired or did not start here/);
  // The right state works once.
  const cb = await call(e, new Request(`${SITE}/admin/social/callback/tiktok?code=abc&state=${state}&sf=1`), f);
  assert.equal(cb.status, 303);
  const tok = J(e.SENDFAIR_KV, "social:tok:tiktok");
  assert.equal(tok.access, "act.1"); assert.equal(tok.refresh, "rft.1"); assert.equal(tok.name, "SendFair");
  assert.equal(tok.expiresAt, NOW + 86400e3);
  assert.equal(e.SENDFAIR_KV.map.has("social:state:" + state), false);
  // Replaying the same state fails (single use) and keeps the stored tokens.
  await call(e, new Request(`${SITE}/admin/social/callback/tiktok?code=abc&state=${state}&sf=1`), f);
  assert.match(J(e.SENDFAIR_KV, "social:note:tiktok").msg, /Connect failed/);
  assert.equal(J(e.SENDFAIR_KV, "social:tok:tiktok").access, "act.1");
  // Tokens never show on the page.
  const html = await (await call(e, new Request(SITE + "/admin/social"))).text();
  assert.ok(!html.includes("act.1") && !html.includes("rft.1") && !html.includes("sek"));
  assert.match(html, /connected ✓/);
});

test("YouTube OAuth asks for offline access and needs a refresh token; state is per platform", async () => {
  const e = env();
  await call(e, post("/admin/social/creds/youtube", { id: "cid.apps.googleusercontent.com", secret: "gsec" }));
  const to = new URL((await call(e, post("/admin/social/connect/youtube", {}))).headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(to.searchParams.get("access_type"), "offline");
  assert.equal(to.searchParams.get("prompt"), "consent");
  assert.equal(to.searchParams.get("scope"), "https://www.googleapis.com/auth/youtube.upload");
  const state = to.searchParams.get("state");
  // A YouTube state can't be used on the TikTok callback.
  await call(e, new Request(`${SITE}/admin/social/callback/tiktok?code=x&state=${state}&sf=1`), stub([]));
  assert.equal(e.SENDFAIR_KV.map.has("social:tok:tiktok"), false);
  const to2 = new URL((await call(e, post("/admin/social/connect/youtube", {}))).headers.get("location"));
  const f = stub([["https://oauth2.googleapis.com/token", () => jsonRes({ access_token: "ya29.x", expires_in: 3599, refresh_token: "1//r", scope: "youtube.upload" })]]);
  await call(e, new Request(`${SITE}/admin/social/callback/youtube?code=c&state=${to2.searchParams.get("state")}&sf=1`), f);
  assert.equal(J(e.SENDFAIR_KV, "social:tok:youtube").refresh, "1//r");
  // The provider's error is reported, nothing stored.
  const e2 = env();
  await call(e2, post("/admin/social/creds/youtube", { id: "a", secret: "b" }));
  const st = new URL((await call(e2, post("/admin/social/connect/youtube", {}))).headers.get("location")).searchParams.get("state");
  await call(e2, new Request(`${SITE}/admin/social/callback/youtube?error=access_denied&state=${st}&sf=1`), stub([]));
  assert.match(J(e2.SENDFAIR_KV, "social:note:youtube").msg, /access_denied/);
  assert.equal(e2.SENDFAIR_KV.map.has("social:tok:youtube"), false);
});

test("callback bounce: cross-site arrival reloads same-site; other paths untouched", () => {
  const b = callbackBounce(new URL(SITE + "/admin/social/callback/tiktok?code=a&state=b"));
  assert.ok(b);
  const b2 = callbackBounce(new URL(SITE + "/admin/social/callback/tiktok?code=a&state=b&sf=1"));
  assert.equal(b2, null);
  assert.equal(callbackBounce(new URL(SITE + "/admin/social")), null);
  assert.equal(esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});

test("token refresh: TikTok rotates refresh token; Google keeps the old one; failure is recorded", async () => {
  const e = env();
  await connect(e, "tiktok", { expiresAt: NOW + 60e3 });
  const f = stub([["https://open.tiktokapis.com/v2/oauth/token/", (u, init) => {
    const b = new URLSearchParams(init.body);
    assert.equal(b.get("grant_type"), "refresh_token"); assert.equal(b.get("refresh_token"), "RT-tiktok");
    return jsonRes({ access_token: "AT2", expires_in: 86400, refresh_token: "RT2", refresh_expires_in: 31536000 });
  }]]);
  assert.equal(await accessToken(e.SENDFAIR_KV, "tiktok", { now: NOW, fetchImpl: f }), "AT2");
  assert.equal(J(e.SENDFAIR_KV, "social:tok:tiktok").refresh, "RT2");
  // Still fresh: no network.
  assert.equal(await accessToken(e.SENDFAIR_KV, "tiktok", { now: NOW, fetchImpl: stub([]) }), "AT2");

  await connect(e, "youtube", { expiresAt: NOW - 1 });
  const g = stub([["https://oauth2.googleapis.com/token", () => jsonRes({ access_token: "ya29.new", expires_in: 3599 })]]);
  assert.equal(await accessToken(e.SENDFAIR_KV, "youtube", { now: NOW, fetchImpl: g }), "ya29.new");
  assert.equal(J(e.SENDFAIR_KV, "social:tok:youtube").refresh, "RT-youtube");

  await connect(e, "youtube", { expiresAt: NOW - 1 });
  const bad = stub([["https://oauth2.googleapis.com/token", () => jsonRes({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400)]]);
  await assert.rejects(accessToken(e.SENDFAIR_KV, "youtube", { now: NOW, fetchImpl: bad }), /Connect YouTube again/);
  assert.match(J(e.SENDFAIR_KV, "social:tok:youtube").error, /invalid_grant|revoked/);
});

test("TikTok posting: public when allowed, single chunk upload, status poll, recorded", async () => {
  const e = env();
  await connect(e, "tiktok");
  const f = stub([...mediaRoutes(), ...tiktokRoutes()]);
  const r = await postPlatform(e, "tiktok", { base: BASE, now: NOW, fetchImpl: f, sleep: async () => {} });
  assert.equal(r.status, "posted", r.message);
  const init = JSON.parse(f.calls.find((c) => c.url.includes("/video/init/")).init.body);
  assert.equal(init.post_info.privacy_level, "PUBLIC_TO_EVERYONE");
  assert.match(init.post_info.title, /Cheapest way/);
  assert.deepEqual(init.source_info, { source: "FILE_UPLOAD", video_size: 1234, chunk_size: 1234, total_chunk_count: 1 });
  const put = f.calls.find((c) => c.url.startsWith("https://upload.tiktokapis.com/"));
  assert.equal(put.init.method, "PUT");
  assert.equal(put.init.headers["Content-Range"], "bytes 0-1233/1234");
  assert.equal(put.init.headers["Content-Type"], "video/mp4");
  assert.ok(put.init.body, "video body is streamed through");
  const rec = J(e.SENDFAIR_KV, `posted:tiktok:${DATE}`);
  assert.equal(rec.status, "posted"); assert.equal(rec.id, "v_pub_1"); assert.equal(rec.postId, "7312345");
  assert.ok(!f.calls.some((c) => c.url.includes("creator_info") && !String(c.init.headers.Authorization).startsWith("Bearer AT-tiktok")));
  // Second run the same day: skipped, no network beyond nothing.
  const f2 = stub([...mediaRoutes(), ...tiktokRoutes()]);
  const r2 = await postPlatform(e, "tiktok", { base: BASE, now: NOW + 1200e3, fetchImpl: f2, sleep: async () => {} });
  assert.equal(r2.status, "skipped"); assert.equal(f2.calls.length, 0);
  // Even the manual button won't double post.
  const r3 = await postPlatform(e, "tiktok", { manual: true, base: BASE, now: NOW, fetchImpl: f2, sleep: async () => {} });
  assert.equal(r3.status, "skipped"); assert.equal(f2.calls.length, 0);
});

test("TikTok unaudited app: falls back to SELF_ONLY and says so on the page", async () => {
  const e = env();
  await connect(e, "tiktok");
  const f = stub([...mediaRoutes(), ...tiktokRoutes({ options: ["SELF_ONLY"] })]);
  const r = await postPlatform(e, "tiktok", { base: BASE, now: NOW, fetchImpl: f, sleep: async () => {} });
  assert.equal(r.status, "posted");
  assert.equal(JSON.parse(f.calls.find((c) => c.url.includes("/video/init/")).init.body).post_info.privacy_level, "SELF_ONLY");
  assert.match(J(e.SENDFAIR_KV, `posted:tiktok:${DATE}`).note, /not audited/);
  const html = await (await call(e, new Request(SITE + "/admin/social"))).text();
  assert.match(html, /TikTok app not audited yet: posts are private until TikTok approves your app/);
});

test("manifest missing: quiet skip, nothing recorded, no token refresh", async () => {
  const e = env();
  await connect(e, "tiktok", { expiresAt: NOW - 1 });
  const f = stub(mediaRoutes(null));
  const r = await postPlatform(e, "tiktok", { base: BASE, now: NOW, fetchImpl: f });
  assert.equal(r.status, "skipped"); assert.match(r.message, /not ready/);
  assert.equal(e.SENDFAIR_KV.map.has(`posted:tiktok:${DATE}`), false);
  assert.equal(f.calls.length, 1);
});

test("errors are recorded; automatic retries stop after 3 failures; manual still allowed", async () => {
  const e = env();
  await connect(e, "tiktok", { expiresAt: NOW + 86400e3 });
  const failing = () => stub([...mediaRoutes(), ...tiktokRoutes({ initError: "unaudited_client_can_only_post_to_private_accounts" })]);
  for (let i = 1; i <= 3; i++) {
    const r = await postPlatform(e, "tiktok", { base: BASE, now: NOW + i * 1200e3, fetchImpl: failing(), sleep: async () => {} });
    assert.equal(r.status, "failed");
    const rec = J(e.SENDFAIR_KV, `posted:tiktok:${DATE}`);
    assert.equal(rec.attempts, i); assert.equal(rec.status, "failed");
    assert.match(rec.error, /Private account/);
    assert.ok(!rec.error.includes("AT-tiktok"));
  }
  const f4 = failing();
  const r4 = await postPlatform(e, "tiktok", { base: BASE, now: NOW + 5000e3, fetchImpl: f4, sleep: async () => {} });
  assert.equal(r4.status, "skipped"); assert.equal(f4.calls.length, 0);
  const ok = stub([...mediaRoutes(), ...tiktokRoutes()]);
  const r5 = await postPlatform(e, "tiktok", { manual: true, base: BASE, now: NOW + 5000e3, fetchImpl: ok, sleep: async () => {} });
  assert.equal(r5.status, "posted");
  assert.equal(J(e.SENDFAIR_KV, `posted:tiktok:${DATE}`).attempts, 4);
});

test("TikTok publish FAILED status is recorded as failure", async () => {
  const e = env();
  await connect(e, "tiktok");
  const r = await postPlatform(e, "tiktok", { base: BASE, now: NOW, fetchImpl: stub([...mediaRoutes(), ...tiktokRoutes({ status: "FAILED" })]), sleep: async () => {} });
  assert.equal(r.status, "failed");
  assert.match(J(e.SENDFAIR_KV, `posted:tiktok:${DATE}`).error, /file_format_check_failed/);
});

test("in-progress claim blocks a parallel run; a stale claim is not retried automatically", async () => {
  const e = env();
  await connect(e, "youtube");
  await e.SENDFAIR_KV.put(`posted:youtube:${DATE}`, JSON.stringify({ status: "in-progress", attempts: 1, startedAt: NOW - 60e3 }));
  const f = stub([...mediaRoutes(), ...youtubeRoutes()]);
  assert.equal((await postPlatform(e, "youtube", { base: BASE, now: NOW, fetchImpl: f })).status, "skipped");
  assert.equal(f.calls.length, 0);
  const later = NOW + 40 * 60e3;
  assert.equal((await postPlatform(e, "youtube", { base: BASE, now: later, fetchImpl: f })).status, "skipped");
  const rec = J(e.SENDFAIR_KV, `posted:youtube:${DATE}`);
  assert.equal(rec.status, "failed"); assert.equal(rec.interrupted, true);
  assert.equal((await postPlatform(e, "youtube", { base: BASE, now: later + 1200e3, fetchImpl: f })).status, "skipped");
  assert.equal(f.calls.length, 0);
});

test("YouTube posting: resumable upload with metadata; private result flagged; errors recorded", async () => {
  const e = env();
  await connect(e, "youtube");
  const f = stub([...mediaRoutes(), ...youtubeRoutes()]);
  const r = await postPlatform(e, "youtube", { base: BASE, now: NOW, fetchImpl: f });
  assert.equal(r.status, "posted", r.message);
  const start = f.calls.find((c) => c.url.includes("uploadType=resumable"));
  assert.match(start.url, /part=snippet,status/);
  assert.equal(start.init.headers["X-Upload-Content-Length"], "1234");
  const meta = JSON.parse(start.init.body);
  assert.equal(meta.snippet.title, "Send £250 to Kenya: cheapest today #Shorts");
  assert.ok(!meta.snippet.description.includes("<"));
  assert.equal(meta.snippet.categoryId, "22");
  assert.deepEqual(meta.status, { privacyStatus: "public", selfDeclaredMadeForKids: false });
  const put = f.calls.find((c) => c.url.includes("upload_id=abc"));
  assert.equal(put.init.method, "PUT"); assert.equal(put.init.headers["Content-Length"], "1234");
  const rec = J(e.SENDFAIR_KV, `posted:youtube:${DATE}`);
  assert.equal(rec.id, "yt123"); assert.equal(rec.url, "https://youtube.com/shorts/yt123");
  assert.equal(J(e.SENDFAIR_KV, "social:tok:youtube").name, "SendFair");

  const e2 = env(); await connect(e2, "youtube");
  await postPlatform(e2, "youtube", { base: BASE, now: NOW, fetchImpl: stub([...mediaRoutes(), ...youtubeRoutes({ privacy: "private" })]) });
  assert.match(J(e2.SENDFAIR_KV, `posted:youtube:${DATE}`).note, /private/);

  const e3 = env(); await connect(e3, "youtube");
  const r3 = await postPlatform(e3, "youtube", { base: BASE, now: NOW, fetchImpl: stub([...mediaRoutes(), ...youtubeRoutes({ startStatus: 403 })]) });
  assert.equal(r3.status, "failed");
  assert.match(J(e3.SENDFAIR_KV, `posted:youtube:${DATE}`).error, /quotaExceeded/);
});

test("manual Post-now button runs through the admin route and shows the result", async () => {
  const e = env();
  await connect(e, "youtube");
  const r = await call(e, post("/admin/social/post/youtube", {}), stub([...mediaRoutes(), ...youtubeRoutes()]));
  assert.equal(r.status, 303);
  assert.match(J(e.SENDFAIR_KV, "social:note:youtube").msg, /Posted to YouTube/);
  const html = await (await call(e, new Request(SITE + "/admin/social"))).text();
  assert.match(html, /youtube\.com\/shorts\/yt123/);
});

test("cron: respects toggles and connection; both platforms in one run", async () => {
  const e = env();
  await connect(e, "tiktok"); await connect(e, "youtube");
  await call(e, post("/admin/social/toggle/tiktok", { on: "0" }));
  const f = stub([...mediaRoutes(), ...youtubeRoutes(), ...tiktokRoutes()]);
  const out = await runSocialCron(e, { base: BASE, now: NOW, fetchImpl: f, sleep: async () => {} });
  assert.deepEqual(out, { tiktok: "off", youtube: "posted" });
  assert.ok(!f.calls.some((c) => c.url.includes("tiktokapis")));
  const out2 = await runSocialCron(env(), { base: BASE, now: NOW, fetchImpl: f });
  assert.deepEqual(out2, { tiktok: "not connected", youtube: "not connected" });
});

test("cron wiring: one new trigger, dispatched before the existing jobs, under the 5-trigger limit", () => {
  const wr = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const crons = JSON.parse(wr.match(/"crons":\s*(\[[^\]]*\])/)[1]);
  assert.ok(crons.includes(SOCIAL_CRON));
  assert.ok(crons.includes("30 8 * * *") && crons.includes("30 18 * * *") && crons.includes("0 3 * * *"));
  assert.ok(crons.length <= 5);
  const w = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  const sched = w.slice(w.indexOf("async scheduled("));
  const iSocial = sched.indexOf("event.cron === SOCIAL_CRON");
  const iPurge = sched.indexOf('event.cron === "0 3 * * *"');
  const iAlerts = sched.indexOf("alert.runAlerts(env)");
  assert.ok(iSocial > 0 && iPurge > 0 && iAlerts > iPurge && iSocial < iAlerts);
  assert.match(sched.slice(iSocial, iPurge), /return;/);
  // The callback bounce comes before the sign-in check; the admin routes after it.
  const iBounce = w.indexOf("callbackBounce(url)"), iGate = w.indexOf("await adminGate("), iRoutes = w.indexOf("handleSocialAdmin(request");
  assert.ok(iBounce > 0 && iBounce < iGate && iGate < iRoutes);
  const cfg = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
  assert.match(cfg.socialMediaBase, /^https:\/\/pub-[0-9a-f]+\.r2\.dev$/);
});
