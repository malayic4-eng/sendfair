// Cloudflare Worker entry for SendFair.
// Static pages and data are served from dist/ by Workers static assets. This script runs first so it can
// forward www to the main address, then handles /api/report, /api/reports, /api/stats and /go/<provider>. The handlers live in functions/.
import * as report from "../functions/api/report.js";
import * as reports from "../functions/api/reports.js";
import * as stats from "../functions/api/stats.js";
import * as go from "../functions/go/[provider].js";
import * as alert from "../functions/api/alert.js";
import * as ask from "../functions/api/ask.js";
import * as plan from "../functions/api/plan.js";
import * as whatsapp from "../functions/api/whatsapp.js";
import * as quoteUpload from "../functions/quote-check/upload.js";
import * as quoteStatus from "../functions/quote-check/status.js";
import * as quoteCheckout from "../functions/quote-check/checkout.js";
import * as quoteWebhook from "../functions/quote-check/webhook.js";
import * as quoteTestPay from "../functions/quote-check/test-pay.js";
import * as quoteReport from "../functions/quote-check/report.js";
import * as quoteAdmin from "../functions/quote-check/admin.js";
import { loadSettings, testMode as isQuoteTestMode } from "../functions/quote-check/settings.js";
import { getOrder } from "../functions/quote-check/store.js";
import { runPurge } from "../functions/quote-check/orders.js";
import { renderTestPayPage } from "../functions/quote-check/pay-test-page.mjs";
import { priceFor } from "../src/quote-check/config.mjs";
import { sha256 } from "../functions/_lib.js";
import { resultImage } from "./og-worker.js";
import { planResponse } from "./plan-worker.js";
import { embedWidget, embedStats } from "./embed-worker.js";
import { json } from "../functions/_lib.js";
import config from "../config.json";
import { handleSocialAdmin, callbackBounce } from "../functions/social/admin.js";
import { runSocialCron, SOCIAL_CRON } from "../functions/social/post.js";

// Automatic Reel posting to TikTok and YouTube Shorts (see /admin/social).
const SOCIAL_OPTS = { base: (config.socialMediaBase || "").replace(/\/+$/, ""), site: config.siteUrl };

// Each service's own icon, as published on its website, fetched once by this Worker (via Google's
// favicon service) and cached at Cloudflare. Visitors' browsers only ever talk to sendfair.africa.
const LOGO_DOMAINS = {
  wise: "wise.com", remitly: "remitly.com", worldremit: "worldremit.com", sendwave: "sendwave.com",
  taptapsend: "taptapsend.com", westernunion: "westernunion.com", lemfi: "lemfi.com", afriex: "afriex.com",
  nala: "nala.money", africhange: "africhange.com", mukuru: "mukuru.com", moneygram: "moneygram.com",
  ria: "riamoneytransfer.com", instarem: "instarem.com", xe: "xe.com", skrill: "skrill.com", bossmoney: "bossmoney.com", xoom: "xoom.com",
  transfergo: "transfergo.com", paysend: "paysend.com", smallworld: "smallworldfs.com", moneytrans: "moneytrans.eu", mamamoney: "mamamoney.co.za"
};
async function logo(id, request, ctx) {
  const domain = LOGO_DOMAINS[id];
  if (!domain) return new Response("Not found", { status: 404 });
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + "/logos/" + id + ".png?v=2");
  const hit = await cache.match(key);
  if (hit) return hit;
  let res = null;
  for (const src of [`https://www.google.com/s2/favicons?domain=${domain}&sz=128`, `https://icons.duckduckgo.com/ip3/${domain}.ico`]) {
    try {
      const r = await fetch(src, { cf: { cacheTtl: 2592000, cacheEverything: true } });
      if (r.ok) { res = r; break; }
    } catch (e) {}
  }
  if (!res) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=3600" } });
  const out = new Response(res.body, { headers: {
    "Content-Type": res.headers.get("Content-Type") || "image/png",
    "Cache-Control": "public, max-age=604800, s-maxage=2592000",
    "X-Robots-Tag": "noindex"
  } });
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

// ---- Rate Desk sign-in ----
const SESSION_COOKIE = "sf_admin";
const SESSION_DAYS = 7;
const enc = new TextEncoder();

