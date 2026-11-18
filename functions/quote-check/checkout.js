// POST /api/quote-check/checkout  { order, token }
// Starts a payment with the configured provider and returns its checkout URL.

import { json } from "../_lib.js";
import { loadSettings, enabled, paymentProviderId, testMode as isTestMode } from "./settings.js";
import { getOrder, putOrder } from "./store.js";
import { initCheckout, rememberReference } from "./payments.js";
import { constantTimeEqual } from "./bytes.js";

export async function onRequestPost(context) {
  const { env, request } = context;
  const settings = await loadSettings(env, request).catch(() => null);
  if (!settings) return json({ error: "Quote Check is not available right now." }, 503);
  if (!enabled(env, settings.config)) return json({ error: "Quote Check is switched off." }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Send the order as JSON." }, 400); }
  const order = await getOrder(env, String(body.order || ""));
  if (!order || !constantTimeEqual(order.token, String(body.token || ""))) return json({ error: "Order not found." }, 404);
  if (order.status === "refunded") return json({ error: "This order was refunded." }, 400);
  if (order.status === "paid" || order.status === "report sent") {
    return json({ ok: true, url: `/quote-check/report/${order.token}/`, alreadyPaid: true });
  }

  const providerId = paymentProviderId(env, settings.config);
  if (providerId === "test" && !isTestMode(env, settings.config)) {
    return json({ error: "A live payment provider is not configured yet. Set PAYMENT_PROVIDER to paystack or flutterwave." }, 503, { code: "payment_not_configured" });
  }
  const existing = order.payment;
  if (existing && existing.status === "pending" && existing.checkoutUrl && existing.createdAt) {
    const age = Date.now() - new Date(existing.createdAt).getTime();
    if (age >= 0 && age < 25 * 60 * 1000 && existing.provider === providerId) {
      return json({ ok: true, url: existing.checkoutUrl, reused: true });
    }
  }

  const origin = new URL(request.url).origin;
  try {
    const result = await initCheckout({ env, settings: settings.config, providerId, order, origin });
    order.payment = {
      provider: result.provider,
      reference: result.reference,
      amount: result.amount,
      currency: result.currency,
      status: "pending",
      checkoutUrl: result.url,
      createdAt: new Date().toISOString()
    };
    await putOrder(env, order);
    await rememberReference(env, result.reference, order.id, { amount: result.amount, currency: result.currency });
    return json({ ok: true, url: result.url });
  } catch (err) {
    const code = err && err.code;
    if (code === "payment_not_configured") return json({ error: "Card payment is not configured yet. Please try again later." }, 503, { code });
    if (code === "payment_provider") return json({ error: "That payment provider is not available." }, 400, { code });
    console.log("quote-check checkout failed", code || (err && err.message));
    return json({ error: "Could not start the payment. Please try again." }, 502, { code: "payment_failed" });
  }
}

export function onRequest() {
  return json({ error: "Use POST." }, 405, { allow: "POST" });
}
