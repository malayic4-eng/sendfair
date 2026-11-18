/* Payment providers behind one interface.
   test   - a clearly labelled test checkout, for review and automated tests
   paystack   - Kenya-based merchant, cards and local methods
   flutterwave - cards and local methods across Africa

   The webhook is only a notification. Every payment is verified with the provider's
   own verify endpoint before a report is released. */

import { priceFor } from "../../src/quote-check/config.mjs";
import { constantTimeEqual } from "./bytes.js";

const DAY = 86400;

export const PROVIDERS = {
  test: { id: "test", label: "Test mode", supported: ["KES", "NGN", "GHS", "USD", "GBP", "EUR"] },
  paystack: { id: "paystack", label: "Paystack", supported: ["NGN", "GHS", "ZAR", "KES", "USD"] },
  flutterwave: { id: "flutterwave", label: "Flutterwave", supported: ["NGN", "GHS", "KES", "ZAR", "UGX", "TZS", "RWF", "ZMW", "XOF", "XAF", "EGP", "MAD", "ETB", "CDF", "USD", "GBP", "EUR"] }
};

export function providerFor(env, settings, id) {
  const key = String(id || "").toLowerCase();
  if (!PROVIDERS[key]) return null;
  return { ...PROVIDERS[key], env, settings };
}

export function resolveCharge(settings, quoteCurrency, providerId) {
  const base = priceFor(settings, quoteCurrency);
  const provider = PROVIDERS[providerId] || PROVIDERS.test;
  if (provider.supported.includes(base.currency)) return base;
  const usd = settings.prices && settings.prices.USD;
  if (provider.supported.includes("USD") && usd > 0) return { currency: "USD", amount: usd };
  for (const cur of provider.supported) {
    if (settings.prices && settings.prices[cur] > 0) return { currency: cur, amount: settings.prices[cur] };
  }
  return base;
}

