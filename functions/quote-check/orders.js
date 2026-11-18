/* Quote Check order lifecycle: create and analyse, release after verified payment,
   re-run or edit from the admin, and delete personal data after the retention period. */

import { validateExtraction } from "../../src/quote-check/validate.mjs";
import { analyseQuote } from "../../src/quote-check/analysis.mjs";
import { isTestMode } from "../../src/quote-check/config.mjs";
import { newOrderId, token, putOrder, getOrder, orderKey, storeUpload, readUpload, deleteUpload, storePdf, deletePdf } from "./store.js";
import { extractQuote } from "./llm.js";
import { buildReportPdf } from "./pdf-report.mjs";
import { sendReportEmail, sendOwnerEmail } from "./email.js";
import { sha256Hex } from "./bytes.js";

const DAY = 86400;

async function assetJson(env, request, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  if (!res.ok) throw new Error(`Missing ${path}`);
  return res.json();
}

export async function loadPricingData(env, request) {
  const [data, midmarket] = await Promise.all([
    assetJson(env, request, "/data/build-costs.json"),
    assetJson(env, request, "/data/midmarket.json")
  ]);
  return { data, midmarket };
}

function previewOf(report) {
  return {
    lineItems: report.summary.totalLines,
    matchedLines: report.summary.checkedLines,
    totalLines: report.summary.totalLines,
    quoteTotal: report.quote.total,
    quoteCurrency: report.quote.currency,
    countryCurrency: report.country.currency,
    countryName: report.country.name,
    checkedDate: report.checkedDate,
    coverage: report.summary.coverage,
    arithmeticIssues: report.summary.arithmeticIssues,
    quantityIssues: report.summary.quantityIssues
  };
}

export async function rateLimitedUpload(env, config, ip, email) {
  const kv = env.SENDFAIR_KV;
  if (!kv) return { limited: true, reason: "storage" };
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = `qc:rl:ip:${(await sha256Hex(String(ip || "unknown"))).slice(0, 16)}`;
  const emailKey = `qc:rl:em:${(await sha256Hex(String(email || "").toLowerCase())).slice(0, 16)}:${day}`;
  const [a, b] = await Promise.all([kv.get(ipKey), kv.get(emailKey)]);
  if (Number(a || 0) >= config.limits.uploadsPerHour) return { limited: true, reason: "ip" };
  if (Number(b || 0) >= config.limits.uploadsPerEmailPerDay) return { limited: true, reason: "email" };
  await kv.put(ipKey, String(Number(a || 0) + 1), { expirationTtl: 3600 });
  await kv.put(emailKey, String(Number(b || 0) + 1), { expirationTtl: DAY });
  return { limited: false };
}

