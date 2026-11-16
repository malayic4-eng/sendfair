// Cloudflare Worker entry for SendFair.
// Static pages and data are served from dist/ by Workers static assets. This script runs first so it can
// forward www to the main address, then handles /api/report, /api/reports, /api/stats and /go/<provider>. The handlers live in functions/.
import * as report from "../functions/api/report.js";
import * as reports from "../functions/api/reports.js";
import * as stats from "../functions/api/stats.js";
import * as go from "../functions/go/[provider].js";
import * as alert from "../functions/api/alert.js";
import * as ask from "../functions/api/ask.js";

// Each service's own icon, as published on its website, fetched once by this Worker (via Google's
// favicon service) and cached at Cloudflare. Visitors' browsers only ever talk to sendfair.africa.
const LOGO_DOMAINS = {
  wise: "wise.com", remitly: "remitly.com", worldremit: "worldremit.com", sendwave: "sendwave.com",
  taptapsend: "taptapsend.com", westernunion: "westernunion.com", lemfi: "lemfi.com", afriex: "afriex.com",
  nala: "nala.money", africhange: "africhange.com", mukuru: "mukuru.com", moneygram: "moneygram.com",
  // Gulf services
  alansari: "alansariexchange.com", luluexchange: "luluexchange.com", alfardan: "alfardanexchange.com", almulla: "almullaexchange.com",
  bfc: "bfc.com.bh", omanexchange: "omanexchange.com.om", tahweel: "alrajhibank.com.sa", enjaz: "enjaz.com", urpay: "urpay.com.sa",
  stcbank: "stcpay.com.sa", ooredoomoney: "ooredoo.qa", botim: "botim.me",
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
const SESSION_DAYS = 30;
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
  return sameBytes(sig, await sign(env.ADMIN_PASSWORD, "rate-desk:" + exp));
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
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/admin/logout") {
    return new Response(null, { status: 303, headers: { ...noStore, Location: "/admin/", "Set-Cookie": `${SESSION_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict` } });
  }
  if (path === "/admin/login") {
    if (request.method !== "POST") return Response.redirect(url.origin + "/admin/", 303);
    let pass = "";
    try { pass = String((await request.formData()).get("password") || ""); } catch (e) {}
    if (!sameBytes(pass, env.ADMIN_PASSWORD)) return loginPage("Wrong password. Try again.");
    const exp = String(Date.now() + SESSION_DAYS * 86400000);
    const cookie = `${SESSION_COOKIE}=${exp}.${await sign(env.ADMIN_PASSWORD, "rate-desk:" + exp)}; Path=/admin; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`;
    return new Response(null, { status: 303, headers: { ...noStore, Location: "/admin/", "Set-Cookie": cookie } });
  }
  if (await validSession(request, env)) return null;
  // Older browser pop-up sign-in still works if a browser sends it.
  const auth = request.headers.get("Authorization") || "";
  let basic = "";
  try { basic = auth.startsWith("Basic ") ? atob(auth.slice(6)).split(":").slice(1).join(":") : ""; } catch (e) {}
  if (basic && sameBytes(basic, env.ADMIN_PASSWORD)) return null;
  return loginPage("");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname === "www.sendfair.africa") {
      url.hostname = "sendfair.africa";
      return Response.redirect(url.toString(), 301);
    }
    // The Rate Desk is private: it asks for a password set in Cloudflare as the secret ADMIN_PASSWORD.
    // Sign-in is a normal page with a password box; a signed cookie then keeps the browser signed in for 30 days.
    if (/^\/admin(\/|$)/.test(url.pathname)) {
      const gate = await adminGate(request, env, url);
      if (gate) return gate;
    }
    const context = { request, env, params: {}, waitUntil: (p) => ctx.waitUntil(p) };
    const path = url.pathname.replace(/\/+$/, "");
    const lm = path.match(/^\/logos\/([a-z]+)\.png$/);
    if (lm) return logo(lm[1], request, ctx);

    if (path === "/api/report") return request.method === "POST" ? report.onRequestPost(context) : report.onRequest(context);
    if (path === "/api/reports" && request.method === "GET") return reports.onRequestGet(context);
    if (path === "/api/stats" && request.method === "GET") return stats.onRequestGet(context);
    if (path === "/api/alert") return request.method === "POST" ? alert.onRequestPost(context) : new Response("Use POST.", { status: 405 });
    if (path === "/api/ask" && request.method === "POST") return ask.onRequestPost(context);
    if (path === "/api/alert/confirm") return alert.onConfirm(context);
    if (path === "/api/alert/stop") return alert.onStop(context);
    if (path === "/api/alerts" && request.method === "GET") return alert.onStats(context);
    const m = path.match(/^\/go\/([^/]+)$/);
    if (m && request.method === "GET") {
      context.params.provider = decodeURIComponent(m[1]);
      return go.onRequestGet(context);
    }
    return env.ASSETS.fetch(request);
  },
  // Daily, after the morning and evening rate checks: confirmation emails and rate alerts.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(alert.runAlerts(env).then((r) => console.log("alerts", JSON.stringify(r))));
  }
};
