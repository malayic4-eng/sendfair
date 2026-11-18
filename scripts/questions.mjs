// Question pages built from real data. A question is only rendered when its status is "live" and the
// data it needs exists at build time; otherwise the caller skips it. Every figure comes from the same
// ranking (src/rank.js) and house receipt (src/build-cost.js) as the rest of the site.
import fs from "node:fs";
import R from "../src/rank.js";
import BC from "../src/build-cost.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plain = (s) => String(s).replace(/\u00a0/g, " ");
const money = (v, cur) => plain(R.money(v, cur));
const link = (prefix, p) => (prefix + p) || "/";
function dateLong(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
const faqLd = (faqs) => ({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });

function crumbNav(prefix, items) {
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items.map(([name, rel], i) => i === items.length - 1 ? `<li aria-current="page">${esc(name)}</li>` : `<li><a href="${link(prefix, rel)}">${esc(name)}</a></li>`).join("")}</ol></nav>`;
}
function crumbs(items, site) {
  return { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([name, rel], i) => ({ "@type": "ListItem", position: i + 1, name, item: `${site}/${rel}` })) };
}

export function validateQuestions(list) {
  if (!Array.isArray(list) || !list.length) throw new Error("data/questions.json: expected a non-empty list");
  const seen = new Set();
  for (const [i, q] of list.entries()) {
    const where = `data/questions.json[${i}]`;
    if (!q || typeof q !== "object") throw new Error(`${where}: not an object`);
    if (!/^[a-z0-9-]+$/.test(String(q.slug || ""))) throw new Error(`${where}: slug must be lower-case letters, digits and hyphens`);
    if (seen.has(q.slug)) throw new Error(`${where}: duplicate slug ${q.slug}`);
    seen.add(q.slug);
    if (!String(q.question || "").trim()) throw new Error(`${where}: question is empty`);
    if (!["send", "build"].includes(q.topic)) throw new Error(`${where}: topic must be send or build`);
    if (!["draft", "live"].includes(q.status)) throw new Error(`${where}: status must be draft or live`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(q.lastReviewed || "")) || !Number.isFinite(Date.parse(q.lastReviewed))) throw new Error(`${where}: lastReviewed must be YYYY-MM-DD`);
    if (!String(q.country || "").trim()) throw new Error(`${where}: country is required`);
    if (q.topic === "send" && !String(q.sender || "").trim()) throw new Error(`${where}: sender is required for a send question`);
  }
  return list;
}

export function loadQuestions(file = "data/questions.json") {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : (raw && raw.questions) || [];
  return validateQuestions(list);
}

function contextFor(s, r, amount, deps) {
  const key = `${s.id}-${r.id}`;
  const mid = R.midRate(deps.midmarket, s.currency, r.currency);
  const rows = R.rank({
    list: (deps.quotes.quotes || {})[key] || [],
    feed: (deps.feed || {})[key] || null,
    providers: deps.providers,
    amount,
    payout: "all",
    mid: mid || null,
    now: deps.now,
    staleH: (deps.config && deps.config.staleAfterHours) || 36,
    hideH: (deps.config && deps.config.hideAfterHours) || 72
  });
  return { s, r, key, mid, rows };
}

// Returns the direct answer and the figures it used, or null when the data is missing.
export function questionAnswer(q, deps) {
  if (!q || !deps) return null;
  if (q.topic === "send") {
    const s = (deps.corridors.senders || []).find((x) => x.id === q.sender);
    const r = (deps.corridors.receivers || []).find((x) => x.id === q.country);
    if (!s || !r) return null;
    const amount = (deps.config.defaultAmounts || {})[s.currency];
    if (!(amount > 0)) return null;
    const ctx = contextFor(s, r, amount, deps);
    const top = ctx.rows.find((x) => !x.stale);
    if (!top) return null;
    const checkedAt = deps.quotes.updatedAt || new Date(deps.now).toISOString();
    const direct = `The service that delivers the most from ${s.short} to ${r.name} today is ${top.p.name}: ${money(amount, s.currency)} arrives as ${money(top.gets, r.currency)} after fees and the exchange-rate margin, with rates checked ${dateLong(checkedAt)}.`;
    return {
      type: "send",
      direct,
      figures: { provider: top.p.name, amount, gets: +top.gets.toFixed(2), currency: r.currency, sendCurrency: s.currency, checkedAt },
      s, r, ctx
    };
  }
  if (q.topic === "build") {
    const c = (deps.buildCosts.countries || {})[q.country];
    if (!c) return null;
    const house = (deps.buildCosts.houses || []).find((h) => h.id === "3") || (deps.buildCosts.houses || [])[2];
    if (!house) return null;
    const est = BC.estimate(deps.buildCosts, q.country, house.m2, 1, (deps.midmarket && deps.midmarket.rates) || {}, {}, { finish: "standard" });
    if (!est || !(est.total > 0)) return null;
    const checkedAt = deps.buildCosts.updated;
    const slug = String(q.slug || ""), question = String(q.question || "");
    if (/cement/i.test(slug) || /cement/i.test(question)) {
      const line = (est.lines || []).find((l) => /cement/i.test(l.label));
      if (!line || !(line.qty > 0)) return null;
      const direct = `A 3-bedroom house of about ${house.m2} m² in ${c.name} needs about ${Math.round(line.qty)} bags of 50 kg cement, costing about ${money(line.cost, est.currency)} at the prices checked ${dateLong(checkedAt)}.`;
      return {
        type: "build-cement",
        direct,
        figures: { qty: Math.round(line.qty), cost: +line.cost.toFixed(2), total: +est.total.toFixed(2), currency: est.currency, checkedAt },
        country: c, est
      };
    }
    if (/quote/i.test(slug) || /quote/i.test(question)) {
      const direct = `A fair builder's quote should be close to our standard receipt for a 3-bedroom house in ${c.name}: about ${money(est.total, est.currency)} for materials and trade days at prices checked ${dateLong(checkedAt)}. A quote far above that usually includes land, the contractor's fee, or work the receipt leaves out.`;
      return { type: "build-quote", direct, figures: { total: +est.total.toFixed(2), currency: est.currency, checkedAt }, country: c, est };
    }
    const direct = `A 3-bedroom house of about ${house.m2} m² in ${c.name} comes to about ${money(est.total, est.currency)} in the standard finish, at prices checked ${dateLong(checkedAt)}. That is materials and trade days; land and the contractor's fee are not included.`;
    return { type: "build", direct, figures: { total: +est.total.toFixed(2), currency: est.currency, checkedAt }, country: c, est };
  }
  return null;
}

