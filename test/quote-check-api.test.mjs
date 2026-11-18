import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as upload from "../functions/quote-check/upload.js";
import * as status from "../functions/quote-check/status.js";
import * as checkout from "../functions/quote-check/checkout.js";
import * as testPay from "../functions/quote-check/test-pay.js";
import * as report from "../functions/quote-check/report.js";
import * as admin from "../functions/quote-check/admin.js";
import { getOrder, putOrder } from "../functions/quote-check/store.js";
import { runPurge } from "../functions/quote-check/orders.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://sendfair.africa";

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, String(value)); }
  async delete(key) { this.map.delete(key); }
  async list({ prefix = "", limit = 1000 } = {}) {
    return { keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name })) };
  }
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

function mockAssets() {
  const files = {
    "/data/build-costs.json": readJson("data/build-costs.json"),
    "/data/midmarket.json": readJson("data/midmarket.json"),
    "/data/quote-check/synonyms.json": readJson("data/quote-check/synonyms.json"),
    "/data/quote-check/config.json": { ...readJson("config/quote-check.json"), enabled: true, payment: { provider: "test", testMode: true } },
    "/data/quote-check/fixtures/kenya.json": readJson("data/quote-check/fixtures/kenya.json"),
    "/data/quote-check/fixtures/nigeria.json": readJson("data/quote-check/fixtures/nigeria.json"),
    "/data/quote-check/fixtures/ghana.json": readJson("data/quote-check/fixtures/ghana.json"),
    "/data/site.json": { ga4MeasurementId: "G-829T18F5K2" }
  };
  return {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (!(pathname in files)) return new Response("Not found", { status: 404 });
      return new Response(JSON.stringify(files[pathname]), { status: 200, headers: { "content-type": "application/json" } });
    }
  };
}

function makeEnv(overrides = {}) {
  const emails = [];
  const env = {
    SENDFAIR_KV: new MemoryKV(),
    ASSETS: mockAssets(),
    QUOTE_CHECK_ENABLED: "true",
    QUOTE_CHECK_TEST_MODE: "true",
    EMAIL: {
      async send(message) { emails.push(message); return { messageId: "test" }; }
    },
    ...overrides
  };
  env.emails = emails;
  return env;
}

function uploadRequest() {
  const form = new FormData();
  form.set("country", "kenya");
  form.set("town", "Nairobi");
  form.set("bedrooms", "3");
  form.set("storeys", "1");
  form.set("m2", "110");
  form.set("quoteCurrency", "KES");
  form.set("email", "customer@example.com");
  form.set("consent", "on");
  const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
  form.append("files", new File([pdf], "sample-quote.pdf", { type: "application/pdf" }));
  return new Request(`${ORIGIN}/api/quote-check/upload`, {
    method: "POST",
    body: form,
    headers: { "CF-Connecting-IP": "203.0.113.10" }
  });
}

