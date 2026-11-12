// Cloudflare Worker entry for SendFair.
// Static pages and data are served from dist/ by Workers static assets; this script only runs for
// paths with no file: /api/report, /api/reports, /api/stats and /go/<provider>. The handlers live in functions/.
import * as report from "../functions/api/report.js";
import * as reports from "../functions/api/reports.js";
import * as stats from "../functions/api/stats.js";
import * as go from "../functions/go/[provider].js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const context = { request, env, params: {}, waitUntil: (p) => ctx.waitUntil(p) };
    const path = url.pathname.replace(/\/+$/, "");

    if (path === "/api/report") return request.method === "POST" ? report.onRequestPost(context) : report.onRequest(context);
    if (path === "/api/reports" && request.method === "GET") return reports.onRequestGet(context);
    if (path === "/api/stats" && request.method === "GET") return stats.onRequestGet(context);
    const m = path.match(/^\/go\/([^/]+)$/);
    if (m && request.method === "GET") {
      context.params.provider = decodeURIComponent(m[1]);
      return go.onRequestGet(context);
    }
    return env.ASSETS.fetch(request);
  }
};
