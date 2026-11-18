// Tests for the provider-adapter interface using the sample feed files in data/adapters/sample/.
// No network: a fake fetch returns each sample. Also covers the 24-hour drop, the "(partner feed)"
// mark, hand-check precedence, failure counting and the owner alert.
import fs from "node:fs";
import assert from "node:assert/strict";
import { PartnerFeedAdapter } from "./providers/partner-feed.mjs";
import { WiseFeedAdapter } from "./providers/wise.mjs";
import { mergeQuotes } from "./providers/merge.mjs";
import { runFeeds } from "./providers/runner.mjs";
import { notifyOwner } from "./providers/notify.mjs";
import { csvRows, normalizePayout } from "./providers/adapter.mjs";

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const NOW = Date.parse("2026-11-18T18:00:00Z");
const ROUTES = ["uk-nigeria", "uk-ghana", "uk-kenya", "us-kenya", "europe-senegal"];
const env = {
  LEMFI_FEED_URL: "https://feeds.test/lemfi.json", LEMFI_FEED_KEY: "k",
  SENDWAVE_FEED_URL: "https://feeds.test/sendwave.csv", SENDWAVE_FEED_KEY: "k",
  TAPTAPSEND_FEED_URL: "https://feeds.test/taptapsend.json", TAPTAPSEND_FEED_KEY: "k"
};
const sampleFetch = (file) => async () => ({
  ok: true, status: 200,
  text: async () => fs.readFileSync(file, "utf8"),
  json: async () => JSON.parse(fs.readFileSync(file, "utf8"))
});
const failFetch = async () => ({ ok: false, status: 503, text: async () => "", json: async () => ({}) });
const base = {
  now: NOW,
  mid: { GBP: 1, NGN: 1900, GHS: 15, KES: 170, EUR: 1, XOF: 655.957 },
  providers: new Set(["lemfi", "sendwave", "taptapsend", "wise"]),
  sendsFrom: { lemfi: ["uk"], sendwave: ["uk", "us"], taptapsend: ["europe"], wise: ["uk"] },
  defaultAmounts: { GBP: 250, USD: 300, EUR: 250 },
  routeCurrency: { "uk-nigeria": "GBP", "uk-ghana": "GBP", "uk-kenya": "GBP", "us-kenya": "USD", "europe-senegal": "EUR" }
};

let checks = 0, failures = 0;
async function check(name, fn) {
  checks++;
  try { await fn(); console.log("ok " + name); }
  catch (e) { failures++; console.error("FAIL " + name + ": " + (e && e.message)); }
}

await check("LemFi JSON feed maps fields, marks (partner feed) and drops a 56h-old row", async () => {
  const out = await new PartnerFeedAdapter(read("data/adapters/lemfi.json")).fetchQuotes({ env, fetchImpl: sampleFetch("data/adapters/sample/lemfi.json"), now: NOW, routes: ROUTES });
  assert.equal(out.rows, 3);
  assert.equal(out.quotes["uk-nigeria"][0].rate, 1900.5);
  assert.equal(out.quotes["uk-nigeria"][0].source, "partner-feed");
  assert.equal(out.quotes["uk-nigeria"][0].feed, true);
  assert.match(out.quotes["uk-nigeria"][0].note, /\(partner feed\)/);
  assert.deepEqual(out.quotes["uk-nigeria"][0].payout.sort(), ["bank", "mobile"]);
  assert.equal(out.quotes["uk-nigeria"][0].checkedAt, "2026-11-18T16:00:00.000Z");
  assert.equal(out.quotes["uk-kenya"], undefined);
  assert.ok(out.dropped >= 1);
});

await check("Sendwave CSV feed maps ISO codes to SendFair routes", async () => {
  const out = await new PartnerFeedAdapter(read("data/adapters/sendwave.json")).fetchQuotes({ env, fetchImpl: sampleFetch("data/adapters/sample/sendwave.csv"), now: NOW, routes: ROUTES });
  assert.equal(out.quotes["uk-nigeria"][0].rate, 1895.2);
  assert.deepEqual(out.quotes["uk-nigeria"][0].payout, ["bank", "mobile"]);
  assert.equal(out.quotes["us-kenya"][0].provider, "sendwave");
  assert.equal(out.quotes["us-kenya"][0].feeFixed, 0);
});

await check("Taptap Send JSON array feed applies feePctScale", async () => {
  const out = await new PartnerFeedAdapter(read("data/adapters/taptapsend.json")).fetchQuotes({ env, fetchImpl: sampleFetch("data/adapters/sample/taptapsend.json"), now: NOW, routes: ROUTES });
  assert.equal(out.quotes["europe-senegal"][0].rate, 655.957);
  assert.ok(Math.abs(out.quotes["europe-senegal"][0].feePct - 0.005) < 1e-9);
  assert.deepEqual(out.quotes["europe-senegal"][0].payout, ["mobile"]);
});

await check("adapter without env vars is skipped, not a failure", async () => {
  const out = await new PartnerFeedAdapter(read("data/adapters/lemfi.json")).fetchQuotes({ env: {}, fetchImpl: sampleFetch("data/adapters/sample/lemfi.json"), now: NOW, routes: ROUTES });
  assert.equal(out.skipped, "no env");
  assert.deepEqual(out.quotes, {});
});

