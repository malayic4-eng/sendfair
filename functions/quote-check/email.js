/* Transactional email for Quote Check, through the existing Cloudflare Email binding.
   The customer gets the private report link and the PDF; the owner gets one email per paid order. */

import { toBase64 } from "./bytes.js";
import { money, pct } from "../../src/quote-check/config.mjs";

const FROM_NAME = "SendFair Quote Check";

function e(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fromAddress(settings) {
  return { email: settings.fromEmail || "hello@sendfair.africa", name: FROM_NAME };
}

export async function sendMail(env, settings, message) {
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") return { ok: false, error: "email_not_configured" };
  try {
    await env.EMAIL.send({ from: fromAddress(settings), ...message });
    return { ok: true };
  } catch (err) {
    console.log("quote-check email failed", err && (err.code || err.message));
    return { ok: false, error: (err && (err.code || err.message)) || "email_failed" };
  }
}

function reportHtml(order, report, origin) {
  const url = `${origin}/quote-check/report/${order.token}/`;
  const s = report.summary;
  const colour = { below: "#2a36a8", within: "#0a7651", above: "#9a4b00", well_above: "#a3161c", not_checked: "#5c6287" }[s.band.key] || "#151b45";
  return `<div style="font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#151b45;max-width:620px;margin:0 auto">
<p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5c6287;margin:0 0 6px">SendFair Quote Check</p>
<h1 style="font-size:26px;line-height:1.15;margin:0 0 8px">Your quote, checked</h1>
<p style="margin:0 0 18px">${e(order.countryName)}${order.town ? ", " + e(order.town) : ""} · ${e(order.houseType)} · ${e(order.m2)} m²</p>
<table role="presentation" style="border-collapse:collapse;width:100%;margin:0 0 18px">
<tr><td style="padding:8px 0;color:#5c6287">Quote total</td><td style="padding:8px 0;text-align:right;font-weight:700">${money(report.quote.total, report.quote.currency)}</td></tr>
<tr><td style="padding:8px 0;color:#5c6287">Our estimate for matched items</td><td style="padding:8px 0;text-align:right;font-weight:700">${money(s.estimateMatched, report.country.currency)}</td></tr>
<tr><td style="padding:8px 0;color:#5c6287">Difference on matched items</td><td style="padding:8px 0;text-align:right;font-weight:700">${s.difference == null ? "Not available" : money(s.difference, report.country.currency) + " (" + pct(s.differencePct) + ")"}</td></tr>
<tr><td style="padding:8px 0;color:#5c6287">Verdict</td><td style="padding:8px 0;text-align:right;font-weight:800;color:${colour}">${s.band.label}</td></tr>
</table>
<p style="margin:0 0 8px">${e(s.coverageNote)}</p>
<p style="margin:18px 0"><a href="${url}" style="background:#1b2470;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;display:inline-block;font-weight:700">Open the full report</a></p>
<p style="color:#5c6287;font-size:13px;margin:0 0 8px">The PDF is attached. The link is private: anyone with it can open the report, so please do not post it in a public group.</p>
<p style="color:#5c6287;font-size:13px;margin:0">${e(report.disclaimer)}</p>
</div>`;
}

function reportText(order, report, origin) {
  const url = `${origin}/quote-check/report/${order.token}/`;
  const s = report.summary;
  return [
    "SendFair Quote Check",
    "",
    `${order.countryName}${order.town ? ", " + order.town : ""} · ${order.houseType} · ${order.m2} m²`,
    "",
    `Quote total: ${money(report.quote.total, report.quote.currency)}`,
    `SendFair estimate for matched items: ${money(s.estimateMatched, report.country.currency)}`,
    `Difference on matched items: ${s.difference == null ? "Not available" : money(s.difference, report.country.currency) + " (" + pct(s.differencePct) + ")"}`,
    `Verdict: ${s.band.label}`,
    "",
    s.coverageNote,
    "",
    `Open the full report: ${url}`,
    "",
    "The PDF is attached. The link is private; please do not post it in a public group.",
    "",
    report.disclaimer,
    "",
    "SendFair · sendfair.africa"
  ].join("\n");
}

export async function sendReportEmail(env, settings, order, report, pdfBytes, origin) {
  const attachment = pdfBytes
    ? [{
        filename: `sendfair-quote-check-${order.countryId}-${order.id}.pdf`,
        type: "application/pdf",
        disposition: "attachment",
        content: toBase64(pdfBytes)
      }]
    : [];
  return sendMail(env, settings, {
    to: order.email,
    subject: `Your SendFair Quote Check report: ${order.countryName}`,
    text: reportText(order, report, origin),
    html: reportHtml(order, report, origin),
    attachments: attachment
  });
}

export async function sendOwnerEmail(env, settings, order, report, origin) {
  const to = env.QUOTE_CHECK_OWNER_EMAIL || settings.ownerEmail;
  if (!to) return { ok: false, error: "no_owner_email" };
  const admin = `${origin}/admin/quote-checks/`;
  const s = report.summary;
  return sendMail(env, settings, {
    to,
    subject: `Paid Quote Check: ${order.countryName} · ${money(order.payment.amount, order.payment.currency)}`,
    text: [
      `A Quote Check order was paid.`,
      ``,
      `Order: ${order.id}`,
      `Country: ${order.countryName}${order.town ? ", " + order.town : ""}`,
      `Customer: ${order.email}`,
      `House: ${order.houseType}, ${order.m2} m2, ${order.bedrooms} bedrooms`,
      `Quote: ${money(report.quote.total, report.quote.currency)}`,
      `Verdict: ${s.band.label} (${s.difference == null ? "no comparison" : pct(s.differencePct)})`,
      `Matched: ${s.checkedLines} of ${s.totalLines} lines`,
      `Paid: ${money(order.payment.amount, order.payment.currency)} via ${order.payment.provider}`,
      `Payment reference: ${order.payment.reference || "n/a"}`,
      ``,
      `Open the admin list: ${admin}`,
      `Private report: ${origin}/quote-check/report/${order.token}/`
    ].join("\n"),
    html: `<p>A Quote Check order was paid.</p>
<ul>
<li><strong>Order:</strong> ${order.id}</li>
<li><strong>Country:</strong> ${e(order.countryName)}${order.town ? ", " + e(order.town) : ""}</li>
<li><strong>Customer:</strong> ${e(order.email)}</li>
<li><strong>House:</strong> ${e(order.houseType)}, ${e(order.m2)} m², ${e(order.bedrooms)} bedrooms</li>
<li><strong>Quote:</strong> ${money(report.quote.total, report.quote.currency)}</li>
<li><strong>Verdict:</strong> ${s.band.label} (${s.difference == null ? "no comparison" : pct(s.differencePct)})</li>
<li><strong>Matched:</strong> ${s.checkedLines} of ${s.totalLines} lines</li>
<li><strong>Paid:</strong> ${money(order.payment.amount, order.payment.currency)} via ${order.payment.provider}</li>
<li><strong>Payment reference:</strong> ${order.payment.reference || "n/a"}</li>
</ul>
<p><a href="${admin}">Open the admin list</a> · <a href="${origin}/quote-check/report/${order.token}/">Private report</a></p>`
  });
}