// Live questions that are closest to the current page: same country, then same sender, then topic.
export function relatedQuestions(all, q, limit = 4) {
  const live = (all || []).filter((x) => x.status === "live" && x.slug !== q.slug);
  const score = (x) => (x.country === q.country ? 2 : 0) + (x.sender && x.sender === q.sender ? 2 : 0) + (x.topic === q.topic ? 1 : 0);
  return live
    .map((x) => ({ x, s: score(x) }))
    .sort((a, b) => b.s - a.s || String(a.x.slug).localeCompare(String(b.x.slug)))
    .slice(0, limit)
    .map((v) => v.x);
}

const HOW = {
  send: "We record the rate and fee each service quotes on the route, apply the amount you send, and rank by the amount that actually arrives. Quotes are checked through the day; stale quotes are excluded, and no service pays for a better position.",
  build: "The receipt uses the quantities and published prices in data/build-costs.json: cement, steel, blocks, roof, finishes, trade days and the published permit fee. It leaves out land, the contractor's fee and a contingency. The total is for a 3-bedroom house of about 110 m².",
  "build-cement": "The cement line in the standard receipt is the quantity for a 3-bedroom house of about 110 m²: concrete, block mortar, plaster and floor screed. It is a planning figure, not a shop order.",
  "build-quote": "We compare the quote with the itemised standard receipt for a 3-bedroom house in the country. The receipt covers materials and trade days; land, the contractor's fee and a contingency sit outside it."
};

