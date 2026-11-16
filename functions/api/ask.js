// AI helper: a small chat that answers questions about rates, routes and house costs using the
// site's own live data, grounded through Cloudflare Workers AI. If the AI binding is missing it
// degrades gracefully instead of erroring.
import { json, sha256 } from "../_lib.js";
import R from "../../src/rank.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

async function load(env, origin, p) {
  try {
    const r = await env.ASSETS.fetch(new Request(origin + p));
    return r.ok ? r.json() : null;
  } catch { return null; }
}

function midRate(mid, a, b) {
  if (!mid || !mid.rates) return null;
  if (a === b) return 1;
  const ra = mid.rates[a], rb = mid.rates[b];
  return ra && rb ? rb / ra : null;
}

function rankRoute(list, feed, providers, amount, midr, now, hideH) {
  const rows = R.rank({ list, feed, providers, amount, payout: "all", mid: midr || null, now, staleH: 36, hideH });
  return rows.slice(0, 5).map((x) => ({
    name: x.p.name, rate: x.ev.rate, fee: x.ev.fee, gets: x.gets, payout: (x.q.payout || []).join(", ")
  }));
}

const SEND = [
  { id: "uk", re: /\b(uk|united kingdom|britain|british|england|gbp|pounds?)\b/i },
  { id: "canada", re: /\b(canada|canadian|cad)\b/i },
  { id: "australia", re: /\b(australia|australian|aud)\b/i },
  { id: "us", re: /\b(us|usa|u\.s\.?|united states|america|american|usd)\b/i },
  { id: "europe", re: /\b(europe|euro|euros|eur|eu|france|germany|italy|spain|ireland)\b/i },
];
const RECV = [
  ["nigeria", "nigeria|naira|ngn"], ["ghana", "ghana|cedi|ghs"], ["kenya", "kenya|kenyan|kes|m-pesa|mpesa"],
  ["uganda", "uganda|ugandan|ugx"], ["zambia", "zambia|zambian|zmw"], ["zimbabwe", "zimbabwe|zimbabw"],
  ["egypt", "egypt|egyptian|egp"], ["morocco", "morocco|moroccan|mad"], ["senegal", "senegal|senegalese|xof"],
  ["ivorycoast", "ivory coast|ivorycoast|cote d'ivoire|côte d'ivoire|ivorian"], ["mali", "mali|malian"],
  ["cameroon", "cameroon|cameroonian|xaf"], ["ethiopia", "ethiopia|ethiopian|etb"], ["southafrica", "south africa|southafrica|zar"],
  ["tanzania", "tanzania|tanzanian|tzs"], ["drc", "dr congo|drc|d\\.r\\. congo|congo"], ["rwanda", "rwanda|rwandan|rwf"],
];

function detect(question) {
  const q = " " + question.toLowerCase() + " ";
  let sender = null;
  for (const s of SEND) if (s.re.test(q)) { sender = s.id; break; }
  let receiver = null;
  for (const [id, pat] of RECV) if (new RegExp("\\b(" + pat + ")\\b", "i").test(q)) { receiver = id; break; }
  const m = question.match(/\d[\d,]*(?:\.\d+)?/);
  const amount = m ? parseFloat(m[0].replace(/,/g, "")) : null;
  return { sender, receiver, amount };
}

