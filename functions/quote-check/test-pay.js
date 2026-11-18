// POST /api/quote-check/test-pay  { order, token }
// Test mode only: marks the order paid without a card, so the whole flow can be reviewed.

import { json } from "../_lib.js";
import { loadSettings, testMode } from "./settings.js";
import { getOrder } from "./store.js";
import { priceFor } from "../../src/quote-check/config.mjs";
import { releaseReport } from "./orders.js";
import { constantTimeEqual } from "./bytes.js";

export async function onRequestPost(context) {
  const { env, request } = context;
  const settings = await loadSettings(env, request).catch(() => null);
  if (!settings) return json({ error: "Not available." }, 503);
  if (!testMode(env, settings.config)) return json({ error: "Test payments are off." }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Send the order as JSON." }, 400); }
  const order = await getOrder(env, String(body.order || ""));
  if (!order || !constantTimeEqual(order.token, String(body.token || ""))) return json({ error: "Order not found." }, 404);
  if (order.status === "refunded") return json({ error: "This order was refunded." }, 400);
  if (order.status === "paid" || order.status === "report sent") {
    return json({ ok: true, url: `/quote-check/report/${order.token}/`, alreadyPaid: true });
  }

  const price = (order.payment && order.payment.amount > 0)
    ? { amount: order.payment.amount, currency: order.payment.currency }
    : priceFor(settings.config, order.quoteCurrency);
  const released = await releaseReport({
    env,
    request,
    settings,
    order,
    payment: {
      provider: "test",
      reference: `test_${order.id}_${Date.now().toString(36)}`,
      amount: price.amount,
      currency: price.currency,
      verifiedAt: new Date().toISOString()
    },
    origin: new URL(request.url).origin
  });
  if (!released.ok) return json({ error: released.error || "Could not release the report." }, 500);
  return json({ ok: true, url: `/quote-check/report/${order.token}/` });
}

export function onRequest() {
  return json({ error: "Use POST." }, 405, { allow: "POST" });
}
