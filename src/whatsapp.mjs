// Pure logic for the WhatsApp rate bot: parsing, reply formatting, phone hashing and the
// X-Hub-Signature-256 check. Used by functions/api/whatsapp.js and by the tests.
const AMOUNT_PAGES = { GBP: [100, 200, 250, 500, 1000, 2000], USD: [100, 200, 300, 500, 1000, 2000], CAD: [100, 250, 500, 1000, 2000], AUD: [100, 250, 500, 1000, 2000], EUR: [100, 250, 500, 1000, 2000] };

const SOURCES = [
  ["uk", /\b(uk|gb|united kingdom|great britain|britain|england|scotland|wales|gbp|pounds?|quid)\b/],
  ["us", /\b(us|usa|united states|america|american|usd|dollars?)\b/],
  ["canada", /\b(canada|canadian|cad)\b/],
  ["australia", /\b(australia|australian|aud)\b/],
  ["europe", /\b(europe|european|euro|eur|france|french|belgium|belgian|germany|german|italy|italian|spain|spanish|netherlands|dutch|portugal|portuguese|ireland|irish|austria|austrian)\b/]
];
const DESTINATIONS = [
  ["nigeria", /\b(nigeria|naija|ngn|naira)\b/],
  ["ghana", /\b(ghana|ghs|cedi|cedis)\b/],
  ["kenya", /\b(kenya|kenyan|kes)\b/],
  ["uganda", /\b(uganda|ugandan|ugx)\b/],
  ["zambia", /\b(zambia|zambian|zmw|kwacha)\b/],
  ["zimbabwe", /\b(zimbabwe|zimbabwean|zwl)\b/],
  ["egypt", /\b(egypt|egyptian|egp)\b/],
  ["morocco", /\b(morocco|moroccan|mad|dirham|dirhams)\b/],
  ["senegal", /\b(senegal|senegalese|xof|cfaf)\b/],
  ["ivorycoast", /\b(ivory coast|ivorycoast|cote d'ivoire|côte d'ivoire|ivorian)\b/],
  ["mali", /\b(mali|malian)\b/],
  ["cameroon", /\b(cameroon|cameroun|cameroonian|xaf)\b/],
  ["ethiopia", /\b(ethiopia|ethiopian|etb|birr)\b/],
  ["southafrica", /\b(south africa|southafrica|zar|rand)\b/],
  ["tanzania", /\b(tanzania|tanzanian|tzs)\b/],
  ["drc", /\b(drc|dr congo|democratic republic|congo|congolese|cdf)\b/],
  ["rwanda", /\b(rwanda|rwandan|rwf)\b/]
];

const CUR = { uk: "GBP", us: "USD", canada: "CAD", australia: "AUD", europe: "EUR" };
const CURNAME = { GBP: "£", USD: "$", CAD: "C$", AUD: "A$", EUR: "€" };

export function normalize(text) {
  return String(text || "").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

function parseAmount(str) {
  const m = String(str).replace(/,/g, "").match(/(\d+(?:\.\d+)?)([km])?/i);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] && m[2].toLowerCase() === "k" ? 1000 : m[2] && m[2].toLowerCase() === "m" ? 1000000 : 1);
  return n > 0 ? n : null;
}

