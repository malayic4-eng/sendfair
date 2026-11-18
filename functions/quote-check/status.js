// GET /api/quote-check/status?order=<id>&t=<token>
// Used by the report page to wait for a payment confirmation. It never returns line details.

import { json } from "../_lib.js";
import { getOrder, getOrderByToken } from "./store.js";
import { constantTimeEqual } from "./bytes.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = url.searchParams.get("order") || "";
  const token = url.searchParams.get("t") || "";
  let order = null;
  if (id) {
    order = await getOrder(context.env, id);
    if (order && !constantTimeEqual(order.token, token)) order = null;
  } else if (token) {
    order = await getOrderByToken(context.env, token);
  }
  if (!order) return json({ error: "Not found." }, 404);
  const paid = order.status === "paid" || order.status === "report sent";
  return json({
    ok: true,
    status: order.status,
    paid,
    refunded: order.status === "refunded",
    reportReady: paid && !!order.analysis,
    purged: !!order.purged,
    preview: paid ? undefined : order.preview
  });
}

export function onRequest() {
  return json({ error: "Use GET." }, 405, { allow: "GET" });
}
