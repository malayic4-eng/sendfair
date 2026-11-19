// Data-accuracy checks, no network: shared-currency country matching, purge of copied quotes, fee tiers,
// USD->USD routes, the "mid-market looks wrong" guard, stale overrides, and unchanged behaviour without tiers.
//   node scripts/test-data-accuracy.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  sharedCurrencies, routeInfo, pickQuote, cleanFeed, purgeCopiedQuotes, applyWiseFeed,
  applyOverrides, deriveMidOverrides, freshnessProblems
} from "./feed-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = createRequire(import.meta.url)(path.join(ROOT, "src/rank.js"));
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
const corridors = read("data/corridors.json");
const config = read("config.json");
const provList = read("data/providers.json").providers;
const providers = Object.fromEntries(provList.map((p) => [p.id, p]));

let n = 0, failed = 0;
async function check(name, fn) {
  n++;
  try { await fn(); console.log("ok " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n  ") : e)); }
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const NOW = Date.parse("2026-11-19T12:00:00Z");
const iso = (hAgo) => new Date(NOW - hAgo * 3600000).toISOString();
const base = { providers, payout: "all", now: NOW, staleH: 36, hideH: 72, handLockH: 6 };

// ---------- 1. Shared-currency country matching ----------
await check("shared receive currencies are USD and XOF (from corridors.json)", () => {
  const s = sharedCurrencies(corridors);
  assert.ok(s.has("USD") && s.has("XOF"));
  assert.ok(!s.has("NGN") && !s.has("XAF"));
  assert.equal(routeInfo(corridors, "uk-zimbabwe").shared, true);
  assert.equal(routeInfo(corridors, "uk-nigeria").shared, false);
  assert.equal(routeInfo(corridors, "us-drc").same, true);
});

await check("pickQuote: shared currency needs a quote marked with this country, never quotes[0]", () => {
  const quotes = [{ rate: 1.25 }, { rate: 1.3, targetCountry: "CD" }];
  assert.equal(pickQuote(quotes, "ZW", true), null);
  assert.equal(pickQuote(quotes, "CD", true).quote.rate, 1.3);
  assert.equal(pickQuote(quotes, "CD", true).country, "CD");
  assert.equal(pickQuote([{ rate: 1.25 }], "ZW", true), null);
});

await check("pickQuote: unique currency takes a currency-only quote but never another country's", () => {
  assert.equal(pickQuote([{ rate: 1900 }], "NG", false).quote.rate, 1900);
  assert.equal(pickQuote([{ rate: 1900 }], "NG", false).country, null);
  assert.equal(pickQuote([{ rate: 600, targetCountry: "GA" }], "CM", false), null);
  assert.equal(pickQuote([{ rate: 600, targetCountry: "GA" }, { rate: 610 }], "CM", false).quote.rate, 610);
  assert.equal(pickQuote([{ rate: 600 }, { rate: 620, targetCountry: "CM" }], "CM", false).quote.rate, 620);
});

await check("fetch-wise-feed (stubbed Wise API): country matching, same-currency routes, tiers, Wise rates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-feed-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  for (const f of ["scripts/fetch-wise-feed.mjs", "scripts/feed-lib.mjs", "config.json", "data/corridors.json", "data/providers.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  // Stub: USD/XOF quotes carry a country only for some providers; fee grows with the amount;
  // USD->USD answers for Zimbabwe only (one provider marked ZW), one route returns 500.
  const stub = path.join(dir, "stub.mjs");
  fs.writeFileSync(stub, `
const ISO = { USD: ["ZW", "CD"], XOF: ["SN", "CI", "ML"] };
globalThis.fetch = async (url) => {
  const u = new URL(url), src = u.searchParams.get("sourceCurrency"), tgt = u.searchParams.get("targetCountry") || u.searchParams.get("targetCurrency"), amt = +u.searchParams.get("sendAmount");
  if (src === "EUR" && tgt === "KES") return { ok: false, status: 500, json: async () => ({}) };
  if (src === tgt && src === "USD") return { ok: true, status: 200, json: async () => ({ providers: [
    { alias: "sendwave", name: "Sendwave", quotes: [{ rate: 1, fee: 2.99, targetCountry: "ZW", dateCollected: "2026-11-19T11:00:00Z" }] } ] }) };
  const r = 100 + (src.length + tgt.charCodeAt(0));
  const fee = (base) => +(base + amt / 500).toFixed(2);
  const providers = [
    { alias: "wise", name: "Wise", quotes: [{ rate: r, fee: fee(1), dateCollected: "2026-11-19T11:00:00Z" }] },
    { alias: "remitly", name: "Remitly", quotes: [{ rate: r * 0.99, fee: fee(1.99), dateCollected: "2026-11-19T11:00:00Z" }] },
    { alias: "westernunion", name: "Western Union", quotes: (ISO[tgt] || [null]).map((c, i) => ({ rate: r * (0.97 - i * 0.01), fee: fee(2.49), targetCountry: c, dateCollected: "2026-11-19T11:00:00Z" })) }
  ];
  return { ok: true, status: 200, json: async () => ({ providers }) };
};`);
  execFileSync(process.execPath, ["--import", stub, path.join(dir, "scripts/fetch-wise-feed.mjs")], { env: { ...process.env, WISE_API_TOKEN: "test", WISE_FEED_PAUSE_MS: "0" }, stdio: "pipe" });
  const out = JSON.parse(fs.readFileSync(path.join(dir, "data/wise-feed.json"), "utf8"));
  // Shared USD: only Western Union (marked per country) and each country gets its own rate.
  assert.deepEqual(Object.keys(out.routes["uk-zimbabwe"]), ["westernunion"]);
  assert.equal(out.routes["uk-zimbabwe"].westernunion.country, "ZW");
  assert.equal(out.routes["uk-drc"].westernunion.country, "CD");
  assert.notEqual(out.routes["uk-zimbabwe"].westernunion.rate, out.routes["uk-drc"].westernunion.rate);
  assert.deepEqual(Object.keys(out.routes["uk-mali"]), ["westernunion"]);
  // Unique currency: currency-only quotes accepted.
  assert.deepEqual(Object.keys(out.routes["uk-nigeria"]).sort(), ["remitly", "westernunion", "wise"]);
  // USD -> USD: fetched (Zimbabwe), DR Congo has nothing marked for it.
  assert.equal(out.routes["us-zimbabwe"].sendwave.rate, 1);
  assert.deepEqual(out.routes["us-drc"], {});
  // A failing route is skipped, the rest kept.
  assert.equal(out.routes["europe-kenya"], undefined);
  // Tiers at the sender's quick amounts, reference amount included, sorted.
  assert.deepEqual(out.tiers["uk-nigeria"].remitly.map((t) => t.amount), config.quickAmounts.GBP);
  assert.equal(out.tiers["uk-nigeria"].remitly.find((t) => t.amount === 1000).fee, 3.99);
  assert.equal(out.routes["uk-nigeria"].remitly.fee, 2.49); // reference amount 250
  assert.equal(out.tiers["uk-zimbabwe"].remitly, undefined);
  // Wise's own rate per currency pair, including on shared-currency routes (for mid-from-wise.mjs).
  assert.ok(out.wiseRates["GBP-USD"] && out.wiseRates["GBP-XOF"] && out.wiseRates["GBP-NGN"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("rank: feed row on a shared-currency route without this country is ignored", () => {
  const feed = { remitly: { rate: 1.29, fee: 1.99, collected: iso(1) }, westernunion: { rate: 1.28, fee: 2.49, collected: iso(1), country: "ZW" } };
  const zw = R.rank({ ...base, list: [], feed, amount: 250, mid: 1.315, country: "ZW", sharedCurrency: true });
  assert.deepEqual(zw.map((x) => x.p.id), ["westernunion"]);
  const cd = R.rank({ ...base, list: [], feed, amount: 250, mid: 1.315, country: "CD", sharedCurrency: true });
  assert.equal(cd.length, 0);
  // Without the options (older callers) nothing changes.
  assert.equal(R.rank({ ...base, list: [], feed, amount: 250, mid: 1.315 }).length, 2);
});

// ---------- 2. Purge of copied quotes ----------
await check("purge: copied Wise-feed quotes removed on shared routes, hand checks and marked quotes kept", () => {
  const qf = { quotes: {
    "uk-zimbabwe": [
      { provider: "remitly", rate: 1.29, feeFixed: 1.99, payout: ["bank"], checkedAt: iso(1), source: "wise-feed" },
      { provider: "skrill", rate: 1.25, feeFixed: 0, payout: ["bank"], checkedAt: iso(1), note: "Updated automatically from Wise's comparison data; confirm" },
      { provider: "westernunion", rate: 1.28, feeFixed: 2.49, payout: ["bank"], checkedAt: iso(1), source: "wise-feed", country: "ZW" },
      { provider: "sendwave", rate: 1.301, feeFixed: 1.99, payout: ["mobile"], checkedAt: iso(1) },
      { provider: "worldremit", rate: 1.3, feeFixed: 1.99, payout: ["bank"], checkedAt: iso(1), source: "worldremit" }
    ],
    "uk-nigeria": [{ provider: "remitly", rate: 1900, feeFixed: 1.99, payout: ["bank"], checkedAt: iso(1), source: "wise-feed" }]
  } };
  const removed = purgeCopiedQuotes(qf, corridors);
  assert.deepEqual(removed.sort(), ["uk-zimbabwe remitly", "uk-zimbabwe skrill"]);
  assert.deepEqual(qf.quotes["uk-zimbabwe"].map((q) => q.provider), ["westernunion", "sendwave", "worldremit"]);
  assert.equal(qf.quotes["uk-nigeria"].length, 1);
});

await check("purge on the stored data: uk-zimbabwe and uk-drc keep no copied Wise-feed quotes", () => {
  const qf = read("data/quotes.json");
  purgeCopiedQuotes(qf, corridors);
  for (const k of ["uk-zimbabwe", "uk-drc", "us-zimbabwe", "uk-senegal", "uk-mali", "uk-ivorycoast"]) {
    assert.ok(!(qf.quotes[k] || []).some((q) => q.source === "wise-feed" && q.country !== routeInfo(corridors, k).iso2), k);
  }
});

await check("cleanFeed + applyWiseFeed: unmarked rows held back on shared routes, tiers stored on quotes", () => {
  const feed = {
    updatedAt: iso(0.5),
    routes: {
      "uk-zimbabwe": { remitly: { rate: 1.29, fee: 1.99, collected: iso(1) }, westernunion: { rate: 1.28, fee: 2.49, collected: iso(1), country: "ZW" } },
      "uk-drc": { remitly: { rate: 1.29, fee: 1.99, collected: iso(1) } },
      "uk-nigeria": { remitly: { rate: 1900, fee: 1.99, collected: iso(1) } }
    },
    tiers: {
      "uk-zimbabwe": { remitly: [{ amount: 100, rate: 1.29, fee: 1.99 }, { amount: 250, rate: 1.29, fee: 1.99 }] },
      "uk-nigeria": { remitly: [{ amount: 100, rate: 1895, fee: 0.99 }, { amount: 250, rate: 1900, fee: 1.99 }, { amount: 1000, rate: 1905, fee: 3.99 }] }
    }
  };
  const { feed: clean, dropped } = cleanFeed(feed, corridors);
  assert.deepEqual(dropped.sort(), ["uk-drc remitly", "uk-zimbabwe remitly"]);
  assert.deepEqual(Object.keys(clean.routes["uk-zimbabwe"]), ["westernunion"]);
  assert.deepEqual(clean.tiers["uk-zimbabwe"], {});
  const qf = { quotes: { "uk-drc": [{ provider: "ofx", rate: 1.29, feeFixed: 7, payout: ["bank"], checkedAt: iso(2), source: "wise-feed" }] } };
  const mid = { USD: 1, GBP: 0.76, NGN: 1460 };
  const res = applyWiseFeed({ feed, quotesFile: qf, config, corridors, provList, mid, now: NOW });
  assert.deepEqual(res.purged, ["uk-drc ofx"]);
  assert.equal(res.held.filter((h) => /not marked/.test(h)).length, 2);
  assert.deepEqual(qf.quotes["uk-drc"], []);
  assert.equal(qf.quotes["uk-zimbabwe"][0].country, "ZW");
  const ng = qf.quotes["uk-nigeria"][0];
  assert.equal(ng.tiers.length, 3);
  assert.equal(ng.refAmount, 250);
});

// ---------- 3. Tiers ----------
const TIERS = [{ amount: 100, rate: 1900, fee: 1.99 }, { amount: 250, rate: 1910, fee: 2.99 }, { amount: 500, rate: 1915, fee: 3.99 }, { amount: 1000, rate: 1920, fee: 4.99 }];
await check("tierAt: fee at 100/250/500/1000/2000 and between, rate from the nearest tier", () => {
  near(R.tierAt(TIERS, 100).fee, 1.99);
  near(R.tierAt(TIERS, 250).fee, 2.99);
  near(R.tierAt(TIERS, 500).fee, 3.99);
  near(R.tierAt(TIERS, 1000).fee, 4.99);
  near(R.tierAt(TIERS, 2000).fee, 6.99); // straight line through 500 and 1000
  near(R.tierAt(TIERS, 750).fee, 4.49);
  near(R.tierAt(TIERS, 175).fee, 2.49);
  near(R.tierAt(TIERS, 50).fee, 1.99 - 50 / 150);
  assert.equal(R.tierAt(TIERS, 2000).rate, 1920);
  assert.equal(R.tierAt(TIERS, 300).rate, 1910);
  assert.equal(R.tierAt(TIERS, 400).rate, 1915);
  assert.equal(R.tierAt(TIERS, 2000).covered, true);
  assert.equal(R.tierAt(TIERS, 4000).covered, false);
  // Unsorted input, a falling fee clamps at 0, and fewer than two valid tiers means no tiers.
  near(R.tierAt([{ amount: 1000, rate: 2, fee: 0 }, { amount: 100, rate: 1, fee: 3 }], 2000).fee, 0);
  assert.equal(R.tierAt([{ amount: 100, rate: 1, fee: 1 }], 100), null);
  assert.equal(R.tierAt([{ amount: 100, rate: 0, fee: 1 }, { amount: 200, rate: 1, fee: 1 }], 100), null);
});

await check("evaluate/rank use tiers: the fee at 1000 is the 1000 fee, not the reference fee", () => {
  const q = { provider: "remitly", rate: 1910, feeFixed: 2.99, feePct: 0, payout: ["bank"], checkedAt: iso(1), source: "wise-feed", refAmount: 250, tiers: TIERS };
  const ev = R.evaluate(q, 1000);
  near(ev.fee, 4.99); near(ev.rate, 1920); near(ev.gets, (1000 - 4.99) * 1920);
  const legacy = R.evaluate({ ...q, tiers: undefined }, 1000);
  near(legacy.fee, 2.99); near(legacy.rate, 1910);
  // payFor settles on the tier for the amount paid
  const pay = R.payFor(q, 1900000);
  near(R.evaluate(q, pay).gets, 1900000, 1);
  // Through the feed: tiers passed as feedTiers
  const rows = R.rank({ ...base, list: [], feed: { remitly: { rate: 1910, fee: 2.99, collected: iso(1) } }, feedTiers: { remitly: TIERS }, amount: 1000, mid: 1925, refAmount: 250 });
  near(rows[0].ev.fee, 4.99);
  // ... and kept from the published quote of the same collection when the caller passes no tiers
  const rows2 = R.rank({ ...base, list: [q], feed: { remitly: { rate: 1910, fee: 2.99, collected: q.checkedAt } }, amount: 1000, mid: 1925, refAmount: 250 });
  near(rows2[0].ev.fee, 4.99);
});

await check("refWarning/ref text only when no tiers cover the amount", () => {
  const ctx = (rows, amount) => ({ s: { id: "uk", currency: "GBP", short: "UK" }, r: { id: "nigeria", currency: "NGN", name: "Nigeria" }, key: "uk-nigeria", amount, rows, mid: 1925, now: NOW, hrefFor: () => "#", disclosureHref: "#", avgPct: 8, avgLabel: "" });
  const q = { provider: "remitly", rate: 1910, feeFixed: 2.99, payout: ["bank"], checkedAt: iso(1), source: "wise-feed", refAmount: 250, tiers: TIERS };
  const at = (list, a) => R.renderResults(ctx(R.rank({ ...base, list, amount: a, mid: 1925 }), a));
  assert.ok(!/refwarn/.test(at([q], 1000)));
  assert.ok(!/checked for GBP/.test(at([q], 1000)));
  assert.ok(/refwarn/.test(at([q], 5000)));
  const legacy = { ...q, tiers: undefined };
  assert.ok(/refwarn/.test(at([legacy], 1000)));
  assert.ok(/checked for GBP/.test(at([legacy], 1000)));
  assert.ok(!/refwarn/.test(at([legacy], 250)));
});

// ---------- 4. USD -> USD ----------
await check("USD->USD: mid 1, rate 1, fee-only cost; rates above 1.015 still dropped", () => {
  const mm = { base: "USD", rates: { USD: 1 } };
  const mid = R.midRate(mm, "USD", "USD");
  assert.equal(mid, 1);
  const ev = R.evaluate({ rate: 1, feeFixed: 2.99 }, 300);
  near(ev.gets, 297.01);
  const list = [
    { provider: "sendwave", rate: 1, feeFixed: 2.99, payout: ["mobile"], checkedAt: iso(1), source: "wise-feed", country: "ZW" },
    { provider: "remitly", rate: 1, feeFixed: 3.99, payout: ["bank"], checkedAt: iso(1), source: "wise-feed", country: "ZW" },
    { provider: "xoom", rate: 1.05, feeFixed: 0, payout: ["bank"], checkedAt: iso(1), source: "wise-feed", country: "ZW" }
  ];
  const rows = R.rank({ ...base, list, amount: 300, mid, country: "ZW", sharedCurrency: true });
  assert.deepEqual(rows.map((x) => x.p.id), ["sendwave", "remitly"]);
  near(rows[0].cost, 2.99 / 300);
  assert.ok(!rows.midSuspect);
  const html = R.renderResults({ s: { id: "us", currency: "USD", short: "US" }, r: { id: "zimbabwe", currency: "USD", name: "Zimbabwe" }, key: "us-zimbabwe", amount: 300, rows, mid, now: NOW, hrefFor: () => "#", disclosureHref: "#", avgPct: 8, avgLabel: "", ssa: true });
  assert.ok(/USD<\/span>297\.01/.test(html));
  assert.equal(R.metaLine({ s: { currency: "USD" }, r: { currency: "USD" }, mid, rows, now: NOW }).indexOf("Mid-market"), -1);
});

await check("USD->USD with no quotes: honest 'no online prices' state", () => {
  const rows = R.rank({ ...base, list: [], feed: null, amount: 300, mid: 1 });
  const html = R.renderResults({ s: { id: "us", currency: "USD", short: "US" }, r: { id: "drc", currency: "USD", name: "DR Congo" }, key: "us-drc", amount: 300, rows, mid: 1, anyQuotes: false, now: NOW, hrefFor: () => "#", disclosureHref: "#", avgPct: 8, avgLabel: "", checkList: [] });
  assert.ok(/No online price for US to DR Congo has been checked yet/.test(html));
  assert.ok(!/class="result/.test(html));
});

// ---------- 5. "Mid looks wrong" guard ----------
const NG_LIST = [
  { provider: "wise", rate: 1920.48, feeFixed: 1.97, payout: ["bank"], checkedAt: iso(1), source: "wise-feed" },
  { provider: "westernunion", rate: 1861.4, feeFixed: 1.99, payout: ["bank"], checkedAt: iso(1), source: "wise-feed" },
  { provider: "xoom", rate: 1810.6, feeFixed: 2.29, payout: ["bank"], checkedAt: iso(1), source: "wise-feed" },
  { provider: "worldremit", rate: 1890, feeFixed: 0.99, payout: ["bank"], checkedAt: iso(1), source: "worldremit" },
  { provider: "sendwave", rate: 1880, feeFixed: 0, payout: ["mobile"], checkedAt: iso(1) }
];
await check("mid guard: stale NGN mid (1354 vs Wise ~1460) keeps every row, hides the cost and benchmark", () => {
  const staleMid = R.midRate({ rates: { USD: 1, GBP: 0.7600, NGN: 1354.04 } }, "GBP", "NGN");
  const rows = R.rank({ ...base, list: NG_LIST, amount: 250, mid: staleMid });
  assert.equal(rows.length, 5);
  assert.equal(rows.midSuspect, true);
  assert.ok(rows.every((x) => x.cost === null));
  const c = { s: { id: "uk", currency: "GBP", short: "UK" }, r: { id: "nigeria", currency: "NGN", name: "Nigeria" }, key: "uk-nigeria", amount: 250, rows, mid: staleMid, now: NOW, hrefFor: () => "#", disclosureHref: "#", avgPct: 8.46, avgLabel: "x", ssa: true };
  const html = R.renderResults(c);
  assert.ok(!/class="benchmark"/.test(html));
  assert.ok(/may be out of date/.test(R.metaLine(c)));
});

await check("mid guard: with a correct mid, a single outlier above mid × 1.015 is still dropped", () => {
  const goodMid = 1460.83 / 0.7602;
  const list = NG_LIST.concat([{ provider: "remitly", rate: goodMid * 1.05, feeFixed: 0, payout: ["bank"], checkedAt: iso(1), source: "wise-feed" }]);
  const rows = R.rank({ ...base, list, amount: 250, mid: goodMid });
  assert.ok(!rows.midSuspect);
  assert.ok(!rows.some((x) => x.p.id === "remitly"));
  assert.ok(rows.every((x) => typeof x.cost === "number"));
  // One automatic quote is not enough evidence against the mid-market rate.
  const one = R.rank({ ...base, list: [{ ...list[5] }], amount: 250, mid: goodMid });
  assert.equal(one.length, 0);
});

// ---------- Overrides and freshness ----------
await check("overrides: used when older than 36 h (marked stale, real time per currency), dropped after 7 days", () => {
  const mk = () => ({ base: "USD", updatedAt: iso(2), rates: { USD: 1, GBP: 0.76, NGN: 1354 } });
  const ov = { updatedAt: iso(40), rates: { NGN: 1460 } };
  const m1 = mk();
  assert.equal(applyOverrides(m1, ov, NOW).applied, true);
  assert.equal(m1.rates.NGN, 1460);
  assert.equal(m1.overrideStale, true);
  assert.equal(R.midAt(m1, "GBP", "NGN"), ov.updatedAt); // the older of the two times
  assert.equal(R.midAt(m1, "GBP", "KES"), m1.updatedAt);
  const m2 = mk();
  assert.equal(applyOverrides(m2, { updatedAt: iso(24 * 8), rates: { NGN: 1460 } }, NOW).applied, false);
  assert.equal(m2.rates.NGN, 1354);
  const m3 = mk();
  applyOverrides(m3, { updatedAt: iso(1), rates: { NGN: 1460 } }, NOW);
  assert.equal(m3.overrideStale, false);
});

await check("deriveMidOverrides: every receiving currency Wise quoted, sender currencies vs USD, 25% bound", () => {
  const mid = { base: "USD", rates: { USD: 1, GBP: 0.76, EUR: 0.91, NGN: 1354, KES: 130, GHS: 11.7, ETB: 100 } };
  const feed = {
    wiseRates: {
      "USD-NGN": { rate: 1460, collected: iso(1) }, "GBP-NGN": { rate: 1460 / 0.7605, collected: iso(1) },
      "USD-KES": { rate: 130.05, collected: iso(1) }, "GBP-KES": { rate: 130.05 / 0.7605, collected: iso(1) },
      "USD-GHS": { rate: 11.76, collected: iso(10) }, // too old
      "USD-ETB": { rate: 160, collected: iso(1) } // 60% away: ignored
    },
    routes: { "europe-nigeria": { wise: { rate: 1460 / 0.91, collected: iso(1) } } }
  };
  const { rates } = deriveMidOverrides({ mid, feed, corridors, now: NOW });
  near(rates.NGN, 1460, 0.01);
  near(rates.KES, 130.05, 0.001);
  near(rates.GBP, 0.7605, 1e-6);
  assert.equal(rates.GHS, undefined);
  assert.equal(rates.ETB, undefined);
  assert.equal(rates.USD, undefined);
});

await check("freshness: >6 h old or empty feed is a problem; fresh feed is fine", () => {
  assert.deepEqual(freshnessProblems({ feed: { updatedAt: iso(1), routes: { "uk-nigeria": { wise: {} } } }, now: NOW }), []);
  assert.equal(freshnessProblems({ feed: { updatedAt: iso(7), routes: { "uk-nigeria": { wise: {} } } }, now: NOW }).length, 1);
  assert.equal(freshnessProblems({ feed: { updatedAt: iso(1), routes: {} }, now: NOW }).length, 1);
  assert.equal(freshnessProblems({ feed: null, now: NOW }).length, 1);
});

await check("check-data-fresh.mjs exits 1 on a stale feed and 0 on a fresh one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-fresh-"));
  const f = path.join(dir, "feed.json");
  fs.writeFileSync(f, JSON.stringify({ updatedAt: iso(8), routes: { "uk-nigeria": { wise: { rate: 1 } } } }));
  const env = { ...process.env, RESEND_API_KEY: "", OWNER_ALERT_EMAIL: "", OWNER_ALERT_WEBHOOK: "" };
  const run = () => { try { execFileSync(process.execPath, [path.join(ROOT, "scripts/check-data-fresh.mjs"), "--feed=" + f, "--now=" + new Date(NOW).toISOString()], { env, stdio: "pipe" }); return 0; } catch (e) { return e.status; } };
  assert.equal(run(), 1);
  fs.writeFileSync(f, JSON.stringify({ updatedAt: iso(1), routes: { "uk-nigeria": { wise: { rate: 1 } } } }));
  assert.equal(run(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 6. Without tiers nothing changes ----------
await check("without tiers or country options, evaluate/payFor/rank give the same numbers as before", () => {
  const q = { provider: "remitly", rate: 1900, feeFixed: 1.99, feePct: 0.5, payout: ["bank"], checkedAt: iso(1), refAmount: 250 };
  const ev = R.evaluate(q, 250);
  const sent = (250 - 1.99) / 1.005;
  near(ev.sent, sent); near(ev.gets, sent * 1900); near(ev.fee, 250 - sent);
  assert.equal(ev.tier, null);
  near(R.payFor(q, 100000), (100000 / 1900) * 1.005 + 1.99);
  // fee legacy field
  near(R.evaluate({ rate: 2, fee: 3 }, 10).gets, 14);
  // A feed row without tiers: same fee at every amount (old behaviour), refAmount from the options.
  const rows = R.rank({ ...base, list: [], feed: { remitly: { rate: 1910, fee: 2.99, collected: iso(1) } }, amount: 1000, mid: 1925, refAmount: 250 });
  near(rows[0].ev.fee, 2.99);
  assert.equal(rows[0].q.refAmount, 250);
  assert.equal(rows[0].q.tiers, undefined);
  near(rows[0].cost, 1 - rows[0].gets / (1000 * 1925));
  // Hand-check lock still wins over the feed.
  const hand = { provider: "remitly", rate: 1800, feeFixed: 0, payout: ["mobile"], checkedAt: iso(2) };
  const r2 = R.rank({ ...base, list: [hand], feed: { remitly: { rate: 1910, fee: 2.99, collected: iso(1) } }, amount: 250, mid: 1925 });
  assert.equal(r2[0].q.rate, 1800);
});

console.log(`data accuracy: ${n} checks, ${failed} failure(s)`);
if (failed) process.exit(1);