// "UK Nigeria 300" -> { from: "uk", to: "nigeria", amount: 300 }
// "alert UK Nigeria 250 470000" -> { alert: true, amount: 250, target: 470000 }
// "stop" -> { stop: true }. Missing pieces set `need` to source / destination / amount.
export function parseMessage(raw) {
  const t = normalize(raw);
  if (!t) return { need: "source" };
  if (/^(stop|stop alerts|unsubscribe|delete my data|delete)\b/.test(t)) return { stop: true };

  const alert = /^alert\b/.test(t);
  const body = alert ? t.replace(/^alert\b/, "").trim() : t;

  let from = null;
  if (/£/.test(body)) from = "uk";
  else if (/€/.test(body)) from = "europe";
  else if (/c\$/.test(body)) from = "canada";
  else if (/a\$/.test(body)) from = "australia";
  else if (/\$/.test(body)) from = "us";
  if (!from) for (const [id, re] of SOURCES) if (re.test(body)) { from = id; break; }

  let to = null;
  for (const [id, re] of DESTINATIONS) if (re.test(body)) { to = id; break; }

  // Numbers in the text; the destination names never contain digits.
  const numbers = body.replace(/,/g, "").match(/\d+(?:\.\d+)?[km]?/gi) || [];
  const amount = numbers.length ? parseAmount(numbers[0]) : null;
  const target = alert && numbers.length > 1 ? parseAmount(numbers[1]) : null;

  if (alert) {
    const need = !from ? "source" : !to ? "destination" : !amount ? "amount" : !target ? "target" : null;
    return { alert: true, from, to, amount, target, need, fromCurrency: from ? CUR[from] : null };
  }
  const need = !from ? "source" : !to ? "destination" : !amount ? "amount" : null;
  return { from, to, amount, need, fromCurrency: from ? CUR[from] : null };
}

export function routeKey(from, to) { return `${from}-${to}`; }

export function routeUrl(from, to, amount, currency, origin = "") {
  const exact = (AMOUNT_PAGES[currency] || []).includes(Number(amount));
  return exact ? `${origin}/send-money/${from}-to-${to}/${Number(amount)}/?ref=wa` : `${origin}/send-money/${from}-to-${to}/?ref=wa`;
}

const money = (v, cur) => `${cur} ${Number(v).toLocaleString("en", { maximumFractionDigits: v >= 1000 ? 0 : 2, minimumFractionDigits: v >= 1000 ? 0 : 2 })}`;

export function formatReply({ fromLabel, toLabel, amount, currency, receiveCurrency, rows, checkedAt, url }) {
  const head = `${fromLabel} to ${toLabel} · ${CURNAME[currency] || currency}${Number(amount).toLocaleString("en")}`;
  if (!rows || !rows.length) return `${head}\n\nNo live prices for this route right now. See ${url}`;
  const top = rows.slice(0, 3);
  const lines = top.map((x, i) => `${i + 1}. ${x.p.name} — ${money(x.gets, receiveCurrency)}`);
  const best = top[0];
  const fee = best.ev.fee < 0.005 ? "no fee" : `fee ${money(best.ev.fee, currency)}`;
  const when = checkedAt ? new Date(checkedAt).toUTCString().replace(/:\d\d GMT$/, " UTC") : "just now";
  const text = `${head}\n${lines.join("\n")}\nBest: ${fee} · rate ${Number(best.ev.rate).toLocaleString("en", { maximumFractionDigits: 4 })}\nChecked ${when}\nFull comparison: ${url}`;
  return text.length > 990 ? text.slice(0, 987) + "…" : text;
}

export function askFor(parsed) {
  if (!parsed.from) return "Which country are you sending from? UK, US, Canada, Australia or Europe.";
  if (!parsed.to) return "Which country are you sending to? e.g. Nigeria, Ghana, Kenya.";
  if (parsed.alert && !parsed.amount) return "How much do you send? e.g. alert UK Nigeria 250 470000";
  if (parsed.alert && !parsed.target) return "What amount should they receive? e.g. alert UK Nigeria 250 470000";
  return "How much are you sending? e.g. UK Nigeria 300";
}

export async function hashPhone(phone, secret) {
  const data = new TextEncoder().encode(`wa:${secret || "sendfair"}:${phone}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// Meta signs the raw request body with the app secret: X-Hub-Signature-256: sha256=<hex>.
export async function verifySignature(secret, rawBody, header) {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7).toLowerCase();
  let same = true;
  for (let i = 0; i < hex.length; i++) same = same && hex[i] === given[i];
  return same;
}

export { AMOUNT_PAGES, CUR, CURNAME };
