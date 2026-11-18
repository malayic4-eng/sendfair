// Admin endpoints for /admin/quote-checks. The Worker's existing admin session gate runs
// before these handlers; POSTs also require the x-sf-admin header as a CSRF check.

import { json } from "../_lib.js";
import { loadSettings, paymentProviderId, testMode } from "./settings.js";
import { listOrders, getOrder } from "./store.js";
import { resendReport, rerunExtraction, editLine, markRefunded, loadPricingData } from "./orders.js";
import { ITEM_UNITS } from "../../src/quote-check/catalogue.mjs";

function summary(order) {
  return {
    id: order.id,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: order.status,
    countryId: order.countryId,
    countryName: order.countryName,
    town: order.town,
    email: order.email,
    m2: order.m2,
    houseType: order.houseType,
    quoteCurrency: order.quoteCurrency,
    verdict: order.analysis && order.analysis.summary ? order.analysis.summary.band.label : "",
    preview: order.preview,
    payment: order.payment,
    report: order.report ? { generatedAt: order.report.generatedAt, sentAt: order.report.sentAt, emailError: order.report.emailError, ownerEmail: order.report.ownerEmail } : null,
    purgeAt: order.purgeAt,
    purged: !!order.purged,
    adminEdits: order.adminEdits ? order.adminEdits.length : 0
  };
}

function csrfOk(request) {
  return request.headers.get("x-sf-admin") === "1";
}

async function configInfo(env, settings) {
  return {
    enabled: true,
    testMode: testMode(env, settings.config),
    provider: paymentProviderId(env, settings.config),
    prices: settings.config.prices,
    retentionDays: settings.config.retentionDays,
    ownerEmail: env.QUOTE_CHECK_OWNER_EMAIL || settings.config.ownerEmail,
    storage: env.QUOTE_CHECK_FILES ? "r2" : "kv"
  };
}

export async function onRequestGet(context, action) {
  const { env, request } = context;
  const settings = await loadSettings(env, request).catch(() => null);
  if (!settings) return json({ error: "Not available." }, 503);

  if (action === "config") return json({ ok: true, config: await configInfo(env, settings) });

  if (action === "list") {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") || "";
    let orders = await listOrders(env, 500);
    if (status) orders = orders.filter((o) => o.status === status);
    return json({ ok: true, orders: orders.map(summary) });
  }

  if (action === "order") {
    const id = new URL(request.url).searchParams.get("id") || "";
    const order = await getOrder(env, id);
    if (!order) return json({ error: "Order not found." }, 404);
    let catalogue = [];
    try {
      const { data } = await loadPricingData(env, request);
      const country = data.countries[order.countryId] || {};
      catalogue = Object.entries(ITEM_UNITS).map(([key, meta]) => {
        const item = (country.items || {})[key];
        const local = key === "permitTotal" ? true : !!(item && (item.price > 0 || (item.options || []).length));
        return { key, label: meta.label, unit: meta.unit, local };
      });
    } catch {}
    return json({ ok: true, order, catalogue, config: await configInfo(env, settings) });
  }

  return json({ error: "Unknown admin action." }, 404);
}

export async function onRequestPost(context, action) {
  const { env, request } = context;
  if (!csrfOk(request)) return json({ error: "Missing admin header." }, 403);
  const settings = await loadSettings(env, request).catch(() => null);
  if (!settings) return json({ error: "Not available." }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Send JSON." }, 400); }
  const order = await getOrder(env, String(body.id || ""));
  if (!order) return json({ error: "Order not found." }, 404);
  const origin = new URL(request.url).origin;

  if (action === "rerun") {
    const result = await rerunExtraction({ env, request, settings, order });
    if (!result.ok) return json({ error: result.error }, 400);
    return json({ ok: true, order: summary(result.order) });
  }

  if (action === "edit") {
    const index = Number(body.index);
    if (!(index >= 0)) return json({ error: "Choose a line." }, 400);
    const result = await editLine({ env, request, settings, order, index, changes: body.changes || {} });
    if (!result.ok) return json({ error: result.error }, 400);
    return json({ ok: true, order: summary(result.order) });
  }

  if (action === "resend") {
    const result = await resendReport({ env, request, settings, order, origin });
    if (!result.ok) return json({ error: result.error || "The email could not be sent." }, 502);
    return json({ ok: true });
  }

  if (action === "refund") {
    const result = await markRefunded({ env, settings, order, note: body.note || "" });
    return json({ ok: true, order: summary(result.order) });
  }

  return json({ error: "Unknown admin action." }, 404);
}
