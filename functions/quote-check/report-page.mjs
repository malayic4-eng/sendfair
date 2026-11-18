/* The private report page. Before payment it shows only the free preview counts;
   line-level detail is never put in the HTML until the order is paid. */

import { esc, shell } from "./html.js";
import { money, pct, dateLong, priceFor } from "../../src/quote-check/config.mjs";

const flagClass = {
  below: "qc-flag-below",
  within: "qc-flag-within",
  above: "qc-flag-above",
  well_above: "qc-flag-well",
  not_checked: "qc-flag-none"
};

function amount(value, currency, digits) {
  return money(value, currency, digits == null ? (Math.abs(Number(value)) >= 1000 ? 0 : 2) : digits);
}

function metaLine(order) {
  return `${esc(order.countryName)}${order.town ? " · " + esc(order.town) : ""} · ${esc(order.houseType)} · ${esc(order.m2)} m² · ${esc(order.bedrooms)} bedrooms`;
}

function summaryCards(report) {
  const s = report.summary;
  const band = s.band || { key: "not_checked", label: "Not enough checked" };
  return `<div class="qc-cards">
<div class="qc-card"><span class="qc-card-k">Quote total detected</span><strong class="qc-card-v">${amount(report.quote.total, report.quote.currency)}</strong>${report.fx.rate && report.fx.from !== report.fx.to ? `<span class="qc-card-s">${amount(report.quote.totalLocal, report.country.currency)} at the mid-market rate</span>` : ""}</div>
<div class="qc-card"><span class="qc-card-k">SendFair estimate for matched items</span><strong class="qc-card-v">${amount(s.estimateMatched, report.country.currency)}</strong><span class="qc-card-s">${s.checkedLines} of ${s.totalLines} lines matched</span></div>
<div class="qc-card"><span class="qc-card-k">Difference on matched items</span><strong class="qc-card-v ${s.difference > 0 ? "qc-up" : "qc-down"}">${s.difference == null ? "Not available" : amount(s.difference, report.country.currency)}</strong><span class="qc-card-s">${s.differencePct == null ? "" : pct(s.differencePct)} · matched value ${amount(s.matchedQuoteValue, report.country.currency)}</span></div>
<div class="qc-card qc-verdict ${flagClass[band.key] || ""}"><span class="qc-card-k">Verdict</span><strong class="qc-card-v">${esc(band.label)}</strong><span class="qc-card-s">${esc(band.note || "")}</span></div>
</div>`;
}

function arithmeticBanner(report) {
  const issues = report.arithmetic || {};
  if (!issues.hasErrors) return "";
  const rows = [];
  for (const e of issues.lineErrors || []) if (e.kind === "arithmetic") rows.push(esc(e.message));
  if (issues.totalError) rows.push(esc(issues.totalError.message));
  if (!rows.length) return "";
  return `<div class="qc-alert"><strong>The quote's own arithmetic does not add up.</strong><ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul><p>We used the recalculated line totals for the comparison, and this is one of the questions to ask your builder.</p></div>`;
}