export async function createOrder({ env, request, settings, fields, files, ip }) {
  if (!env.SENDFAIR_KV) throw Object.assign(new Error("Quote Check storage is not configured."), { code: "storage" });
  const config = settings.config || settings;
  const synonyms = settings.synonyms || {};
  const { data, midmarket } = await loadPricingData(env, request);
  const country = data.countries && data.countries[fields.countryId];
  if (!country) throw Object.assign(new Error("Unknown country."), { code: "country" });

  const limit = await rateLimitedUpload(env, config, ip, fields.email);
  if (limit.limited) {
    const err = new Error(limit.reason === "email"
      ? `You have already uploaded ${config.limits.uploadsPerEmailPerDay} quotes today. Try again tomorrow.`
      : "Too many uploads from this connection. Try again in an hour.");
    err.code = "rate_limit";
    throw err;
  }

  let id = newOrderId();
  for (let i = 0; i < 5; i++) {
    if (!(await getOrder(env, id))) break;
    id = newOrderId();
  }
  const viewToken = token(28);
  const now = new Date().toISOString();

  const stored = [];
  try {
    for (const file of files) {
      const meta = await storeUpload(env, id, file.id, file.bytes, { type: file.type });
      stored.push({
        id: file.id, name: file.name, type: file.type, kind: file.kind, ext: file.ext,
        size: file.size, sha256: file.sha256, storage: meta.storage, key: meta.key
      });
    }
  } catch (err) {
    for (const s of stored) await deleteUpload(env, s);
    throw err;
  }

  const order = {
    id,
    token: viewToken,
    createdAt: now,
    updatedAt: now,
    status: "uploaded",
    countryId: fields.countryId,
    countryName: country.name,
    town: fields.town,
    bedrooms: fields.bedrooms,
    storeys: fields.storeys,
    m2: fields.m2,
    houseType: fields.storeys >= 2 ? "maisonette, two floors" : "bungalow, one floor",
    quoteCurrency: fields.quoteCurrency,
    email: fields.email,
    consent: {
      processing: true,
      terms: true,
      version: config.consentVersion,
      at: now,
      ipHash: (await sha256Hex(String(ip || "unknown"))).slice(0, 16)
    },
    files: stored,
    extraction: null,
    validation: null,
    analysis: null,
    preview: null,
    payment: null,
    report: null,
    retentionDays: config.retentionDays,
    purgeAt: null,
    purged: false
  };

  try {
    const extracted = await extractQuote({
      env,
      request,
      settings: config,
      files,
      testMode: isTestMode(env, config),
      meta: {
        countryId: fields.countryId,
        countryName: country.name,
        town: fields.town,
        bedrooms: fields.bedrooms,
        storeys: fields.storeys,
        m2: fields.m2,
        quoteCurrency: fields.quoteCurrency
      }
    });
    const validation = validateExtraction(extracted.raw, { currency: fields.quoteCurrency, maxLines: config.extraction.maxLines });
    if (!validation.ok) {
      const err = new Error(validation.errors[0] || "The quote could not be read.");
      err.code = "extraction_invalid";
      err.details = validation.errors;
      throw err;
    }
    const analysis = analyseQuote({
      extraction: validation.extraction,
      validation,
      data,
      countryId: fields.countryId,
      town: fields.town,
      bedrooms: fields.bedrooms,
      storeys: fields.storeys,
      m2: fields.m2,
      quoteCurrency: fields.quoteCurrency,
      midmarket,
      synonyms,
      config,
      now
    });
    if (!analysis.ok) throw Object.assign(new Error(analysis.error || "The quote could not be checked."), { code: "analysis" });

    order.extraction = validation.extraction;
    order.validation = { errors: validation.errors, warnings: validation.warnings, arithmetic: validation.arithmetic };
    order.analysis = analysis.report;
    order.preview = previewOf(analysis.report);
    order.status = "previewed";
    await putOrder(env, order);
    return { order, preview: order.preview };
  } catch (err) {
    for (const s of stored) await deleteUpload(env, s).catch(() => {});
    throw err;
  }
}

export async function regenerateReport(env, request, settings, order) {
  const config = settings.config || settings;
  const synonyms = settings.synonyms || {};
  const { data, midmarket } = await loadPricingData(env, request);
  const validation = validateExtraction(order.extraction, { currency: order.quoteCurrency, maxLines: config.extraction.maxLines });
  if (!validation.ok) return { ok: false, error: validation.errors[0] || "The stored extraction is no longer valid." };
  const analysis = analyseQuote({
    extraction: validation.extraction,
    validation,
    data,
    countryId: order.countryId,
    town: order.town,
    bedrooms: order.bedrooms,
    storeys: order.storeys,
    m2: order.m2,
    quoteCurrency: order.quoteCurrency,
    midmarket,
    synonyms,
    config,
    now: new Date().toISOString()
  });
  if (!analysis.ok) return { ok: false, error: analysis.error };
  order.validation = { errors: validation.errors, warnings: validation.warnings, arithmetic: validation.arithmetic };
  order.analysis = analysis.report;
  order.preview = previewOf(analysis.report);
  return { ok: true };
}

