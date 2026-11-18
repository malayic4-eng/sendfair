import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifyNotification, verifyTransaction, resolveCharge, PROVIDERS } from "../functions/quote-check/payments.js";
import { mergeConfig } from "../src/quote-check/config.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = mergeConfig(JSON.parse(fs.readFileSync(path.join(ROOT, "config/quote-check.json"), "utf8")));

function paystackRequest(body, secret) {
  const signature = createHmac("sha512", secret).update(body).digest("hex");
  return new Request("https://sendfair.africa/api/quote-check/webhook/paystack", {
    method: "POST",
    headers: { "x-paystack-signature": signature },
    body
  });
}

test("Paystack webhooks require a valid HMAC SHA-512 signature", async () => {
  const secret = "sk_test_quote_check";
  const env = { PAYSTACK_SECRET_KEY: secret };
  const body = JSON.stringify({ event: "charge.success", data: { reference: "qc_abc_123" } });

  const good = await verifyNotification({ env, providerId: "paystack", request: paystackRequest(body, secret), rawBody: body });
  assert.equal(good.ok, true);
  assert.equal(good.reference, "qc_abc_123");

  const bad = await verifyNotification({ env, providerId: "paystack", request: paystackRequest(body, "wrong"), rawBody: body });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "bad_signature");

  const ignored = await verifyNotification({
    env,
    providerId: "paystack",
    request: paystackRequest(JSON.stringify({ event: "transfer.success", data: { reference: "x" } }), secret),
    rawBody: JSON.stringify({ event: "transfer.success", data: { reference: "x" } })
  });
  assert.equal(ignored.ignore, true);
});

test("Flutterwave webhooks require the configured verif-hash", async () => {
  const env = { FLUTTERWAVE_SECRET_HASH: "flw-hash" };
  const body = JSON.stringify({ event: "charge.completed", data: { status: "successful", tx_ref: "qc_abc_456" } });
  const good = await verifyNotification({
    env,
    providerId: "flutterwave",
    request: new Request("https://sendfair.africa/api/quote-check/webhook/flutterwave", { method: "POST", headers: { "verif-hash": "flw-hash" }, body }),
    rawBody: body
  });
  assert.equal(good.ok, true);
  assert.equal(good.reference, "qc_abc_456");

  const bad = await verifyNotification({
    env,
    providerId: "flutterwave",
    request: new Request("https://sendfair.africa/api/quote-check/webhook/flutterwave", { method: "POST", headers: { "verif-hash": "nope" }, body }),
    rawBody: body
  });
  assert.equal(bad.ok, false);
});

test("the provider verify call checks amount and currency before release", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ status: true, data: { status: "success", amount: 150000, currency: "KES" } }), { status: 200, headers: { "content-type": "application/json" } });
    const env = { PAYSTACK_SECRET_KEY: "sk_test" };
    const good = await verifyTransaction({ env, providerId: "paystack", reference: "qc_abc", expectedAmount: 1500, currency: "KES" });
    assert.equal(good.ok, true);
    assert.equal(good.amount, 1500);

    const short = await verifyTransaction({ env, providerId: "paystack", reference: "qc_abc", expectedAmount: 2000, currency: "KES" });
    assert.equal(short.ok, false);
    assert.equal(short.reason, "amount_mismatch");

    const wrongCurrency = await verifyTransaction({ env, providerId: "paystack", reference: "qc_abc", expectedAmount: 1500, currency: "NGN" });
    assert.equal(wrongCurrency.ok, false);
    assert.equal(wrongCurrency.reason, "currency_mismatch");
  } finally {
    globalThis.fetch = original;
  }
});

test("an unsupported provider currency falls back to the USD fee", () => {
  const config = mergeConfig({ ...JSON.parse(fs.readFileSync(path.join(ROOT, "config/quote-check.json"), "utf8")), payment: { provider: "paystack" } });
  assert.deepEqual(resolveCharge(config, "GBP", "paystack"), { currency: "USD", amount: 12 });
  assert.deepEqual(resolveCharge(config, "KES", "paystack"), { currency: "KES", amount: 1500 });
  assert.deepEqual(resolveCharge(config, "GBP", "flutterwave"), { currency: "GBP", amount: 9 });
  assert.ok(PROVIDERS.paystack.supported.includes("KES"));
});

test("a Kenyan Paystack account is charged in KES whatever the quote currency", async () => {
  const cfg = mergeConfig({ payment: { provider: "paystack", currencies: ["KES"] } });
  for (const cur of ["NGN", "GBP", "UGX", "KES"]) assert.deepEqual(resolveCharge(cfg, cur, "paystack"), { currency: "KES", amount: 1500 });
});