function lineTable(report) {
  const rows = report.lines.map((line) => {
    const m = line.match || {};
    const desc = `<strong>${esc(line.description)}</strong>${line.arithmetic && !line.arithmetic.ok ? '<span class="qc-tag qc-tag-warn">arithmetic</span>' : ""}${m.checked && m.conversion && m.conversion.note ? `<span class="qc-line-note">${esc(m.conversion.note)}</span>` : ""}`;
    let match = "Not checked";
    if (m.checked) match = esc(m.label || "") + (m.isGuide ? '<span class="qc-tag qc-tag-warn">guide</span>' : "") + (m.optionName ? `<span class="qc-line-note">${esc(m.optionName)}</span>` : "");
    else if (m.status === "unit_mismatch") match = 'Not checked <span class="qc-line-note">unit could not be converted</span>';
    else if (m.status === "unavailable") match = 'Not checked <span class="qc-line-note">no local price</span>';
    else if (m.status === "excluded") match = 'Not checked <span class="qc-line-note">outside our price data</span>';
    const our = m.checked && line.ourPrice != null
      ? `${amount(line.ourPrice, report.country.currency)}<span class="qc-src">checked ${esc(report.checkedDateLabel)}</span>`
      : "—";
    const diff = m.checked && line.diffPct != null ? `<span class="${flagClass[line.flag.key] || ""}">${pct(line.diffPct)}</span>` : "—";
    const flag = m.checked ? `<span class="qc-flag ${flagClass[line.flag.key] || ""}">${esc(line.flag.label)}</span>` : `<span class="qc-flag qc-flag-none">Not checked</span>`;
    return `<tr>
<td>${desc}</td>
<td>${match}${!m.checked && m.reason ? `<span class="qc-line-note">${esc(m.reason)}</span>` : ""}</td>
<td class="num">${line.quantity == null ? "—" : esc(Math.round(line.quantity * 100) / 100)}</td>
<td>${esc(line.unit || "—")}</td>
<td class="num">${line.unitPrice == null ? "—" : amount(line.unitPrice, line.currency)}</td>
<td class="num">${our}</td>
<td class="num">${diff}</td>
<td>${flag}</td>
</tr>`;
  }).join("");
  return `<div class="table-wrap qc-table-wrap"><table class="rates-table qc-table">
<caption>Our unit prices checked ${esc(report.checkedDateLabel)}. The difference is against the matched quantity, not the whole quote.</caption>
<thead><tr><th>Item as written</th><th>Our match</th><th class="num">Qty</th><th>Unit</th><th class="num">Quoted unit</th><th class="num">Our typical unit</th><th class="num">Difference</th><th>Flag</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

function notCheckedTable(report) {
  const rows = report.unmatched.map((line) => `<tr><td><strong>${esc(line.description)}</strong></td><td class="num">${line.quantity == null ? "—" : esc(line.quantity)}</td><td>${esc(line.unit || "—")}</td><td class="num">${line.unitPrice == null ? "—" : amount(line.unitPrice, line.currency)}</td><td>${esc((line.match && line.match.reason) || "Not checked.")}</td></tr>`).join("");
  return `<h2>Not checked</h2>
<p class="qc-lede">These lines are not in the comparison. They may be fair; we either have no local price for them, or the unit could not be converted safely. Ask your builder to itemise them.</p>
<div class="table-wrap"><table class="rates-table qc-table qc-notchecked"><thead><tr><th>Item as written</th><th class="num">Qty</th><th>Unit</th><th class="num">Quoted unit</th><th>Why it is not checked</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function questionsBlock(report) {
  return `<h2>Questions to ask your builder</h2>
<p class="qc-lede">Generated from the flagged lines. These are questions, not accusations. A different scope, a different material or a different mix can explain any of them.</p>
<ol class="qc-questions">${report.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ol>`;
}

function quantityBlock(report) {
  if (!report.quantityChecks.length) return "";
  return `<h2>Quantity checks: ask your builder</h2>
<p class="qc-lede">The same planning take-off as the house calculator, compared with what the quote lists. A difference can be legitimate scope; ask.</p>
<ul class="qc-qty">${report.quantityChecks.map((q) => `<li>${esc(q.message)}</li>`).join("")}</ul>`;
}

function disclaimerBlock(report) {
  return `<div class="qc-disclaimer"><h2>What this report is, and what it is not</h2>
<p>${esc(report.disclaimer)}</p>
<ul>
<li>The plot of land, stamp duty, survey and title work are not included.</li>
<li>The contractor's fee, profit, overhead, financing and site preliminaries are not included.</li>
<li>Architect's, engineer's and quantity surveyor's fees, and design changes, are not included.</li>
<li>Structural design, soil conditions, retaining walls, water and power connections are not assessed.</li>
<li>Anything not in our price data, including imported or specialist finishes, is not checked.</li>
</ul>
<p>Prices vary by site, supplier and season. Confirm every price with your own supplier before you pay.</p></div>`;
}

function fullReport(report, order) {
  return `<div class="qc-data" hidden data-order="${esc(order.id)}" data-token="${esc(order.token)}" data-paid="1" data-amount="${esc(order.payment && order.payment.amount)}" data-currency="${esc(order.payment && order.payment.currency)}"></div>
<section class="wrap qc-report">
<p class="qc-kicker">Quote Check · ${esc(order.countryName)}</p>
<h1>Your quote, checked</h1>
<p class="qc-meta">${metaLine(order)} · Prepared ${esc(dateLong(report.generatedAt))} · Report reference ${esc(order.id)}</p>
${summaryCards(report)}
<p class="qc-coverage">${esc(report.summary.coverageNote)}</p>
${report.summary.guideLines ? `<p class="qc-small">${report.summary.guideLines} matched line${report.summary.guideLines === 1 ? "" : "s"} use a local guide price, marked <span class="qc-tag qc-tag-warn">guide</span>. A guide is our published planning figure, not a shop receipt.</p>` : ""}
${report.summary.unmatchedValue > 0 ? `<p class="qc-small">${amount(report.summary.unmatchedValue, report.country.currency)} of the quote is outside the matched comparison (unmatched lines and any arithmetic difference). Those lines are listed separately below.</p>` : ""}
${report.fx.note ? `<p class="qc-small">${esc(report.fx.note)}</p>` : ""}
${arithmeticBanner(report)}
<div class="qc-actions"><a class="qc-btn" href="/quote-check/report/${esc(order.token)}/pdf">Download the PDF</a><a class="qc-btn qc-btn-ghost" href="/quote-check/">Check another quote</a></div>
<h2>Line by line</h2>
${lineTable(report)}
${notCheckedTable(report)}
${quantityBlock(report)}
${questionsBlock(report)}
${disclaimerBlock(report)}
<p class="qc-small qc-private">This report has a private link. Anyone with the link can open it, so please do not post it in a public group. Uploaded files and the extracted data are deleted ${esc(order.retentionDays || 30)} days after the report is generated.</p>
</section>`;
}

function previewPage(order, settings, testMode, charge, provider) {
  const p = order.preview || {};
  const configured = priceFor(settings.config, order.quoteCurrency);
  const price = charge && charge.amount > 0 ? charge : configured;
  const paymentReady = testMode || (provider && provider !== "test");
  const providerName = testMode ? "the test provider" : provider === "paystack" ? "Paystack" : provider === "flutterwave" ? "Flutterwave" : "our payment provider";
  return `<section class="wrap qc-report">
${testMode ? '<div class="qc-alert qc-test"><strong>Test mode.</strong> No real payment is taken. This is a review build of Quote Check.</div>' : ""}
<p class="qc-kicker">Quote Check · ${esc(order.countryName)}</p>
<h1>Your free preview</h1>
<p class="qc-meta">${metaLine(order)} · Uploaded ${esc(dateLong(order.createdAt))}</p>
<p class="qc-lede">We read the quote and matched it to our published local prices. The line-by-line verdict is unlocked after payment.</p>
<div class="qc-cards">
<div class="qc-card"><span class="qc-card-k">Line items found</span><strong class="qc-card-v">${esc(p.lineItems || 0)}</strong></div>
<div class="qc-card"><span class="qc-card-k">Quote total detected</span><strong class="qc-card-v">${amount(p.quoteTotal, p.quoteCurrency)}</strong></div>
<div class="qc-card"><span class="qc-card-k">Lines matched to our prices</span><strong class="qc-card-v">${esc(p.matchedLines || 0)} of ${esc(p.totalLines || 0)}</strong><span class="qc-card-s">${Math.round((p.coverage && p.coverage.value || 0) * 100)}% of the quote value</span></div>
<div class="qc-card"><span class="qc-card-k">Arithmetic issues in the quote</span><strong class="qc-card-v">${esc(p.arithmeticIssues || 0)}</strong></div>
</div>
${p.arithmeticIssues ? `<p class="qc-small">We found ${esc(p.arithmeticIssues)} arithmetic issue${p.arithmeticIssues === 1 ? "" : "s"} in the quote itself. The paid report lists each one.</p>` : ""}
<div class="qc-pay">
<h2>Unlock the full report</h2>
<p>One-off fee: <strong>${amount(price.amount, price.currency)}</strong>. The full report includes the line-by-line table, our typical unit price with the date we checked it, the difference and flag for every matched line, the unmatched lines, quantity checks, questions to ask your builder, and a PDF by email.</p>
${price.currency !== configured.currency ? `<p class="qc-small">Your quote is in ${esc(configured.currency)}, but our card provider charges this order in ${esc(price.currency)}. The amount above is what will be charged.</p>` : ""}
<button type="button" class="qc-btn qc-pay-btn" id="qc-pay" data-order="${esc(order.id)}" data-token="${esc(order.token)}" data-amount="${esc(price.amount)}" data-currency="${esc(price.currency)}"${paymentReady ? "" : " disabled"}>${paymentReady ? `Pay ${amount(price.amount, price.currency)} and unlock the report` : "Card payment is being set up"}</button>
<p class="qc-small" id="qc-pay-msg" role="status">${paymentReady ? "" : "Online payment is not configured yet. Email hello@sendfair.africa and we will arrange it."}</p>
<p class="qc-small">Payment is handled by ${esc(providerName)}. We do not see or store your card details. If we cannot produce the report, we refund the fee.</p>
</div>
<h2>What the full report includes</h2>
<ul class="qc-includes">
<li>The quote total and our estimate for the matched items, in money and percent.</li>
<li>A verdict: below typical, within typical range, above typical, or well above typical.</li>
<li>Every matched line: quantity, unit, quoted unit price, our typical unit price with the date checked, difference and flag.</li>
<li>Every unmatched line, listed separately as not checked, with the reason.</li>
<li>Quantity sanity checks for cement, blocks, roofing and other items, where we can.</li>
<li>Questions to ask your builder, generated from the flagged lines.</li>
<li>A clear statement of what the report does not cover.</li>
</ul>
<p class="qc-small qc-private">Uploaded files and extracted data are deleted ${esc(order.retentionDays || 30)} days after the report is generated. This preview uses a private link; do not post it publicly.</p>
</section>`;
}

function waitingPage(order, testMode) {
  return `<section class="wrap qc-report">
${testMode ? '<div class="qc-alert qc-test"><strong>Test mode.</strong> No real payment is taken.</div>' : ""}
<p class="qc-kicker">Quote Check · ${esc(order.countryName)}</p>
<h1>Confirming your payment</h1>
<p class="qc-lede">We are waiting for the payment provider to confirm the payment. This page checks again automatically. It usually takes a few seconds.</p>
<div class="qc-wait" data-order="${esc(order.id)}" data-token="${esc(order.token)}"><span class="qc-spinner" aria-hidden="true"></span> <span id="qc-wait-msg">Checking…</span></div>
<p><a href="/quote-check/report/${esc(order.token)}/">Refresh this page</a> · <a href="/contact/">Contact us</a></p>
</section>`;
}

function refundedPage(order) {
  return `<section class="wrap qc-report">
<p class="qc-kicker">Quote Check · ${esc(order.countryName)}</p>
<h1>This order was refunded</h1>
<p class="qc-lede">The report is no longer available. If you think this is a mistake, email <span class="email">hello@sendfair.africa</span> with the reference ${esc(order.id)}.</p>
</section>`;
}

function purgedPage() {
  return `<section class="wrap qc-report">
<p class="qc-kicker">Quote Check</p>
<h1>This report has been deleted</h1>
<p class="qc-lede">We delete uploaded files, extracted data and reports after the retention period. If you need a new check, upload the quote again.</p>
<p><a class="qc-btn" href="/quote-check/">Start a new Quote Check</a></p>
</section>`;
}

function notFoundPage() {
  return `<section class="wrap qc-report">
<p class="qc-kicker">Quote Check</p>
<h1>Report not found</h1>
<p class="qc-lede">This private link is incomplete, has expired, or the report has been deleted. Check the link in your email, or start a new check.</p>
<p><a class="qc-btn" href="/quote-check/">Start a Quote Check</a></p>
</section>`;
}

export function renderReportPage({ order, settings, testMode, ga4 = "", assets = {}, charge = null, provider = "", waiting = false }) {
  if (!order) {
    return shell({
      title: "Report not found · SendFair Quote Check",
      description: "This private Quote Check link was not found.",
      body: notFoundPage(),
      ga4,
      assets
    });
  }
  if (order.purged) {
    return shell({
      title: "Report deleted · SendFair Quote Check",
      description: "This Quote Check report has been deleted after the retention period.",
      body: purgedPage(),
      ga4,
      assets
    });
  }
  if (order.status === "refunded") {
    return shell({
      title: "Order refunded · SendFair Quote Check",
      description: "This Quote Check order was refunded.",
      body: refundedPage(order),
      ga4,
      assets
    });
  }
  const paid = order.status === "paid" || order.status === "report sent";
  if (paid && !order.analysis) {
    return shell({
      title: "Preparing your report · SendFair Quote Check",
      description: "Your Quote Check report is being prepared.",
      body: waitingPage(order, testMode),
      ga4,
      assets,
      scripts: `<script src="/assets/quote-check-report.js" defer></script>`
    });
  }
  if (!paid && waiting) {
    return shell({
      title: "Confirming payment · SendFair Quote Check",
      description: "We are confirming your Quote Check payment.",
      body: waitingPage(order, testMode),
      ga4,
      assets,
      scripts: `<script src="/assets/quote-check-report.js" defer></script>`
    });
  }
  if (!paid) {
    return shell({
      title: "Your free Quote Check preview · SendFair",
      description: "Your free preview of the Quote Check: line items found, quote total and matched lines.",
      body: previewPage(order, settings, testMode, charge, provider),
      ga4,
      assets,
      scripts: `<script src="/assets/quote-check-report.js" defer></script>`
    });
  }
  return shell({
    title: `Quote Check report · ${order.countryName} · SendFair`,
    description: "Your private SendFair Quote Check report: line-by-line comparison, verdict, quantity checks and questions for your builder.",
    body: fullReport(order.analysis, order),
    ga4,
    assets,
    scripts: `<script src="/assets/quote-check-report.js" defer></script>`
  });
}
