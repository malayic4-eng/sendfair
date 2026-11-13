// Cloudflare Worker entry for SendFair.
// Static pages and data are served from dist/ by Workers static assets. This script runs first so it can
// forward www to the main address, then handles /api/report, /api/reports, /api/stats and /go/<provider>. The handlers live in functions/.
import * as report from "../functions/api/report.js";
import * as reports from "../functions/api/reports.js";
import * as stats from "../functions/api/stats.js";
import * as go from "../functions/go/[provider].js";
import * as alert from "../functions/api/alert.js";

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