export function questionPage(q, deps) {
  if (!q || q.status !== "live") return null;
  const ans = questionAnswer(q, deps);
  if (!ans) return null;
  const prefix = "../../";
  const rel = `questions/${q.slug}/`;
  const trail = [["SendFair", ""], ["Questions", "questions/"], [q.question, rel]];
  const related = relatedQuestions(deps.questions || [], q, 4);
  const ctas = ans.type === "send"
    ? [
        { target: "route", label: `Compare every service from ${ans.s.label} to ${ans.r.name}`, href: link(prefix, `send-money/${ans.s.id}-to-${ans.r.id}/`) },
        { target: "rates", label: `${ans.s.currency} to ${ans.r.currency} rate and history`, href: link(prefix, `rates/${ans.s.currency.toLowerCase()}-to-${ans.r.currency.toLowerCase()}/`) },
        { target: "calculator", label: `Cost to build in ${ans.r.name}`, href: link(prefix, `cost-to-build/${ans.r.id}/`) }
      ]
    : [
        { target: "calculator", label: `Open the ${ans.country.name} house calculator`, href: link(prefix, `cost-to-build/${q.country}/`) },
        { target: "quote-check", label: "Check a builder's quote", href: link(prefix, "quote-check/") }
      ];
  const ctaHtml = ctas.map((c, i) => `<a class="btn${i ? " btn-ghost" : ""}" href="${c.href}" data-qcta="${c.target}">${esc(c.label)}</a>`).join(" ");
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>${esc(q.question)}</h1>
<p class="lede">${esc(ans.direct)}</p>
<h2>How we worked this out</h2>
<p>${esc(HOW[ans.type] || HOW.send)}</p>
<p class="q-cta">${ctaHtml}</p>
${related.length ? `<h2>People also ask</h2><ul class="route-links">${related.map((x) => `<li><a href="${link(prefix, `questions/${x.slug}/`)}">${esc(x.question)}</a></li>`).join("")}</ul>` : ""}
</div></div></section>
<script>window.addEventListener("load",function(){if(window.SF&&SF.track)SF.track("question_view",{slug:${JSON.stringify(q.slug)}});});</script>
<script>(function(){var s=${JSON.stringify(q.slug)};document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("[data-qcta]");if(!a)return;if(window.SF&&SF.track)SF.track("question_cta_click",{slug:s,target:a.getAttribute("data-qcta")});});})();</script>`;
  return {
    canonical: rel, prefix, title: `${q.question} | ${deps.config.siteName}`, description: ans.direct,
    jsonld: [faqLd([[q.question, ans.direct]]), crumbs(trail, deps.site)], body,
    figures: ans.figures, type: ans.type, related: related.map((x) => x.slug)
  };
}

export function questionsIndex(all, deps) {
  const live = (all || []).filter((q) => q.status === "live");
  const prefix = "../";
  const trail = [["SendFair", ""], ["Questions", "questions/"]];
  const groups = [["send", "Sending money"], ["build", "Building a home"]]
    .map(([topic, title]) => ({ title, items: live.filter((q) => q.topic === topic) }))
    .filter((g) => g.items.length);
  const body = `<section class="block page"><div class="wrap"><div class="prose wide">
${crumbNav(prefix, trail)}
<h1>Questions people ask about sending money and building back home</h1>
${live.length
  ? `<p class="lede">Short, data-backed answers to the questions we see most in diaspora groups. Each answer uses the rates and prices we checked on the day.</p>${groups.map((g) => `<h2>${esc(g.title)}</h2><ul class="route-links">${g.items.map((q) => `<li><a href="${link(prefix, `questions/${q.slug}/`)}">${esc(q.question)}</a></li>`).join("")}</ul>`).join("")}`
  : `<p class="lede">We are checking the first answers. Draft questions are in the queue; each one goes live only when we can verify its figures.</p>`}
</div></div></section>`;
  return {
    canonical: "questions/", prefix, title: `Questions about sending money and building back home | ${deps.config.siteName}`,
    description: "Short answers to the questions diaspora families ask about sending money home and building back home, with the figures we checked.",
    jsonld: [crumbs(trail, deps.site)], body, noindex: live.length === 0, liveCount: live.length
  };
}