function grounding(corridors, quotes, mid, buildCosts, config, det, providers, feed, now, hideH, question) {
  const lines = [];
  const s = det.sender ? corridors.senders.find((x) => x.id === det.sender) : null;
  const r = det.receiver ? corridors.receivers.find((x) => x.id === det.receiver) : null;
  if (s && r) {
    const amount = det.amount || (config.defaultAmounts && config.defaultAmounts[s.currency]) || 250;
    const route = `${s.id}-${r.id}`;
    const midr = midRate(mid, s.currency, r.currency);
    const top = rankRoute((quotes.quotes || {})[route] || [], (feed || {})[route] || null, providers, amount, midr, now, hideH);
    lines.push(`Route: ${s.label} to ${r.name} for ${amount} ${s.currency}.`);
    if (midr && s.currency !== r.currency) lines.push(`Mid-market rate: 1 ${s.currency} = ${midr.toFixed(4)} ${r.currency}.`);
    if (top.length) {
      lines.push("Top services by amount received (use these numbers, do not change them):");
      top.forEach((x, i) => lines.push(`${i + 1}. ${x.name}: rate ${x.rate}, fee ${Math.round(x.fee)} ${s.currency}, recipient gets ${Math.round(x.gets)} ${r.currency}${x.payout ? " (" + x.payout + ")" : ""}`));
    } else {
      lines.push("No live quotes for this route right now.");
    }
    return lines.join("\n");
  }
  if (r && buildCosts && buildCosts.countries && buildCosts.countries[r.id]) {
    lines.push(`A house-cost estimate for ${r.name} is available on the calculator (a 3-bedroom bungalow; land and the contractor's fee are excluded). Direct the user to the calculator: /cost-to-build/${r.id}/`);
  } else if (/house|build|construct|bungalow|maisonette/i.test(question || "")) {
    lines.push("The user is asking about building a house. Direct them to the house calculator at /cost-to-build/ and explain it prices materials, trade days and the permit, and excludes land and the contractor's fee.");
  }
  lines.push("No specific route detected. Ask the user for a route and amount, e.g. 'UK to Kenya for 250', or a country to build in.");
  return lines.join("\n");
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = new URL(request.url).origin;
  let body = {};
  try { body = await request.json(); } catch {}
  const question = String(body.question || body.q || "").trim().slice(0, 500);
  if (!question) return json({ error: "Ask a question." }, 400);

  const reqOrigin = request.headers.get("Origin") || "";
  if (reqOrigin && reqOrigin !== "https://sendfair.africa") return json({ error: "Not allowed." }, 403);
  if (env.SENDFAIR_KV) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipKey = "rl:ask:" + (await sha256(ip)).slice(0, 16) + ":" + Math.floor(Date.now() / 3600000);
    const n = Number(await env.SENDFAIR_KV.get(ipKey) || 0);
    if (n >= 20) return json({ error: "Too many questions. Try again in an hour." }, 429);
    await env.SENDFAIR_KV.put(ipKey, String(n + 1), { expirationTtl: 3600 });
  }

  const [corridors, quotes, mid, buildCosts, config, providersFile, wiseFeed] = await Promise.all([
    load(env, origin, "/data/corridors.json"),
    load(env, origin, "/data/quotes.json"),
    load(env, origin, "/data/midmarket.json"),
    load(env, origin, "/data/build-costs.json"),
    load(env, origin, "/data/site.json"),
    load(env, origin, "/data/providers.json"),
    load(env, origin, "/data/wise-feed.json"),
  ]);
  const providers = Object.fromEntries(((providersFile || {}).providers || []).map((p) => [p.id, p]));
  const feed = (wiseFeed || {}).routes || {};
  const hideH = (config || {}).hideAfterHours || 72;
  const det = detect(question);
  const g = grounding(corridors || { senders: [], receivers: [] }, quotes || { quotes: {} }, mid, buildCosts, config || {}, det, providers, feed, Date.now(), hideH, question);

  if (!env.AI) {
    return json({ answer: "I can help with rates and house costs. Try asking about a specific route, for example: \"UK to Kenya for 250\", or \"how much to build a house in Nigeria\"." });
  }
  try {
    const res = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: "You are SendFair's friendly assistant. SendFair compares money transfers to Africa by the amount that actually arrives (after fees and the exchange-rate markup), and estimates the cost to build a house back home. Answer using ONLY the live data below. Never invent a rate, fee or provider. If the data is missing, say so and suggest opening the calculator on sendfair.africa. Keep answers to 1-3 short sentences.\n\nLIVE DATA:\n" + g },
        { role: "user", content: question },
      ],
      max_tokens: 512,
    });
    return json({ answer: String(res.response || res || "").trim() });
  } catch (e) {
    console.log("ai failed", e && (e.message || e.code));
    return json({ answer: "Sorry, I couldn't reach the AI just now. Try asking about a specific route, for example: \"UK to Kenya for 250\"." });
  }
}
