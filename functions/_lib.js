// Shared helpers for SendFair's Cloudflare Pages Functions.
// Storage: a KV namespace bound as SENDFAIR_KV (Pages project > Settings > Functions > KV namespace bindings).
// Every function still works without it: clicks redirect without counting, reports answer "not switched on yet".

export const BUCKETS = { under1h: "Under 1 hour", sameday: "Same day", "1to2days": "1–2 days", longer: "Longer than 2 days" };

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...headers }
  });
}

export async function siteData(context) {
  const get = async (p) => {
    const res = await context.env.ASSETS.fetch(new URL(p, context.request.url));
    if (!res.ok) throw new Error(p);
    return res.json();
  };
  const [corridors, providers] = await Promise.all([get("/data/corridors.json"), get("/data/providers.json")]);
  const routes = new Set(corridors.senders.flatMap((s) => corridors.receivers.map((r) => `${s.id}-${r.id}`)));
  const pmap = Object.fromEntries(providers.providers.map((p) => [p.id, p]));
  return { routes, pmap };
}

export function month(offset = 0, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 7);
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
