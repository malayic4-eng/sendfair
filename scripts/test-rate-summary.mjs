// Tests for the rate-page history summary. Pure fixtures, no build needed.
import assert from "node:assert/strict";
import { historySummary } from "./rate-summary.mjs";

let checks = 0, failures = 0;
function check(name, fn) {
  checks++;
  try { fn(); console.log("ok " + name); }
  catch (e) { failures++; console.error("FAIL " + name + ": " + (e && e.message)); }
}

const day = (n) => new Date(Date.UTC(2026, 10, n)).toISOString().slice(0, 10);
const series = (from, to, startMid = 100) => Array.from({ length: to - from + 1 }, (_, i) => ({ d: day(from + i), mid: startMid + i, best: 1000 + i, amount: 10 }));

check("10 days: change, best day and range are all present", () => {
  const s = historySummary(series(1, 10), { mid: 109 });
  assert.equal(s.days, 10);
  assert.equal(s.lines.length, 3);
  const change = s.lines.find((l) => l.id === "change7");
  assert.ok(Math.abs(change.change - ((109 / 102 - 1) * 100)) < 0.02);
  const best = s.lines.find((l) => l.id === "best30");
  assert.equal(best.date, day(10));
  assert.equal(best.amount, 1009);
  assert.equal(best.sent, 10);
  const range = s.lines.find((l) => l.id === "range30");
  assert.equal(range.low, 100);
  assert.equal(range.high, 109);
});

check("5 days: every line is hidden", () => {
  const s = historySummary(series(6, 10), { mid: 109 });
  assert.equal(s.days, 5);
  assert.deepEqual(s.lines, []);
});

check("7 checks spanning 6 days: no 7-day line, best and range are present", () => {
  const s = historySummary(series(4, 10), { mid: 109 });
  assert.equal(s.days, 7);
  assert.equal(s.change, null);
  assert.equal(s.lines.some((l) => l.id === "change7"), false);
  assert.equal(s.lines.some((l) => l.id === "best30"), true);
  assert.equal(s.lines.some((l) => l.id === "range30"), true);
});

check("no best values: best-day line is hidden, range stays", () => {
  const hist = series(1, 10).map((x) => ({ ...x, best: null }));
  const s = historySummary(hist, { mid: 109 });
  assert.equal(s.best, null);
  assert.equal(s.lines.some((l) => l.id === "best30"), false);
  assert.equal(s.lines.some((l) => l.id === "range30"), true);
});

check("no mid values: change and range are hidden, best stays", () => {
  const hist = series(1, 10).map((x) => ({ ...x, mid: null }));
  const s = historySummary(hist, { mid: null });
  assert.equal(s.change, null);
  assert.equal(s.range, null);
  assert.equal(s.lines.some((l) => l.id === "change7"), false);
  assert.equal(s.lines.some((l) => l.id === "range30"), false);
  assert.equal(s.lines.some((l) => l.id === "best30"), true);
});

check("empty history: no lines", () => {
  assert.deepEqual(historySummary([]).lines, []);
  assert.equal(historySummary(null).days, 0);
});

check("today argument controls the 7-day cutoff", () => {
  // History ends on day 8, but today is day 10, so the 7-day point is day 3 (mid 102).
  const s = historySummary(series(1, 8), { mid: 108, today: day(10) });
  assert.ok(Math.abs(s.change - ((108 / 102 - 1) * 100)) < 0.02);
  assert.equal(s.lines.some((l) => l.id === "change7"), true);
});

console.log(`rate summary: ${checks} checks, ${failures} failure(s)`);
if (failures) process.exitCode = 1;
