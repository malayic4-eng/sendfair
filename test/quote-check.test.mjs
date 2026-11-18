import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { mergeConfig, priceFor } from "../src/quote-check/config.mjs";
import { normaliseUnit, convertUnit } from "../src/quote-check/units.mjs";
import { validateExtraction } from "../src/quote-check/validate.mjs";
import { buildCatalogue } from "../src/quote-check/catalogue.mjs";
import { matchLine } from "../src/quote-check/match.mjs";
import { analyseQuote } from "../src/quote-check/analysis.mjs";
import { bandFor } from "../src/quote-check/verdict.mjs";
import { buildReportPdf } from "../functions/quote-check/pdf-report.mjs";
import { xlsxToText } from "../functions/quote-check/xlsx.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const BC = require(path.join(ROOT, "src/build-cost.js"));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data/build-costs.json"), "utf8"));
const midmarket = JSON.parse(fs.readFileSync(path.join(ROOT, "data/midmarket.json"), "utf8"));
const synonyms = JSON.parse(fs.readFileSync(path.join(ROOT, "data/quote-check/synonyms.json"), "utf8"));
const config = mergeConfig(JSON.parse(fs.readFileSync(path.join(ROOT, "config/quote-check.json"), "utf8")));
const NOW = "2026-11-18T12:00:00.000Z";

function fixture(id) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, `data/quote-check/fixtures/${id}.json`), "utf8"));
}

function analyse(f, overrides = {}) {
  const validation = validateExtraction(f.extraction, { currency: f.quoteCurrency, maxLines: 200 });
  assert.equal(validation.ok, true, validation.errors.join("; "));
  return analyseQuote({
    extraction: validation.extraction,
    validation,
    data,
    countryId: f.country,
    town: f.town,
    bedrooms: f.bedrooms,
    storeys: f.storeys,
    m2: f.m2,
    quoteCurrency: f.quoteCurrency,
    midmarket,
    synonyms,
    config,
    now: NOW,
    ...overrides
  });
}

test("unit names normalise and only safe conversions are made", () => {
  assert.equal(normaliseUnit("bags"), "bag");
  assert.equal(normaliseUnit("per m³"), "m3");
  assert.equal(normaliseUnit("square metres"), "m2");
  assert.equal(normaliseUnit("pcs"), "each");
  assert.equal(normaliseUnit("man days"), "day");

  assert.equal(convertUnit(2, "tonnes", "kg").qty, 2000);
  assert.equal(convertUnit(1000, "kg", "tonne").qty, 1);
  assert.equal(convertUnit(10, "sheets", "m2", { itemKey: "roof", roofSheetM2: 2.7 }).qty, 27);
  assert.equal(convertUnit(5, "bars", "kg", { itemKey: "steel", steelBarKg: 10.65 }).qty, 53.25);
  assert.equal(convertUnit(2, "lorry loads", "m3", { itemKey: "sand", lorryM3: { sand: 11 } }).qty, 22);
  assert.equal(convertUnit(1, "pieces", "m", { itemKey: "boundary" }), null);
  assert.equal(convertUnit(1, "rolls", "m2", {}), null);
});

test("verdict bands use the configured -15% / +15% / +35% thresholds", () => {
  assert.equal(bandFor(-0.16, config.thresholds).key, "below");
  assert.equal(bandFor(-0.15, config.thresholds).key, "within");
  assert.equal(bandFor(0, config.thresholds).key, "within");
  assert.equal(bandFor(0.15, config.thresholds).key, "within");
  assert.equal(bandFor(0.1501, config.thresholds).key, "above");
  assert.equal(bandFor(0.35, config.thresholds).key, "above");
  assert.equal(bandFor(0.3501, config.thresholds).key, "well_above");
  assert.equal(bandFor(null, config.thresholds).key, "not_checked");
});