await check("two feed failures in a row alert the owner once", async () => {
  const state = {};
  let alerts = 0;
  const notify = async (msg) => { alerts++; assert.match(msg.subject, /failed twice/); return { sent: "test" }; };
  const quotesFile = { updatedAt: "", coverage: {}, quotes: {} };
  const adapter = new PartnerFeedAdapter(read("data/adapters/lemfi.json"));
  const opts = { adapters: [adapter], env, fetchImpl: failFetch, now: NOW, routes: ROUTES, state, notify, quotesFile, ...base };
  await runFeeds(opts);
  assert.equal(state.lemfi.consecutiveFailures, 1);
  assert.equal(alerts, 0);
  await runFeeds(opts);
  assert.equal(state.lemfi.consecutiveFailures, 2);
  assert.equal(alerts, 1);
  await runFeeds(opts);
  assert.equal(alerts, 1, "no new alert while the feed is still down");
});

await check("merge keeps a fresh hand check and does not publish the feed row", async () => {
  const hand = { provider: "lemfi", rate: 1800, feeFixed: 0, feePct: 0, payout: ["bank"], speed: "", note: "Hand checked", checkedAt: "2026-11-18T17:00:00Z", refAmount: 250 };
  const qf = { updatedAt: "", coverage: {}, quotes: { "uk-nigeria": [hand] } };
  const incoming = { "uk-nigeria": [{ provider: "lemfi", rate: 1900.5, feeFixed: 0, feePct: 0, payout: ["bank"], speed: "Minutes", note: "From LemFi's official partner feed (partner feed); confirm on the provider's site", checkedAt: "2026-11-18T16:00:00Z", source: "partner-feed", feed: true }] };
  const m = mergeQuotes(qf, incoming, base);
  assert.equal(m.kept, 1);
  assert.equal(m.added, 0);
  assert.equal(qf.quotes["uk-nigeria"][0].rate, 1800);
});

await check("merge publishes a partner row, updates coverage and fills refAmount", async () => {
  const qf = { updatedAt: "", coverage: {}, quotes: {} };
  const incoming = { "uk-nigeria": [{ provider: "lemfi", rate: 1900.5, feeFixed: 0, feePct: 0, payout: ["bank"], speed: "Minutes", note: "From LemFi's official partner feed (partner feed); confirm on the provider's site", checkedAt: "2026-11-18T16:00:00Z", source: "partner-feed", feed: true }] };
  const m = mergeQuotes(qf, incoming, base);
  assert.equal(m.added, 1);
  assert.deepEqual(qf.coverage["uk-nigeria"], ["lemfi"]);
  assert.equal(qf.quotes["uk-nigeria"][0].refAmount, 250);
  assert.equal(qf.quotes["uk-nigeria"][0].source, "partner-feed");
  assert.ok(qf.quotes["uk-nigeria"][0].note.includes("(partner feed)"));
});

await check("merge drops a quote older than 24 hours", async () => {
  const qf = { updatedAt: "", coverage: {}, quotes: {} };
  const incoming = { "uk-nigeria": [{ provider: "lemfi", rate: 1900, feeFixed: 0, feePct: 0, payout: ["bank"], speed: "", note: "From LemFi's official partner feed (partner feed)", checkedAt: "2026-11-16T10:00:00Z", source: "partner-feed", feed: true }] };
  const m = mergeQuotes(qf, incoming, base);
  assert.equal(m.added, 0);
  assert.ok(m.dropped.some((d) => /older than 24h/.test(d)));
});

await check("payout and CSV helpers", async () => {
  assert.deepEqual(normalizePayout("bank transfer, mobile money, cash pickup"), ["bank", "mobile", "cash"]);
  const rows = csvRows("a,b\n1,\"two, too\"\n");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].a, "1");
  assert.equal(rows[0].b, "two, too");
});

await check("Wise stored-feed adapter returns the internal format", async () => {
  const out = await new WiseFeedAdapter().fetchQuotes({ now: NOW, feedFile: "data/adapters/sample/wise-feed.json", routes: ROUTES });
  assert.equal(out.quotes["uk-nigeria"][0].provider, "wise");
  assert.equal(out.quotes["uk-nigeria"][0].source, "wise-feed");
  assert.equal(out.quotes["uk-nigeria"][0].rate, 1900);
});

await check("owner alert uses Resend, and reports when no channel is configured", async () => {
  const calls = [];
  const res = await notifyOwner({ subject: "s", text: "t" }, { env: { RESEND_API_KEY: "r", OWNER_ALERT_EMAIL: "owner@sendfair.africa" }, fetchImpl: async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; } });
  assert.equal(res.sent, "resend");
  assert.equal(calls[0].body.to[0], "owner@sendfair.africa");
  const none = await notifyOwner({ subject: "s", text: "t" }, { env: {}, fetchImpl: async () => ({ ok: true }) });
  assert.equal(none.sent, false);
});

await check("adapter code never scrapes a provider website", async () => {
  for (const f of ["scripts/providers/adapter.mjs", "scripts/providers/partner-feed.mjs", "scripts/providers/wise.mjs", "scripts/providers/merge.mjs"]) {
    const code = fs.readFileSync(f, "utf8");
    assert.ok(!/playwright|puppeteer|chromium/i.test(code), `${f} must not scrape`);
  }
});

console.log(`adapters: ${checks} checks, ${failures} failure(s)`);
if (failures) process.exitCode = 1;
