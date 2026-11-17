// WhatsApp Business Cloud API webhook.
//   GET  /api/whatsapp   hub.mode=subscribe & hub.verify_token & hub.challenge  -> echo the challenge
//   POST /api/whatsapp   X-Hub-Signature-256 (HMAC of the raw body with the app secret) -> reply
// Secrets live in Cloudflare: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET,
// WHATSAPP_VERIFY_TOKEN, WHATSAPP_HASH_SALT (optional: WHATSAPP_ALERT_TEMPLATE, WHATSAPP_TEMPLATE_LANG).
import { json } from "../_lib.js";
import { parseMessage, formatReply, askFor, hashPhone, verifySignature, routeKey, routeUrl } from "../../src/whatsapp.mjs";
import { loadData, routeName } from "./alert.js";
import { sendText } from "../whatsapp-lib.js";
import R from "../../src/rank.js";

const DAY = 86400;
const money = (v, cur) => `${cur} ${Number(v).toLocaleString("en", { maximumFractionDigits: v >= 1000 ? 0 : 2, minimumFractionDigits: v >= 1000 ? 0 : 2 })}`;

export function onVerify(context) {
  const u = new URL(context.request.url);
  const mode = u.searchParams.get("hub.mode"), token = u.searchParams.get("hub.verify_token"), challenge = u.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === context.env.WHATSAPP_VERIFY_TOKEN) return new Response(challenge || "", { status: 200 });
  return new Response("Forbidden", { status: 403 });
}

export async function onWebhook(context) {
  const { request, env, waitUntil } = context;
  const raw = await request.text();
  if (!(await verifySignature(env.WHATSAPP_APP_SECRET, raw, request.headers.get("X-Hub-Signature-256") || ""))) {
    return new Response("Forbidden", { status: 403 });
  }
  let body = {};
  try { body = JSON.parse(raw); } catch { return json({ ok: true }); }
  const origin = new URL(request.url).origin;
  for (const entry of body.entry || []) for (const change of entry.changes || []) {
    const value = change.value || {};
    for (const msg of value.messages || []) {
      if (!msg.from) continue;
      if (msg.type === "text" && msg.text && msg.text.body) {
        waitUntil(handle(env, origin, msg.from, msg.text.body).catch((e) => console.log("whatsapp handle", e && e.message)));
      } else {
        waitUntil(sendText(env, msg.from, "Send a text like: UK Nigeria 300").catch(() => {}));
      }
    }
  }
  // Meta retries anything that is not 2xx; the reply happens in the background.
  return json({ ok: true });
}

async function handle(env, origin, phone, text) {
  const kv = env.SENDFAIR_KV;
  if (!kv) return;
  // The user is identified by a hash of the number; only an active alert keeps the number itself,
  // because Meta needs it to deliver that alert.
  const hash = await hashPhone(phone, env.WHATSAPP_HASH_SALT || env.WHATSAPP_APP_SECRET || "sendfair");
  const parsed = parseMessage(text);

  if (parsed.stop) {
    let cursor;
    do {
      const page = await kv.list({ prefix: `alert:${hash}:`, cursor });
      for (const k of page.keys) await kv.delete(k.name);
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    await sendText(env, phone, "Done. Your WhatsApp alerts are deleted, and with them the number we held to send them.");
    return;
  }

  if (parsed.need) { await sendText(env, phone, askFor(parsed)); return; }

  const route = routeKey(parsed.from, parsed.to);
  let data;
  try { data = await loadData(env, origin); } catch { await sendText(env, phone, "The rate data is unavailable right now. Try again shortly."); return; }
  const known = data.corridors.senders.some((s) => s.id === parsed.from) && data.corridors.receivers.some((r) => r.id === parsed.to);
  if (!known) { await sendText(env, phone, "That route isn't on SendFair yet. Try UK Nigeria 300."); return; }
  const rn = routeName(route, data);

  if (parsed.alert) {
    if (!(parsed.amount > 0 && parsed.amount <= 100000)) { await sendText(env, phone, "The amount you send must be between 1 and 100,000."); return; }
    if (!(parsed.target > 0)) { await sendText(env, phone, "Send it like: alert UK Nigeria 250 470000 (amount you send, then the amount they should get)."); return; }
    const mine = await kv.list({ prefix: `alert:${hash}:` });
    if (mine.keys.length >= 10) { await sendText(env, phone, "You already have 10 alerts. Send STOP to clear them."); return; }
    const id = `${hash}:${crypto.randomUUID().slice(0, 8)}`;
    const a = { id, phoneHash: hash, phone, route, amount: parsed.amount, target: parsed.target, channel: "whatsapp", confirmed: true, createdAt: new Date().toISOString() };
    await kv.put(`alert:${id}`, JSON.stringify(a), { expirationTtl: 365 * DAY });
    await sendText(env, phone, `Alert set. We'll message you once when ${money(parsed.amount, rn.s.currency)} from ${rn.s.short} to ${rn.r.name} delivers at least ${money(parsed.target, rn.r.currency)}. Send STOP to remove it.`);
    return;
  }

  const mid = R.midRate(data.midmarket, rn.s.currency, rn.r.currency);
  const rows = R.rank({
    list: (data.quotes.quotes || {})[route] || [], feed: (data.feed || {})[route] || null, providers: data.providers,
    amount: parsed.amount, payout: "all", mid: mid || null, now: Date.now(), staleH: 36, hideH: 72
  }).filter((x) => !x.stale);
  const url = routeUrl(parsed.from, parsed.to, parsed.amount, rn.s.currency, origin);
  const reply = formatReply({ fromLabel: rn.s.short, toLabel: rn.r.name, amount: parsed.amount, currency: rn.s.currency, receiveCurrency: rn.r.currency, rows, checkedAt: data.quotes.updatedAt, url });
  await sendText(env, phone, reply);
}