export async function releaseReport({ env, request, settings, order, payment, origin }) {
  const config = settings.config || settings;
  if (order.status === "paid" || order.status === "report sent") return { ok: true, order };
  if (order.status === "refunded") return { ok: false, error: "This order was refunded." };
  if (!order.analysis) {
    const regen = await regenerateReport(env, request, settings, order);
    if (!regen.ok) return { ok: false, error: regen.error };
  }
  const now = new Date();
  const pdf = buildReportPdf(order.analysis, { email: order.email, orderId: order.id });
  const stored = await storePdf(env, order.id, pdf);
  order.report = {
    pdf: stored,
    generatedAt: now.toISOString(),
    sentAt: "",
    emailError: ""
  };
  order.purgeAt = new Date(now.getTime() + config.retentionDays * DAY * 1000).toISOString();
  order.payment = {
    ...(order.payment || {}),
    ...payment,
    status: "paid",
    paidAt: now.toISOString()
  };
  order.status = "paid";
  await putOrder(env, order);

  const mail = await sendReportEmail(env, config, order, order.analysis, pdf, origin);
  const owner = await sendOwnerEmail(env, config, order, order.analysis, origin);
  if (mail.ok) {
    order.status = "report sent";
    order.report.sentAt = new Date().toISOString();
    order.report.emailError = "";
  } else {
    order.report.emailError = mail.error || "email_failed";
  }
  order.report.ownerEmail = owner.ok ? "sent" : (owner.error || "failed");
  await putOrder(env, order);
  return { ok: true, order, emailed: mail.ok };
}

export async function resendReport({ env, request, settings, order, origin }) {
  // Rebuild the PDF from the current analysis, so an admin edit is reflected in the attachment.
  if (!order.analysis) {
    const regen = await regenerateReport(env, request, settings, order);
    if (!regen.ok) return { ok: false, error: regen.error };
  }
  const pdf = buildReportPdf(order.analysis, { email: order.email, orderId: order.id });
  order.report = {
    ...(order.report || {}),
    pdf: await storePdf(env, order.id, pdf),
    generatedAt: new Date().toISOString()
  };
  const mail = await sendReportEmail(env, settings.config || settings, order, order.analysis, pdf, origin);
  if (mail.ok) {
    order.status = "report sent";
    order.report = order.report || {};
    order.report.sentAt = new Date().toISOString();
    order.report.emailError = "";
  } else {
    order.report = order.report || {};
    order.report.emailError = mail.error || "email_failed";
  }
  await putOrder(env, order);
  return { ok: mail.ok, error: mail.error };
}

export async function rerunExtraction({ env, request, settings, order }) {
  const config = settings.config || settings;
  if (!order.files || !order.files.length) return { ok: false, error: "The uploaded files have been deleted, so the extraction cannot be re-run." };
  const files = [];
  for (const meta of order.files) {
    const bytes = await readUpload(env, order, meta);
    if (!bytes) return { ok: false, error: `The stored file ${meta.name} is no longer available.` };
    files.push({ ...meta, bytes });
  }
  const extracted = await extractQuote({
    env,
    request,
    settings: config,
    files,
    testMode: isTestMode(env, config),
    meta: {
      countryId: order.countryId,
      countryName: order.countryName,
      town: order.town,
      bedrooms: order.bedrooms,
      storeys: order.storeys,
      m2: order.m2,
      quoteCurrency: order.quoteCurrency
    }
  });
  const validation = validateExtraction(extracted.raw, { currency: order.quoteCurrency, maxLines: config.extraction.maxLines });
  if (!validation.ok) return { ok: false, error: validation.errors[0] || "The quote could not be read again." };
  order.extraction = validation.extraction;
  const regen = await regenerateReport(env, request, settings, order);
  if (!regen.ok) return regen;
  order.status = order.payment && order.payment.status === "paid" ? (order.report && order.report.sentAt ? "report sent" : "paid") : "previewed";
  await putOrder(env, order);
  return { ok: true, order };
}

