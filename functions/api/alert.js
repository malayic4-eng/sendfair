// Rate alerts.
//   POST /api/alert            { email, route, amount, target }  -> saves an alert and sends a confirmation email
//   GET  /api/alert/confirm    ?id=&t=                            -> confirms it
//   GET  /api/alert/stop       ?id=&t=                            -> deletes it (link in every email)
//   GET  /api/alerts           ?key=STATS_KEY                     -> counts, for the owner
// An alert fires once: when the best service on the route delivers at least `target` for `amount`.
// Emails are sent through Cloudflare Email Service (binding EMAIL). Without it, the sign-up fails
// honestly with a 503 so the visitor is never left waiting for a confirmation that can't be sent.
import { json, siteData, sha256 } from "../_lib.js";
import R from "../../src/rank.js";

const FROM = { email: "hello@sendfair.africa", name: "SendFair rate alerts" };
const DAY = 86400;

const page = (title, body) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<body style="font:17px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 18px;color:#151b45"><h1 style="font-size:1.6rem">${title}</h1><p>${body}</p><p><a href="/">Back to SendFair</a></p></body>`,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });

const money = (v, cur) => `${cur} ${Number(v).toLocaleString("en", { maximumFractionDigits: v >= 1000 ? 0 : 2, minimumFractionDigits: v >= 1000 ? 0 : 2 })}`;
const routeName = (route, data) => {
  const [a, b] = route.split("-");
  const s = data.corridors.senders.find((x) => x.id === a), r = data.corridors.receivers.find((x) => x.id === b);
  return { s, r, label: `${s.label} to ${r.name}`, path: `/send-money/${a}-to-${b}/` };
};

export async function sendMail(env, msg) {
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") return false;
  try { await env.EMAIL.send({ from: FROM, ...msg }); return true; } catch (e) { console.log("email failed", e && (e.code || e.message)); return false; }
}

async function loadData(env, origin) {
  const get = async (p) => (await env.ASSETS.fetch(new Request(origin + p))).json();
  const [corridors, quotes, providersFile, midmarket, wiseFeed] = await Promise.all([
    get("/data/corridors.json"), get("/data/quotes.json"), get("/data/providers.json"),
    get("/data/midmarket.json"), get("/data/wise-feed.json").catch(() => ({ routes: {} }))
  ]);
  const providers = Object.fromEntries(((providersFile || {}).providers || []).map((p) => [p.id, p]));
  return { corridors, quotes, providers, midmarket, feed: (wiseFeed || {}).routes || {} };
}

// Most that arrives on a route for `amount`, using the shared ranking engine.
export function bestFor(data, route, amount, now = Date.now()) {
  const rn = routeName(route, data);
  const m = R.midRate(data.midmarket, rn.s.currency, rn.r.currency);
  const rows = R.rank({ list: (data.quotes.quotes || {})[route] || [], feed: (data.feed || {})[route] || null, providers: data.providers, amount, payout: "all", mid: m || null, now, staleH: 36, hideH: 72 });
  const lead = R.leaders(rows);
  return lead.length ? { gets: lead[0].gets, provider: lead[0].p.name } : null;
}

function confirmMail(a, origin, rn) {
  const link = `${origin}/api/alert/confirm?id=${a.id}&t=${a.token}`;
  const stop = `${origin}/api/alert/stop?id=${a.id}&t=${a.token}`;
  return {
    to: a.email,
    subject: `Confirm your SendFair alert: ${rn.label}`,
    text: `Please confirm your rate alert.\n\nWe'll email you once when sending ${money(a.amount, rn.s.currency)} from ${rn.s.short} to ${rn.r.name} delivers at least ${money(a.target, rn.r.currency)} with the best service we check.\n\nConfirm: ${link}\n\nDidn't ask for this? Ignore this email or remove it: ${stop}\n\nSendFair, sendfair.africa`,
    html: `<p>Please confirm your rate alert.</p><p>We'll email you once when sending <b>${money(a.amount, rn.s.currency)}</b> from ${rn.s.short} to ${rn.r.name} delivers at least <b>${money(a.target, rn.r.currency)}</b> with the best service we check.</p><p><a href="${link}" style="background:#1b2470;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;display:inline-block">Confirm my alert</a></p><p style="color:#5c6287;font-size:13px">Didn't ask for this? Ignore this email or <a href="${stop}">remove it</a>. SendFair, sendfair.africa</p>`
  };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const kv = env.SENDFAIR_KV;
  if (!kv) return json({ error: "Alerts are not switched on yet." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Send the alert as JSON." }, 400); }
  const email = String(body.email || "").trim().toLowerCase();
  const route = String(body.route || "");
  const amount = Number(body.amount), target = Number(body.target);
  if (env.TURNSTILE_SECRET) {
    const token = String(body.turnstile || body["cf-turnstile-response"] || "");
    if (!token) return json({ error: "Please complete the captcha." }, 400);
    const vr = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token })
    }).then((r) => r.json()).catch(() => null);
    if (!vr || !vr.success) return json({ error: "Captcha failed. Try again." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) return json({ error: "Enter a valid email address." }, 400);
  if (!(amount > 0 && amount <= 100000)) return json({ error: "Enter the amount you plan to send." }, 400);
  if (!(target > 0)) return json({ error: "Enter the amount you want them to receive." }, 400);

  let data;
  try { data = await siteData(context); } catch { return json({ error: "Site data is unavailable. Try again shortly." }, 503); }
  if (!data.routes.has(route)) return json({ error: "Unknown route." }, 400);

  // Limits: 10 sign-ups per visitor per day (only a hash of the IP is kept), 10 alerts per email.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rl = "arl:" + (await sha256(`${ip}|${new Date().toISOString().slice(0, 10)}`));
  const n = Number((await kv.get(rl)) || 0);
  if (n >= 10) return json({ error: "Too many alerts from this connection today. Try again tomorrow." }, 429);
  await kv.put(rl, String(n + 1), { expirationTtl: 2 * DAY });
  const eh = (await sha256(email)).slice(0, 16);
  const mine = await kv.list({ prefix: `alert:${eh}:` });
  if (mine.keys.length >= 10) return json({ error: "You already have 10 alerts. Remove one from an alert email first." }, 400);

  const id = `${eh}:${crypto.randomUUID().slice(0, 8)}`;
  const token = crypto.randomUUID().replace(/-/g, "");
  const a = { id, email, route, amount, target, token, confirmed: false, confirmSent: false, createdAt: new Date().toISOString() };
  const origin = new URL(request.url).origin;

  // The public form promises a confirmation email, so be honest when we can't send one.
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
    return json({ error: "Email alerts aren't available yet. Please try again later." }, 503);
  }

  const full = await loadData(env, origin).catch(() => null);
  if (full) a.confirmSent = await sendMail(env, confirmMail(a, origin, routeName(route, full)));
  if (!a.confirmSent) {
    return json({ error: "Email alerts aren't available yet. Please try again later." }, 503);
  }

  await kv.put(`alert:${id}`, JSON.stringify(a), { expirationTtl: 7 * DAY });
  return json({ ok: true, pending: !a.confirmSent });
}

async function withAlert(context, fn) {
  const kv = context.env.SENDFAIR_KV;
  const u = new URL(context.request.url);
  const id = u.searchParams.get("id") || "", t = u.searchParams.get("t") || "";
  if (!kv || !id) return page("Link not recognised", "This alert link is incomplete or has expired.");
  const raw = await kv.get(`alert:${id}`);
  if (!raw) return page("Alert not found", "This alert has already been removed or has fired.");
  const a = JSON.parse(raw);
  if (a.token !== t) return page("Link not recognised", "This alert link is incomplete or has expired.");
  return fn(a, kv);
}

export function onConfirm(context) {
  return withAlert(context, async (a, kv) => {
    a.confirmed = true;
    await kv.put(`alert:${a.id}`, JSON.stringify(a), { expirationTtl: 365 * DAY });
    return page("Alert confirmed", "Thank you. We'll email you once, after one of our daily rate checks, when your target is reached. Every email has a link to remove the alert.");
  });
}

export function onStop(context) {
  return withAlert(context, async (a, kv) => {
    await kv.delete(`alert:${a.id}`);
    return page("Alert removed", "We won't email you about this alert again, and your email address has been deleted with it.");
  });
}

export async function onStats(context) {
  const { env, request } = context;
  const auth = request.headers.get("Authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.STATS_KEY || key !== env.STATS_KEY) return json({ error: "Not allowed." }, 403);
  if (!env.SENDFAIR_KV) return json({ error: "Storage is not switched on." }, 503);
  const byRoute = {};
  let confirmed = 0, total = 0, cursor;
  do {
    const page = await env.SENDFAIR_KV.list({ prefix: "alert:", cursor });
    for (const k of page.keys) {
      const a = JSON.parse((await env.SENDFAIR_KV.get(k.name)) || "{}");
      byRoute[a.route] = (byRoute[a.route] || 0) + 1;
      if (a.confirmed) confirmed++;
      total++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return json({ total, confirmed, emailSending: !!env.EMAIL, byRoute });
}

// Runs from the Worker's daily schedule: sends pending confirmation emails and fires reached alerts.
export async function runAlerts(env, origin = "https://sendfair.africa") {
  const kv = env.SENDFAIR_KV;
  if (!kv) return { skipped: "no storage" };
  const data = await loadData(env, origin);
  let fired = 0, confirmations = 0, cursor;
  do {
    const page_ = await kv.list({ prefix: "alert:", cursor });
    for (const k of page_.keys) {
      const raw = await kv.get(k.name); if (!raw) continue;
      const a = JSON.parse(raw);
      const rn = routeName(a.route, data);
      if (!a.confirmed) {
        if (!a.confirmSent && (await sendMail(env, confirmMail(a, origin, rn)))) { a.confirmSent = true; confirmations++; await kv.put(k.name, JSON.stringify(a), { expirationTtl: 7 * DAY }); }
        continue;
      }
      const best = bestFor(data, a.route, a.amount);
      if (!best || best.gets < a.target) continue;
      const stop = `${origin}/api/alert/stop?id=${a.id}&t=${a.token}`;
      const ok = await sendMail(env, {
        to: a.email,
        subject: `Rate alert: ${money(best.gets, rn.r.currency)} for ${money(a.amount, rn.s.currency)} today`,
        text: `Good news: sending ${money(a.amount, rn.s.currency)} from ${rn.s.short} to ${rn.r.name} now delivers ${money(best.gets, rn.r.currency)} with the best service we checked today, above your target of ${money(a.target, rn.r.currency)}.\n\nCompare today's rates: ${origin}${rn.path}\n\nRates change during the day, so confirm the final amount on the provider's site. This alert has now been used; set a new one any time on the page above.\n\nRemove: ${stop}\nSendFair, sendfair.africa`,
        html: `<p>Good news: sending <b>${money(a.amount, rn.s.currency)}</b> from ${rn.s.short} to ${rn.r.name} now delivers <b>${money(best.gets, rn.r.currency)}</b> with the best service we checked today, above your target of ${money(a.target, rn.r.currency)}.</p><p><a href="${origin}${rn.path}" style="background:#1b2470;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;display:inline-block">Compare today's rates</a></p><p style="color:#5c6287;font-size:13px">Rates change during the day, so confirm the final amount on the provider's site. This alert has now been used; set a new one any time. <a href="${stop}">Remove my email</a>. SendFair, sendfair.africa</p>`
      });
      if (ok) { await kv.delete(k.name); fired++; }
    }
    cursor = page_.list_complete ? null : page_.cursor;
  } while (cursor);
  return { fired, confirmations };
}
