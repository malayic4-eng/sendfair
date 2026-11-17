// Built site JSON (quotes, feed, providers, corridors, mid-market, site settings), read from Workers Assets
// with a 60-second isolate cache. Shared by the share image (og-worker.js) and the embed widget.
let DATA = { at: 0, value: null };
export async function loadData(env, origin) {
  if (DATA.value && Date.now() - DATA.at < 60000) return DATA.value;
  const get = async (p) => { const r = await env.ASSETS.fetch(new Request(origin + p)); return r.ok ? r.json() : null; };
  const [quotes, feed, providers, corridors, midmarket, site] = await Promise.all([
    get("/data/quotes.json"), get("/data/wise-feed.json"), get("/data/providers.json"),
    get("/data/corridors.json"), get("/data/midmarket.json"), get("/data/site.json")
  ]);
  DATA = { at: Date.now(), value: { quotes, feed, providers, corridors, midmarket, site: site || {} } };
  return DATA.value;
}