export async function editLine({ env, request, settings, order, index, changes }) {
  if (!order.extraction || !Array.isArray(order.extraction.lineItems) || !order.extraction.lineItems[index]) {
    return { ok: false, error: "That line does not exist." };
  }
  const line = order.extraction.lineItems[index];
  if (changes.description != null) line.description = String(changes.description).slice(0, 300);
  if (changes.quantity != null) line.quantity = Number(changes.quantity);
  if (changes.unit != null) line.unit = String(changes.unit).slice(0, 40);
  if (changes.unitPrice != null) line.unitPrice = Number(changes.unitPrice);
  if (changes.lineTotal != null) line.lineTotal = Number(changes.lineTotal);
  if (changes.description == null && changes.quantity == null && changes.unit == null && changes.unitPrice == null && changes.lineTotal == null) {
    return { ok: false, error: "No change was supplied." };
  }
  // If the admin picked a catalogue item, use its label so the same matcher is exercised again.
  if (changes.matchLabel) {
    line.description = String(changes.matchLabel).slice(0, 300);
    if (changes.quantity == null) line.quantity = line.quantity == null ? 1 : line.quantity;
    if (changes.unit == null) line.unit = String(changes.unit || line.unit || "each");
  }
  order.adminEdits = order.adminEdits || [];
  order.adminEdits.push({ at: new Date().toISOString(), index, changes: { ...changes } });
  const regen = await regenerateReport(env, request, settings, order);
  if (!regen.ok) return regen;
  if (order.payment && order.payment.status === "paid") {
    // The old PDF is stale now; resendReport rebuilds it.
    order.report = { ...(order.report || {}), pdf: null, generatedAt: new Date().toISOString() };
  }
  await putOrder(env, order);
  return { ok: true, order };
}

export async function markRefunded({ env, settings, order, note }) {
  order.status = "refunded";
  order.refund = { at: new Date().toISOString(), note: String(note || "").slice(0, 500) };
  await putOrder(env, order);
  return { ok: true, order };
}

export async function purgeOrder(env, order, now = new Date()) {
  for (const file of order.files || []) await deleteUpload(env, file).catch(() => {});
  await deletePdf(env, order).catch(() => {});
  const minimal = {
    id: order.id,
    token: order.token,
    createdAt: order.createdAt,
    updatedAt: now.toISOString(),
    status: order.status,
    countryId: order.countryId,
    countryName: order.countryName,
    quoteCurrency: order.quoteCurrency,
    payment: order.payment
      ? { provider: order.payment.provider, reference: order.payment.reference, amount: order.payment.amount, currency: order.payment.currency, status: order.payment.status, paidAt: order.payment.paidAt }
      : null,
    reportGeneratedAt: order.report && order.report.generatedAt,
    purgedAt: now.toISOString(),
    purged: true
  };
  await putOrder(env, minimal);
  return minimal;
}

export async function runPurge(env, now = new Date()) {
  const kv = env.SENDFAIR_KV;
  if (!kv) return { purged: 0, scanned: 0 };
  const prefix = orderKey("");
  let purged = 0;
  let scanned = 0;
  let cursor;
  let pages = 0;
  do {
    const page = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys || []) {
      const id = key.name.slice(prefix.length);
      const order = await getOrder(env, id);
      scanned++;
      if (!order || order.purged) continue;
      const created = new Date(order.createdAt).getTime();
      const due = order.purgeAt
        ? new Date(order.purgeAt).getTime()
        : created + ((order.retentionDays || 30) * DAY * 1000);
      if (Number.isFinite(due) && now.getTime() >= due) {
        await purgeOrder(env, order, now);
        purged++;
      }
    }
    cursor = page.cursor;
    pages++;
  } while (cursor && pages < 100);
  return { purged, scanned };
}
