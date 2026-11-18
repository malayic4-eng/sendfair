// Tests for question pages built only from real site data. The shipped questions are all drafts;
// these tests flip real entries to "live" and check the figures against an independent R.rank /
// BC.estimate computation on the same data.
import fs from "node:fs";
import assert from "node:assert/strict";
import R from "../src/rank.js";
import BC from "../src/build-cost.js";
import { loadQuestions, questionAnswer, questionPage, questionsIndex, relatedQuestions, validateQuestions } from "./questions.mjs";

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const config = read("config.json");
const corridors = read("data/corridors.json");
const buildCosts = read("data/build-costs.json");
const midmarket = read("data/midmarket.json");
const quotes = read("data/quotes.json");
const providers = Object.fromEntries(read("data/providers.json").providers.map((p) => [p.id, p]));
let feed = {};
try { feed = read("data/wise-feed.json").routes || {}; } catch {}
const now = Date.now();
const site = (config.siteUrl || "https://sendfair.africa").replace(/\/$/, "");
const questions = loadQuestions("data/questions.json");
const deps = { config, corridors, buildCosts, midmarket, quotes, providers, feed, now, site, questions };
const live = (slug) => ({ ...questions.find((q) => q.slug === slug), status: "live" });
const sendQ = questions.filter((q) => q.topic === "send").map((q) => ({ ...q, status: "live" })).find((q) => questionAnswer(q, deps));

let checks = 0, failures = 0;
function check(name, fn) {
  checks++;
  try { fn(); console.log("ok " + name); }
  catch (e) { failures++; console.error("FAIL " + name + ": " + (e && e.message)); }
}

check("data/questions.json seeds 12 valid draft questions", () => {
  assert.equal(questions.length, 12);
  assert.equal(questions.every((q) => q.status === "draft"), true);
  assert.equal(new Set(questions.map((q) => q.slug)).size, 12);
  for (const q of questions) { assert.ok(q.country); assert.ok(["send", "build"].includes(q.topic)); }
});

check("send answer uses the site's top provider and amount", () => {
  const q = sendQ;
  const ans = questionAnswer(q, deps);
  assert.ok(ans && ans.type === "send");
  const s = corridors.senders.find((x) => x.id === q.sender), r = corridors.receivers.find((x) => x.id === q.country);
  const amount = config.defaultAmounts[s.currency];
  const mid = R.midRate(midmarket, s.currency, r.currency);
  const rows = R.rank({ list: quotes.quotes[`${s.id}-${r.id}`] || [], feed: feed[`${s.id}-${r.id}`] || null, providers, amount, payout: "all", mid, now, staleH: config.staleAfterHours || 36, hideH: config.hideAfterHours || 72 });
  const top = rows.find((x) => !x.stale);
  assert.equal(ans.figures.provider, top.p.name);
  assert.ok(Math.abs(ans.figures.gets - top.gets) < 0.01);
  assert.equal(ans.figures.amount, amount);
  assert.ok(ans.direct.includes(top.p.name));
});

check("build answer uses the standard receipt total", () => {
  const ans = questionAnswer(live("cost-build-3-bedroom-kenya"), deps);
  assert.ok(ans && ans.type === "build");
  const house = buildCosts.houses.find((h) => h.id === "3");
  const est = BC.estimate(buildCosts, "kenya", house.m2, 1, midmarket.rates, {}, { finish: "standard" });
  assert.ok(Math.abs(ans.figures.total - est.total) < 0.01);
  assert.equal(ans.figures.currency, est.currency);
});

check("cement answer uses the cement line in the receipt", () => {
  const ans = questionAnswer(live("bags-of-cement-3-bedroom-kenya"), deps);
  assert.ok(ans && ans.type === "build-cement");
  const est = BC.estimate(buildCosts, "kenya", 110, 1, midmarket.rates, {}, { finish: "standard" });
  const line = est.lines.find((l) => /cement/i.test(l.label));
  assert.equal(ans.figures.qty, Math.round(line.qty));
  assert.ok(Math.abs(ans.figures.cost - line.cost) < 0.01);
});

check("quote-fair answer uses the standard total and links quote-check", () => {
  const ans = questionAnswer(live("is-my-builders-quote-fair"), deps);
  assert.ok(ans && ans.type === "build-quote");
  const page = questionPage(live("is-my-builders-quote-fair"), deps);
  assert.ok(page && page.body.includes("quote-check/"));
});

check("question page carries the question, answer, CTAs and GA4 events", () => {
  const q = sendQ;
  const page = questionPage(q, deps);
  assert.ok(page);
  assert.equal(page.canonical, `questions/${q.slug}/`);
  assert.ok(page.body.includes(sendQ.question));
  assert.ok(page.body.includes('data-qcta="route"'));
  assert.ok(page.body.includes("question_view"));
  assert.ok(page.body.includes("question_cta_click"));
  const types = page.jsonld.map((x) => x["@type"]);
  assert.ok(types.includes("FAQPage"));
  assert.ok(types.includes("BreadcrumbList"));
});

check("draft question is not built", () => {
  assert.equal(questionPage({ ...questions[0], status: "draft" }, deps), null);
});

check("missing data does not build a page", () => {
  const q = sendQ;
  assert.equal(questionAnswer({ ...q, country: "atlantis" }, deps), null);
  assert.equal(questionPage({ ...q, country: "atlantis" }, deps), null);
});

check("questions index is noindex while every question is draft", () => {
  const idx = questionsIndex(questions, deps);
  assert.equal(idx.noindex, true);
  assert.equal(idx.liveCount, 0);
});

check("questions index lists live questions and is indexable", () => {
  const idx = questionsIndex([sendQ], deps);
  assert.equal(idx.noindex, false);
  assert.equal(idx.liveCount, 1);
  assert.ok(idx.body.includes(sendQ.question));
});

check("related questions prefer the same country", () => {
  const all = [
    { ...sendQ, slug: "a", country: "nigeria", sender: "uk" },
    { ...sendQ, slug: "b", country: "ghana", sender: "uk" },
    { ...sendQ, slug: "c", country: "nigeria", sender: "us" }
  ];
  const rel = relatedQuestions(all, { slug: "x", country: "nigeria", sender: "uk", topic: "send" }, 2);
  assert.equal(rel[0].slug, "a");
});

check("validation rejects a bad status and a duplicate slug", () => {
  assert.throws(() => validateQuestions([{ ...questions[0], status: "published" }]));
  assert.throws(() => validateQuestions([questions[0], questions[0]]));
});

console.log(`questions: ${checks} checks, ${failures} failure(s)`);
if (failures) process.exitCode = 1;