function sameBytes(x, y) {
  const a = enc.encode(x), b = enc.encode(y);
  let same = a.length === b.length;
  for (let i = 0; i < b.length; i++) same = same && a[i] === b[i];
  return same;
}
async function sign(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}
async function validSession(request, env) {
  const raw = readCookie(request, SESSION_COOKIE);
  const [exp, sig] = raw.split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return sameBytes(sig, await sign(env.ADMIN_PASSWORD, "rate-desk:" + exp + ":" + (env.SESSION_VERSION || "1")));
}
function loginPage(message, status = 401) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Rate Desk sign-in · SendFair</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f5f1;color:#1a1a1a;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:min(320px,90vw)}
h1{font-size:1.25rem;margin:0 0 1rem}label{display:block;font-size:.9rem;margin-bottom:.4rem}
input{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;border:1px solid #ccc;border-radius:8px}
button{margin-top:1rem;width:100%;padding:.65rem;font-size:1rem;border:0;border-radius:8px;background:#0b6e4f;color:#fff;cursor:pointer}
p{color:#b00020;font-size:.9rem;margin:.75rem 0 0}</style></head><body>
<form method="post" action="/admin/login"><h1>SendFair Rate Desk</h1>
<label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>${message ? `<p>${message}</p>` : ""}</form></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
// Returns a Response to send instead of the Rate Desk, or null when the visitor is signed in.
async function adminGate(request, env, url) {
  const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  if (!env.ADMIN_PASSWORD) return new Response("The Rate Desk is locked. Add the secret ADMIN_PASSWORD in Cloudflare to open it.", { status: 401, headers: noStore });
  const kv = env.SENDFAIR_KV;
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/admin/logout") {
    if (request.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: noStore });
    return new Response(null, { status: 303, headers: { ...noStore, Location: "/admin/", "Set-Cookie": `${SESSION_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict` } });
  }
  if (path === "/admin/login") {
    if (request.method !== "POST") return Response.redirect(url.origin + "/admin/", 303);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipKey = "rl:admin:" + (await sha256(ip)).slice(0, 16);
    if (kv) {
      const fails = Number(await kv.get(ipKey) || 0);
      if (fails >= 5) return loginPage("Too many attempts. Try again in 15 minutes.", 429);
    }
    let pass = "";
    try { pass = String((await request.formData()).get("password") || ""); } catch (e) {}
    if (!sameBytes(pass, env.ADMIN_PASSWORD)) {
      if (kv) await kv.put(ipKey, String(Number(await kv.get(ipKey) || 0) + 1), { expirationTtl: 15 * 60 });
      return loginPage("Wrong password. Try again.");
    }
    if (kv) await kv.delete(ipKey);
    const exp = String(Date.now() + SESSION_DAYS * 86400000);
    const version = env.SESSION_VERSION || "1";
    const cookie = `${SESSION_COOKIE}=${exp}.${await sign(env.ADMIN_PASSWORD, "rate-desk:" + exp + ":" + version)}; Path=/admin; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`;
    return new Response(null, { status: 303, headers: { ...noStore, Location: "/admin/", "Set-Cookie": cookie } });
  }
  if (await validSession(request, env)) return null;
  return loginPage("");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // The Rate Desk is private: it asks for a password set in Cloudflare as the secret ADMIN_PASSWORD.
    // Sign-in is a normal page with a password box; a signed cookie then keeps the browser signed in for 7 days. Cloudflare Access also sits in front of /admin.
    if (/^\/admin(\/|$)/.test(url.pathname)) {
      const bounce = callbackBounce(url);
      if (bounce) return bounce;
      const gate = await adminGate(request, env, url);
      if (gate) return gate;
    }
    const context = { request, env, params: {}, waitUntil: (p) => ctx.waitUntil(p) };
    const path = url.pathname.replace(/\/+$/, "");
    const social = await handleSocialAdmin(request, env, url, SOCIAL_OPTS);
    if (social) return social;
    const lm = path.match(/^\/logos\/([a-z]+)\.png$/);
    if (lm) return logo(lm[1], request, ctx);

    // ---- Quote Check (paid quote review) ----
    if (path === "/api/quote-check/upload") return request.method === "POST" ? quoteUpload.onRequestPost(context) : quoteUpload.onRequest();
    if (path === "/api/quote-check/status") return request.method === "GET" ? quoteStatus.onRequestGet(context) : quoteStatus.onRequest();
    if (path === "/api/quote-check/checkout") return request.method === "POST" ? quoteCheckout.onRequestPost(context) : quoteCheckout.onRequest();
    if (path === "/api/quote-check/test-pay") return request.method === "POST" ? quoteTestPay.onRequestPost(context) : quoteTestPay.onRequest();
    const qw = path.match(/^\/api\/quote-check\/webhook\/([a-z]+)$/);
    if (qw) return request.method === "POST" ? quoteWebhook.onRequestPost(context, qw[1]) : quoteWebhook.onRequest();
    const qr = path.match(/^\/quote-check\/report\/([a-z0-9]{20,40})(\/pdf)?$/);
    if (qr) {
      if (request.method !== "GET") return new Response("Method not allowed.", { status: 405 });
      return quoteReport.onRequestGet(context, qr[1], !!qr[2]);
    }
    const qt = path.match(/^\/quote-check\/pay\/test\/([a-z0-9]{6,24})$/);
    if (qt && request.method === "GET") {
      const settings = await loadSettings(env, request).catch(() => null);
      if (!settings || !isQuoteTestMode(env, settings.config)) return env.ASSETS.fetch(request);
      const order = await getOrder(env, qt[1]);
      const view = url.searchParams.get("t") || "";
      if (!order || order.token !== view) return new Response("Test checkout not found.", { status: 404, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
      if (order.status === "paid" || order.status === "report sent") return Response.redirect(`${url.origin}/quote-check/report/${order.token}/`, 303);
      const price = order.payment && order.payment.amount > 0
        ? { amount: order.payment.amount, currency: order.payment.currency }
        : priceFor(settings.config, order.quoteCurrency);
      return new Response(renderTestPayPage({ order, amount: price.amount, currency: price.currency }), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
      });
    }
    const qa = path.match(/^\/admin\/quote-checks\/api\/([a-z]+)$/);
    if (qa) {
      if (request.method === "GET") return quoteAdmin.onRequestGet(context, qa[1]);
      if (request.method === "POST") return quoteAdmin.onRequestPost(context, qa[1]);
      return json({ error: "Method not allowed." }, 405);
    }

    if (path === "/api/report") return request.method === "POST" ? report.onRequestPost(context) : report.onRequest(context);
    if (path === "/api/reports") return request.method === "POST" ? reports.onRequestPost(context) : reports.onRequestGet(context);
    if (path === "/api/stats" && request.method === "GET") return stats.onRequestGet(context);
    if (path === "/api/alert") return request.method === "POST" ? alert.onRequestPost(context) : new Response("Use POST.", { status: 405 });
    if (path === "/api/ask" && request.method === "POST") return ask.onRequestPost(context);
    if (path === "/api/alert/confirm") return alert.onConfirm(context);
    if (path === "/api/alert/stop") return alert.onStop(context);
    if (path === "/api/alerts" && request.method === "GET") return alert.onStats(context);
    if (path === "/api/plan") return request.method === "POST" ? plan.onRequestPost(context) : plan.onRequest(context);
    if (path === "/api/whatsapp") return request.method === "GET" ? whatsapp.onVerify(context) : whatsapp.onWebhook(context);
    const pm = path.match(/^\/cost-to-build\/([a-z]+)\/plan\/([a-z0-9]{6,16})$/);
    if (pm && request.method === "GET") return planResponse(pm[1], pm[2], request, env);
    const m = path.match(/^\/go\/([^/]+)$/);
    if (m && request.method === "GET") {
      context.params.provider = decodeURIComponent(m[1]);
      return go.onRequestGet(context);
    }
    if (path === "/og/result.png" && request.method === "GET") return resultImage(request, env, ctx);
    if (path === "/embed/widget" && request.method === "GET") return embedWidget(request, env, ctx);
    if (path === "/api/embeds" && request.method === "GET") return embedStats(request, env, reports.safeEqual, json);
    return env.ASSETS.fetch(request);
  },
  // Daily, after the morning and evening rate checks: confirmation emails and rate alerts.
  // Quote Check also purges uploads, extracted data and reports after the retention period.
  async scheduled(event, env, ctx) {
    // Every 20 minutes in the evening: post today's Reel to TikTok / YouTube once it exists.
    if (event.cron === SOCIAL_CRON) {
      ctx.waitUntil(runSocialCron(env, SOCIAL_OPTS).then((r) => console.log("social", JSON.stringify(r))).catch((e) => console.log("social failed", e && e.message)));
      return;
    }
    // The 03:00 UTC run is only the Quote Check purge; rate alerts keep their two daily runs.
    if (event.cron === "0 3 * * *") {
      ctx.waitUntil(runPurge(env).then((r) => console.log("quote-check purge", JSON.stringify(r))).catch((e) => console.log("quote-check purge failed", e && e.message)));
      return;
    }
    ctx.waitUntil(alert.runAlerts(env).then((r) => console.log("alerts", JSON.stringify(r))));
  }
};