test("prices are set for the six supported currencies and fall back to USD", () => {
  assert.deepEqual(priceFor(config, "KES"), { currency: "KES", amount: 1500 });
  assert.deepEqual(priceFor(config, "GBP"), { currency: "GBP", amount: 9 });
  assert.deepEqual(priceFor(config, "UGX"), { currency: "USD", amount: 12 });
});

test("extraction validation recomputes arithmetic and flags a bad line total and total", () => {
  const raw = {
    currency: "KES",
    quote_total: 1500,
    line_items: [
      { description: "Cement", quantity: 10, unit: "bags", unit_price: 700, line_total: 7000, currency: "KES" },
      { description: "Sand", quantity: 2, unit: "m3", unit_price: 100, line_total: 150, currency: "KES" }
    ],
    notes: ""
  };
  const v = validateExtraction(raw, { currency: "KES", maxLines: 200 });
  assert.equal(v.ok, true);
  assert.equal(v.arithmetic.lineErrors.length, 1);
  assert.equal(v.arithmetic.lineErrors[0].kind, "arithmetic");
  assert.equal(v.arithmetic.totalError.writtenTotal, 1500);
  assert.equal(v.extraction.lineItems[0].effectiveTotal, 7000);
});

test("extraction validation rejects unusable input", () => {
  assert.equal(validateExtraction(null, {}).ok, false);
  assert.equal(validateExtraction({ currency: "KES", line_items: [] }, {}).ok, false);
  assert.equal(validateExtraction({ currency: "Shillings", line_items: [{ description: "Cement", quantity: 1, unit: "bag", unit_price: 1, line_total: 1 }] }, {}).ok, false);
  const v = validateExtraction({ currency: "KES", quote_total: 5, line_items: [{ description: "", quantity: 1, unit: "bag", unit_price: 1, line_total: 1 }] }, {});
  assert.equal(v.ok, false);
});

test("matching handles local terms and refuses unsafe comparisons", () => {
  const catalogue = buildCatalogue({ data, countryId: "kenya", rates: midmarket.rates, synonyms, permitTotal: { amount: 26550, source: "Published permit fees" } });
  const roof = matchLine({ description: "Mabati iron sheets, gauge 30", quantity: 220, unit: "m2", unitPrice: 720, lineTotal: 158400 }, catalogue, synonyms, config);
  assert.equal(roof.key, "roof");
  assert.equal(roof.checked, true);
  assert.equal(roof.ourPrice, 580);

  const blocks = matchLine({ description: "6 inch sandcrete blocks", quantity: 4800, unit: "pieces", unitPrice: 42, lineTotal: 201600 }, catalogue, synonyms, config);
  assert.equal(blocks.key, "blocks");
  assert.equal(blocks.checked, true);

  const stones = matchLine({ description: "Machine-cut stones 9x9", quantity: 500, unit: "pieces", unitPrice: 60, lineTotal: 30000 }, catalogue, synonyms, config);
  assert.equal(stones.status, "unit_mismatch");
  assert.equal(stones.checked, false);

  const architect = matchLine({ description: "Architect's fee", quantity: 1, unit: "each", unitPrice: 150000, lineTotal: 150000 }, catalogue, synonyms, config);
  assert.equal(architect.status, "excluded");
  assert.equal(architect.checked, false);

  const nigeria = buildCatalogue({ data, countryId: "nigeria", rates: midmarket.rates, synonyms, permitTotal: null });
  const timber = matchLine({ description: "Timber trusses", quantity: 200, unit: "m2", unitPrice: 30000, lineTotal: 6000000 }, nigeria, synonyms, config);
  assert.equal(timber.status, "unavailable");
  assert.equal(timber.checked, false);
});