test("the full Quote Check flow: preview, test payment, report, PDF and emails", async () => {
  const env = makeEnv();
  const up = await upload.onRequestPost({ env, request: uploadRequest() });
  const upBody = await up.json();
  assert.equal(up.status, 200, JSON.stringify(upBody));
  assert.equal(upBody.order.status, "previewed");
  assert.equal(upBody.preview.lineItems, 19);
  assert.equal(upBody.preview.matchedLines, 16);
  assert.equal(upBody.preview.quoteTotal, 3642600);
  assert.match(upBody.order.reportPath, /^\/quote-check\/report\/[a-z0-9]{20,40}\/$/);
  assert.equal(env.emails.length, 0, "no email before payment");

  const orderId = upBody.order.id;
  const token = upBody.order.token;

  const st = await status.onRequestGet({ env, request: new Request(`${ORIGIN}/api/quote-check/status?order=${orderId}&t=${token}`) });
  const stBody = await st.json();
  assert.equal(stBody.paid, false);
  assert.equal(stBody.reportReady, false);

  const previewRes = await report.onRequestGet({ env, request: new Request(`${ORIGIN}/quote-check/report/${token}/`) }, token, false);
  const previewHtml = await previewRes.text();
  assert.match(previewHtml, /Your free preview/);
  assert.doesNotMatch(previewHtml, /Line by line/);
  assert.doesNotMatch(previewHtml, /Cement, 50kg bags/);

  const co = await checkout.onRequestPost({
    env,
    request: new Request(`${ORIGIN}/api/quote-check/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: orderId, token })
    })
  });
  const coBody = await co.json();
  assert.equal(co.status, 200, JSON.stringify(coBody));
  assert.match(coBody.url, /^https:\/\/sendfair\.africa\/quote-check\/pay\/test\//);

  const paid = await testPay.onRequestPost({
    env,
    request: new Request(`${ORIGIN}/api/quote-check/test-pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: orderId, token })
    })
  });
  const paidBody = await paid.json();
  assert.equal(paid.status, 200, JSON.stringify(paidBody));

  const order = await getOrder(env, orderId);
  assert.equal(order.status, "report sent");
  assert.ok(order.payment.amount > 0);
  assert.equal(env.emails.length, 2, "customer and owner emails");
  const customer = env.emails.find((m) => m.to === "customer@example.com");
  assert.ok(customer);
  assert.equal(customer.attachments.length, 1);
  assert.equal(customer.attachments[0].type, "application/pdf");
  assert.match(customer.attachments[0].filename, /\.pdf$/);
  const owner = env.emails.find((m) => m.to !== "customer@example.com");
  assert.ok(owner);
  assert.match(owner.subject, /Paid Quote Check/);

  const full = await report.onRequestGet({ env, request: new Request(`${ORIGIN}/quote-check/report/${token}/`) }, token, false);
  const html = await full.text();
  assert.equal(full.status, 200);
  assert.match(html, /Line by line/);
  assert.match(html, /Cement, 50kg bags/);
  assert.match(html, /Above typical/);
  assert.match(html, /Questions to ask your builder/);
  assert.match(html, /Architect&#39;s fee/);
  assert.match(html, /Not checked/);
  assert.match(html, /Quantity checks: ask your builder/);
  assert.match(html, /What this report is, and what it is not/);
  assert.match(html, /checked 16 November 2026/);
  assert.match(html, /within the matched comparison|outside the matched comparison/);

  const pdf = await report.onRequestGet({ env, request: new Request(`${ORIGIN}/quote-check/report/${token}/pdf`) }, token, true);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  const bytes = new Uint8Array(await pdf.arrayBuffer());
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString("ascii"), "%PDF-");
  assert.ok(bytes.byteLength > 2000);

  const adminHeaders = { "x-sf-admin": "1", "Content-Type": "application/json" };
  const list = await admin.onRequestGet({ env, request: new Request(`${ORIGIN}/admin/quote-checks/api/list`) }, "list");
  const listBody = await list.json();
  assert.equal(listBody.orders.length, 1);
  assert.equal(listBody.orders[0].id, orderId);
  assert.equal(listBody.orders[0].status, "report sent");

  const detail = await admin.onRequestGet({ env, request: new Request(`${ORIGIN}/admin/quote-checks/api/order?id=${orderId}`) }, "order");
  const detailBody = await detail.json();
  assert.equal(detailBody.order.extraction.lineItems.length, 19);
  assert.ok(detailBody.catalogue.some((c) => c.key === "cement"));

  const rerun = await admin.onRequestPost({
    env,
    request: new Request(`${ORIGIN}/admin/quote-checks/api/rerun`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ id: orderId }) })
  }, "rerun");
  assert.equal(rerun.status, 200, await rerun.text());

  const edit = await admin.onRequestPost({
    env,
    request: new Request(`${ORIGIN}/admin/quote-checks/api/edit`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ id: orderId, index: 0, changes: { matchLabel: "Cement", quantity: 700, unit: "bags", unitPrice: 820, lineTotal: 574000 } })
    })
  }, "edit");
  assert.equal(edit.status, 200, await edit.text());
  const edited = await getOrder(env, orderId);
  assert.equal(edited.analysis.lines[0].quantity, 700);
  assert.equal(edited.analysis.lines[0].match.key, "cement");

  const emailsBefore = env.emails.length;
  const resend = await admin.onRequestPost({
    env,
    request: new Request(`${ORIGIN}/admin/quote-checks/api/resend`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ id: orderId }) })
  }, "resend");
  assert.equal(resend.status, 200, await resend.text());
  assert.equal(env.emails.length, emailsBefore + 1);

  const refund = await admin.onRequestPost({
    env,
    request: new Request(`${ORIGIN}/admin/quote-checks/api/refund`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ id: orderId, note: "test refund" }) })
  }, "refund");
  assert.equal(refund.status, 200);
  const refunded = await getOrder(env, orderId);
  assert.equal(refunded.status, "refunded");
  const refundedPage = await report.onRequestGet({ env, request: new Request(`${ORIGIN}/quote-check/report/${token}/`) }, token, false);
  assert.match(await refundedPage.text(), /This order was refunded/);

  // Retention: force the purge date into the past and confirm the personal data and files go.
  const due = await getOrder(env, orderId);
  due.purgeAt = "2020-01-01T00:00:00.000Z";
  await putOrder(env, due);
  const purge = await runPurge(env, new Date("2026-11-18T12:00:00.000Z"));
  assert.equal(purge.purged, 1);
  const purged = await getOrder(env, orderId);
  assert.equal(purged.purged, true);
  assert.equal(purged.email, undefined);
  assert.equal(purged.extraction, undefined);
  assert.equal(purged.analysis, undefined);
  assert.equal(purged.files, undefined);
  assert.equal(purged.payment.amount, due.payment.amount);
  const deletedPage = await report.onRequestGet({ env, request: new Request(`${ORIGIN}/quote-check/report/${token}/`) }, token, false);
  assert.match(await deletedPage.text(), /This report has been deleted/);
});

test("Quote Check refuses uploads when the flag is off", async () => {
  const env = makeEnv({ QUOTE_CHECK_ENABLED: "false" });
  const res = await upload.onRequestPost({ env, request: uploadRequest() });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "disabled");
});

test("Quote Check rejects a file type that is not allowed", async () => {
  const env = makeEnv();
  const form = new FormData();
  form.set("country", "kenya");
  form.set("town", "Nairobi");
  form.set("bedrooms", "3");
  form.set("storeys", "1");
  form.set("m2", "110");
  form.set("quoteCurrency", "KES");
  form.set("email", "customer@example.com");
  form.set("consent", "on");
  form.append("files", new File([new TextEncoder().encode("MZ not a quote")], "quote.exe", { type: "application/x-msdownload" }));
  const res = await upload.onRequestPost({
    env,
    request: new Request(`${ORIGIN}/api/quote-check/upload`, { method: "POST", body: form, headers: { "CF-Connecting-IP": "203.0.113.11" } })
  });
  assert.equal(res.status, 415);
  const body = await res.json();
  assert.match(body.error, /not accepted/);
});

test("a private report link with the wrong token is not served", async () => {
  const env = makeEnv();
  const up = await upload.onRequestPost({ env, request: uploadRequest() });
  const upBody = await up.json();
  const wrong = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.notEqual(wrong, upBody.order.token);
  const res = await report.onRequestGet({ env, request: new Request(`${ORIGIN}/quote-check/report/${wrong}/`) }, wrong, false);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /Report not found/);
});
