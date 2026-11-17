// GET /cost-to-build/<country>/plan/<id>/ — render the frozen plan from KV, noindex.
import { planPage } from "./plan-page.mjs";

let LOGO = "";
async function logo(env, request) {
  if (LOGO) return LOGO;
  try {
    const r = await env.ASSETS.fetch(new Request(new URL("/favicon.svg", request.url)));
    if (r.ok) LOGO = await r.text();
  } catch {}
  return LOGO;
}

export async function planResponse(country, id, request, env) {
  const kv = env.SENDFAIR_KV;
  if (!kv) return new Response("Plans are not available.", { status: 503 });
  const raw = await kv.get("plan:" + id);
  if (!raw) return new Response("Plan not found.", { status: 404 });
  let plan;
  try { plan = JSON.parse(raw); } catch { return new Response("Plan not found.", { status: 404 }); }
  if (plan.country !== country) return new Response("Plan not found.", { status: 404 });
  const html = planPage({ plan, logo: await logo(env, request), site: new URL(request.url).origin });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