test("Kenya fixture: above typical, arithmetic errors, quantity question", () => {
  const f = fixture("kenya");
  const r = analyse(f).report;
  assert.equal(r.summary.band.key, f.expected.verdict);
  assert.equal(r.summary.checkedLines, f.expected.matchedLines);
  assert.equal(r.summary.totalLines, f.expected.totalLines);
  assert.equal(r.unmatched.length, f.expected.unmatchedLines);
  assert.ok(Math.abs(r.summary.differencePct - f.expected.diffPct) < 0.002, `diff ${r.summary.differencePct}`);
  assert.equal(r.quantityChecks.length, f.expected.quantityFlags);
  assert.equal(r.quantityChecks[0].key, "blocks");
  assert.equal(r.arithmetic.lineErrors.length, f.expected.arithmeticLineErrors);
  assert.equal(!!r.arithmetic.totalError, f.expected.totalError);
  for (const desc of f.expected.unmatched) assert.ok(r.unmatched.some((l) => l.description === desc), desc);
  assert.ok(r.questions.length > 5);
});

test("Nigeria fixture: within typical while unmatched timber is not counted", () => {
  const f = fixture("nigeria");
  const r = analyse(f).report;
  assert.equal(r.summary.band.key, f.expected.verdict);
  assert.equal(r.summary.checkedLines, f.expected.matchedLines);
  assert.equal(r.unmatched.length, f.expected.unmatchedLines);
  assert.ok(Math.abs(r.summary.differencePct - f.expected.diffPct) < 0.002, `diff ${r.summary.differencePct}`);
  assert.equal(r.quantityChecks.length, f.expected.quantityFlags);
  assert.equal(r.arithmetic.lineErrors.length, 0);
  assert.ok(r.unmatched.some((l) => l.description === "Timber trusses" && l.match.status === "unavailable"));
});

test("Ghana fixture: well above typical and blocks quantity flagged", () => {
  const f = fixture("ghana");
  const r = analyse(f).report;
  assert.equal(r.summary.band.key, f.expected.verdict);
  assert.equal(r.summary.checkedLines, f.expected.matchedLines);
  assert.equal(r.unmatched.length, f.expected.unmatchedLines);
  assert.ok(Math.abs(r.summary.differencePct - f.expected.diffPct) < 0.002, `diff ${r.summary.differencePct}`);
  assert.equal(r.quantityChecks.length, f.expected.quantityFlags);
  assert.equal(r.quantityChecks[0].key, "blocks");
});

test("a USD quote for Kenya is converted at the mid-market rate and says so", () => {
  const f = fixture("kenya");
  const usd = {
    ...f,
    quoteCurrency: "USD",
    extraction: {
      currency: "USD",
      quote_total: 28000,
      line_items: [
        { description: "Cement, 50kg bags", quantity: 650, unit: "bags", unit_price: 6.3, line_total: 4095, currency: "USD" }
      ]
    }
  };
  const r = analyse(usd).report;
  assert.ok(r.fx.rate > 100, `rate ${r.fx.rate}`);
  assert.match(r.fx.note, /mid-market/);
  assert.equal(r.lines[0].checked, true);
  assert.ok(r.lines[0].quotedForCompare > 400000);
});

test("the PDF report is a valid PDF with a header and an end marker", () => {
  const f = fixture("kenya");
  const r = analyse(f).report;
  const pdf = buildReportPdf(r, { email: "test@example.com", orderId: "abc123" });
  assert.ok(pdf.byteLength > 2000);
  assert.equal(Buffer.from(pdf.subarray(0, 5)).toString("ascii"), "%PDF-");
  assert.equal(Buffer.from(pdf.subarray(-6)).toString("ascii").trim(), "%%EOF");
  const text = Buffer.from(pdf).toString("latin1");
  assert.match(text, /SendFair Quote Check/);
  assert.match(text, /Above typical/);
  assert.match(text, /Questions to ask your builder/);
});

test("the XLSX reader turns the first sheet into tab-separated text", async () => {
  const file = path.join(ROOT, "data/quote-check/fixtures/kenya-boq.xlsx");
  if (!fs.existsSync(file)) return;
  const text = await xlsxToText(new Uint8Array(fs.readFileSync(file)));
  assert.match(text, /Cement/);
  assert.match(text, /Mabati/);
  assert.ok(text.split("\n").length >= 3);
});