function reference(orderId) {
  return `qc_${orderId}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

async function fetchJson(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      const err = new Error(`The payment provider returned HTTP ${res.status}.`);
      err.code = "payment_http";
      err.status = res.status;
      err.body = text.slice(0, 500);
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function secret(env, name) {
  return String(env[name] || "");
}

export async function initCheckout({ env, settings, providerId, order, origin }) {
  const provider = providerFor(env, settings, providerId);
  if (!provider) throw Object.assign(new Error("Unknown payment provider."), { code: "payment_provider" });
  const charge = resolveCharge(settings, order.quoteCurrency, providerId);
  const ref = reference(order.id);
  const callback = `${origin}/quote-check/report/${order.token}/?paid=1`;

  if (providerId === "test") {
    return {
      url: `${origin}/quote-check/pay/test/${order.id}/?t=${order.token}`,
      reference: ref,
      amount: charge.amount,
      currency: charge.currency,
      provider: "test"
    };
  }

  if (providerId === "paystack") {
    const key = secret(env, "PAYSTACK_SECRET_KEY");
    if (!key) throw Object.assign(new Error("Paystack is not configured."), { code: "payment_not_configured" });
    const data = await fetchJson("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        email: order.email,
        amount: Math.round(charge.amount * 100),
        currency: charge.currency,
        reference: ref,
        callback_url: callback,
        metadata: { orderId: order.id, service: "SendFair Quote Check" }
      })
    });
    if (!data || !data.status || !data.data || !data.data.authorization_url) {
      throw Object.assign(new Error("Paystack did not return a checkout link."), { code: "payment_init" });
    }
    return { url: data.data.authorization_url, reference: ref, amount: charge.amount, currency: charge.currency, provider: "paystack" };
  }

  if (providerId === "flutterwave") {
    const key = secret(env, "FLUTTERWAVE_SECRET_KEY");
    if (!key) throw Object.assign(new Error("Flutterwave is not configured."), { code: "payment_not_configured" });
    const data = await fetchJson("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        tx_ref: ref,
        amount: charge.amount,
        currency: charge.currency,
        redirect_url: callback,
        customer: { email: order.email },
        customizations: { title: "SendFair Quote Check", description: `${order.countryName} quote report` },
        meta: { orderId: order.id }
      })
    });
    if (!data || data.status !== "success" || !data.data || !data.data.link) {
      throw Object.assign(new Error("Flutterwave did not return a checkout link."), { code: "payment_init" });
    }
    return { url: data.data.link, reference: ref, amount: charge.amount, currency: charge.currency, provider: "flutterwave" };
  }

  throw Object.assign(new Error("Unknown payment provider."), { code: "payment_provider" });
}

/* Returns the reference and event type only after the signature checks out. */
export async function verifyNotification({ env, providerId, request, rawBody }) {
  if (providerId === "paystack") {
    const key = secret(env, "PAYSTACK_SECRET_KEY");
    if (!key) return { ok: false, reason: "not_configured" };
    const signature = request.headers.get("x-paystack-signature") || "";
    const expected = await hmacHex(key, rawBody);
    if (!constantTimeEqual(signature.toLowerCase(), expected.toLowerCase())) return { ok: false, reason: "bad_signature" };
    let body;
    try { body = JSON.parse(rawBody); } catch { return { ok: false, reason: "bad_json" }; }
    if (body.event !== "charge.success") return { ok: false, ignore: true, reason: body.event || "ignored" };
    const ref = body.data && body.data.reference;
    if (!ref) return { ok: false, reason: "no_reference" };
    return { ok: true, reference: ref, event: body.event };
  }
  if (providerId === "flutterwave") {
    const hash = secret(env, "FLUTTERWAVE_SECRET_HASH");
    if (!hash) return { ok: false, reason: "not_configured" };
    const given = request.headers.get("verif-hash") || "";
    if (!constantTimeEqual(given, hash)) return { ok: false, reason: "bad_signature" };
    let body;
    try { body = JSON.parse(rawBody); } catch { return { ok: false, reason: "bad_json" }; }
    const data = body.data || {};
    if (data.status && data.status !== "successful") return { ok: false, ignore: true, reason: data.status };
    const ref = data.tx_ref;
    if (!ref) return { ok: false, reason: "no_reference" };
    return { ok: true, reference: ref, event: body.event || "charge.completed" };
  }
  return { ok: false, reason: "unsupported_provider" };
}

export async function verifyTransaction({ env, providerId, reference: ref, expectedAmount, currency }) {
  if (providerId === "paystack") {
    const key = secret(env, "PAYSTACK_SECRET_KEY");
    if (!key) return { ok: false, reason: "not_configured" };
    const data = await fetchJson(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${key}` }
    }).catch(() => null);
    const d = data && data.data;
    if (!data || !data.status || !d) return { ok: false, reason: "verify_failed" };
    const amount = Number(d.amount) / 100;
    const cur = String(d.currency || "").toUpperCase();
    if (d.status !== "success") return { ok: false, reason: "not_successful", status: d.status };
    if (cur !== String(currency).toUpperCase()) return { ok: false, reason: "currency_mismatch", currency: cur };
    if (!(amount + 0.005 >= Number(expectedAmount))) return { ok: false, reason: "amount_mismatch", amount };
    return { ok: true, amount, currency: cur, reference: ref };
  }
  if (providerId === "flutterwave") {
    const key = secret(env, "FLUTTERWAVE_SECRET_KEY");
    if (!key) return { ok: false, reason: "not_configured" };
    const data = await fetchJson(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${key}` }
    }).catch(() => null);
    const d = data && data.data;
    if (!data || data.status !== "success" || !d) return { ok: false, reason: "verify_failed" };
    const amount = Number(d.amount);
    const cur = String(d.currency || "").toUpperCase();
    if (String(d.status).toLowerCase() !== "successful") return { ok: false, reason: "not_successful", status: d.status };
    if (cur !== String(currency).toUpperCase()) return { ok: false, reason: "currency_mismatch", currency: cur };
    if (!(amount + 0.005 >= Number(expectedAmount))) return { ok: false, reason: "amount_mismatch", amount };
    return { ok: true, amount, currency: cur, reference: ref };
  }
  return { ok: false, reason: "unsupported_provider" };
}

export async function rememberReference(env, ref, orderId, info = {}) {
  if (!env.SENDFAIR_KV) return;
  await env.SENDFAIR_KV.put(`qc:pay:${ref}`, JSON.stringify({ orderId, amount: info.amount, currency: info.currency }), { expirationTtl: 3 * DAY });
}

export async function referenceInfo(env, ref) {
  if (!env.SENDFAIR_KV) return null;
  const raw = await env.SENDFAIR_KV.get(`qc:pay:${ref}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.orderId) return parsed;
  } catch {
    // Older entries stored the order id directly.
  }
  return { orderId: raw };
}

export async function orderIdForReference(env, ref) {
  const info = await referenceInfo(env, ref);
  return info ? info.orderId : null;
}
