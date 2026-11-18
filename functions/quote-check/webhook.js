// POST /api/quote-check/webhook/<provider>
// The provider's notification is checked against its signature, then the payment is verified
// with the provider's own API before the report is released.

import { json } from "../_lib.js";
import { loadSettings, paymentProviderId, testMode } from "./settings.js";
import { getOrder, putOrder } from "./store.js";
import { verifyNotification, verifyTransaction, referenceInfo } from "./payments.js";
import { releaseReport } from "./orders.js";

export async function onRequestPost(context, providerId) {
  const { env, request } = context;
  const settings = await loadSettings(env, request).catch(() => null);
  if (!settings) return json({ error: "Not available." }, 503);
  if (!["paystack", "flutterwave"].includes(providerId)) return json({ error: "Unknown provider." }, 404);
  if (testMode(env, settings.config)) return json({ error: "Webhooks are off in test mode." }, 404);
  if (paymentProviderId(env, settings.config) !== providerId) return json({ error: "Provider is not active." }, 404);

  let raw;
  try { raw = await request.text(); } catch { return json({ error: "Unreadable body." }, 400); }
  const note = await verifyNotification({ env, providerId, request, rawBody: raw });
  if (!note.ok) {
    if (note.ignore) return json({ ok: true, ignored: true });
    return json({ error: "Signature check failed." }, 401);
  }

  const refInfo = await referenceInfo(env, note.reference);
  if (!refInfo || !refInfo.orderId) return json({ error: "Unknown payment reference." }, 404);
  const order = await getOrder(env, refInfo.orderId);
  if (!order) return json({ error: "Order not found." }, 404);
  if (order.status === "refunded") return json({ ok: true, ignored: true });

  // Use the amount recorded when this reference was created, not a mutable order field.
  const expectedAmount = refInfo.amount != null ? refInfo.amount : order.payment && order.payment.amount;
  const currency = refInfo.currency != null ? refInfo.currency : order.payment && order.payment.currency;
  if (!(expectedAmount > 0) || !currency) return json({ error: "Order has no payment amount." }, 409);

  let verified;
  try {
    verified = await verifyTransaction({ env, providerId, reference: note.reference, expectedAmount, currency });
  } catch (err) {
    console.log("quote-check verify failed", err && err.message);
    return json({ error: "Could not verify the payment." }, 502);
  }
  if (!verified.ok) {
    console.log("quote-check payment not verified", verified.reason);
    return json({ error: "Payment was not verified.", reason: verified.reason }, 400);
  }

  try {
    const released = await releaseReport({
      env,
      request,
      settings,
      order,
      payment: { provider: providerId, reference: note.reference, amount: verified.amount, currency: verified.currency, verifiedAt: new Date().toISOString() },
      origin: new URL(request.url).origin
    });
    if (!released.ok) return json({ error: released.error || "Could not release the report." }, 500);
    if (order.status !== "report sent") {
      order.report = order.report || {};
      order.report.deliveryNote = released.emailed ? "sent" : "paid_report_ready";
      await putOrder(env, order);
    }
    return json({ ok: true });
  } catch (err) {
    console.log("quote-check release failed", err && err.message);
    return json({ error: "Could not release the report." }, 500);
  }
}

export function onRequest() {
  return json({ error: "Use POST." }, 405, { allow: "POST" });
}
