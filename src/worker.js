// Cloudflare Worker entry for SendFair.
// Static pages and data are served from dist/ by Workers static assets. This script runs first so it can
// forward www to the main address, then handles /api/report, /api/reports, /api/stats and /go/<provider>. The handlers live in functions/.
import * as report from "../functions/api/report.js";
import * as reports from "../functions/api/reports.js";
import * as stats from "../functions/api/stats.js";
import * as go from "../functions/go/[provider].js";
import * as alert from "../functions/api/alert.js";

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname === "www.sendfair.africa") {
      url.hostname = "sendfair.africa";
      return Response.redirect(url.toString(), 301);
    }
    // The Rate Desk is private: it asks for a password set in Cloudflare as the secret ADMIN_PASSWORD.
    if (/^\/admin(\/|$)/.test(url.pathname)) {
      const denied = (msg) => new Response(msg, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="SendFair Rate Desk", charset="UTF-8"', "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
      if (!env.ADMIN_PASSWORD) return denied("The Rate Desk is locked. Add the secret ADMIN_PASSWORD in Cloudflare to open it.");
      const auth = request.headers.get("Authorization") || "";
      let pass = "";
      try { pass = auth.startsWith("Basic ") ? atob(auth.slice(6)).split(":").slice(1).join(":") : ""; } catch (e) {}
      const a = new TextEncoder().encode(pass), b = new TextEncoder().encode(env.ADMIN_PASSWORD);
      let same = a.length === b.length;
      for (let i = 0; i < b.length; i++) same = same && a[i] === b[i];
      if (!same) return denied("Password needed for the Rate Desk.");
    }
    const context = { request, env, params: {}, waitUntil: (p) => ctx.waitUntil(p) };
    const path = url.pathname.replace(/\/+$/, "");
    const lm = path.match(/^\/logos\/([a-z]+)\.png$/);
    if (lm) return logo(lm[1], request, ctx);

    if (path === "/api/report") return request.method === "POST" ? report.onRequestPost(context) : report.onRequest(context);
    if (path === "/api/reports" && request.method === "GET") return reports.onRequestGet(context);
    if (path === "/api/stats" && request.method === "GET") return stats.onRequestGet(context);
    if (path === "/api/alert") return request.method === "POST" ? alert.onRequestPost(context) : new Response("Use POST.", { status: 405 });
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
