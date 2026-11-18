/* Layout the Quote Check report as a printable A4 PDF. */

import { PdfDoc } from "./pdf.mjs";
import { money, pct, dateLong } from "../../src/quote-check/config.mjs";

const C = {
  ink: [0.08, 0.09, 0.2],
  muted: [0.36, 0.39, 0.53],
  indigo: [0.11, 0.14, 0.44],
  white: [1, 1, 1],
  line: [0.84, 0.86, 0.92],
  paper: [0.958, 0.966, 0.988],
  leaf: [0.04, 0.46, 0.32],
  warn: [0.6, 0.29, 0],
  red: [0.65, 0.1, 0.12],
  blue: [0.13, 0.2, 0.6]
};

const BAND_COLOR = {
  below: C.blue,
  within: C.leaf,
  above: C.warn,
  well_above: C.red,
  not_checked: C.muted
};

const M = 40;
const W = 515;
const BOTTOM = 790;

function box(doc, x, top, w, h, opts = {}) {
  doc.rect(x, top, w, h, { fill: opts.fill || C.paper, stroke: opts.stroke || C.line, width: 0.6 });
  if (opts.accent) doc.rect(x, top, 4, h, { fill: opts.accent });
}

export function buildReportPdf(report, meta = {}) {
  const doc = new PdfDoc({ margin: M });
  let y = M;

  const ensure = (h) => {
    if (y + h <= BOTTOM) return;
    doc.newPage();
    y = M;
    doc.text(M, y, "SendFair Quote Check", { size: 9, bold: true, color: C.indigo });
    doc.text(M + 330, y, `${report.country.name}${report.inputs.town ? " · " + report.inputs.town : ""}`, { size: 9, color: C.muted });
    doc.line(M, y + 14, M + W, y + 14, { color: C.line });
    y += 26;
  };

  const para = (text, opts = {}) => {
    const size = opts.size || 9.5;
    const lines = doc.wrap(text, opts.width || W, size, !!opts.bold);
    ensure(lines.length * size * 1.38 + (opts.gap || 4));
    for (const line of lines) {
      doc.text(opts.x || M, y, line, { size, bold: !!opts.bold, color: opts.color || C.ink });
      y += size * 1.38;
    }
    y += opts.gap == null ? 4 : opts.gap;
  };

  const heading = (text, gap = 10) => {
    // Keep the heading with at least a few lines of the section that follows.
    ensure(58);
    y += gap;
    doc.text(M, y, text, { size: 13, bold: true, color: C.indigo });
    y += 20;
  };

  // Title
  doc.text(M, y, "SENDFAIR QUOTE CHECK", { size: 9.5, bold: true, color: C.indigo });
  y += 18;
  doc.text(M, y, `Is this ${report.country.name} quote fair?`, { size: 21, bold: true, color: C.ink });
  y += 30;
  const metaLines = [
    `Prepared ${dateLong(report.generatedAt)}`,
    `${report.inputs.town ? report.inputs.town + ", " : ""}${report.country.name} · ${report.inputs.bedrooms || "?"} bedrooms · ${report.inputs.houseType} · ${report.inputs.m2 || "?"} m2`,
    `Quote currency ${report.quote.currency}${report.fx.note ? ` · changed into ${report.country.currency} for comparison` : ""}`,
    meta.email ? `Prepared for ${meta.email}` : "",
    meta.orderId ? `Report reference ${meta.orderId}` : ""
  ].filter(Boolean);
  for (const line of metaLines) {
    doc.text(M, y, line, { size: 8.5, color: C.muted });
    y += 13;
  }
  y += 8;

  // Summary boxes
  const s = report.summary;
  const verdict = s.band || { key: "not_checked", label: "Not enough checked" };
  const verdictColor = BAND_COLOR[verdict.key] || C.muted;
  const boxW = (W - 12) / 2;
  const boxH = 62;
  const boxes = [
    { label: "QUOTE TOTAL DETECTED", value: money(report.quote.total, report.quote.currency), accent: C.indigo },
    { label: "SENDFAIR ESTIMATE FOR MATCHED ITEMS", value: money(s.estimateMatched, report.country.currency), accent: C.indigo },
    {
      label: s.difference == null ? "DIFFERENCE ON MATCHED ITEMS" : `DIFFERENCE ON MATCHED ITEMS (${pct(s.differencePct)})`,
      value: s.difference == null ? "Not available" : money(s.difference, report.country.currency),
      accent: s.difference > 0 ? C.warn : C.leaf
    },
    { label: "VERDICT", value: verdict.label, accent: verdictColor }
  ];
  for (let i = 0; i < boxes.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = M + col * (boxW + 12);
    const top = y + row * (boxH + 10);
    box(doc, x, top, boxW, boxH, { accent: boxes[i].accent });
    doc.text(x + 14, top + 10, boxes[i].label, { size: 6.8, bold: true, color: C.muted });
    const valueSize = boxes[i].value.length > 24 ? 12 : 15;
    doc.text(x + 14, top + 25, boxes[i].value, { size: valueSize, bold: true, color: C.ink });
  }
  y += 2 * boxH + 10 + 16;

  para(s.coverageNote, { size: 9.5, color: C.ink });
  if (s.guideLines) para(`${s.guideLines} matched line${s.guideLines === 1 ? "" : "s"} use a local guide price, marked (guide). A guide is our published planning figure, not a shop receipt.`, { size: 8.5, color: C.muted });
  if (s.unmatchedValue > 0) para(`${money(s.unmatchedValue, report.country.currency)} of the quote is outside the matched comparison (unmatched lines and any arithmetic difference). Those lines are listed separately below.`, { size: 8.5, color: C.muted });
  if (report.fx.note) para(report.fx.note, { size: 8.5, color: C.muted });
  para(`Our unit prices were checked ${report.checkedDateLabel}. A line is compared only when the unit matches or can be converted safely.`, { size: 8.5, color: C.muted });

  // Line table
  heading("Line by line", 4);
  const cols = [165, 105, 40, 32, 58, 58, 57];
  const headers = ["Item as written", "Our match", "Qty", "Unit", "Quoted unit", "Our unit", "Difference"];
  const rowFont = 7.4;
  const pad = 4;

  const tableHeader = () => {
    ensure(26);
    doc.rect(M, y, W, 20, { fill: C.indigo });
    let x = M;
    for (let i = 0; i < headers.length; i++) {
      doc.text(x + 3, y + 5, headers[i], { size: 7, bold: true, color: C.white });
      x += cols[i];
    }
    y += 20;
  };

  tableHeader();
  for (let i = 0; i < report.lines.length; i++) {
    const line = report.lines[i];
    const match = line.match || {};
    const descLines = doc.wrap(line.description, cols[0] - 6, rowFont, false).slice(0, 5);
    let matchText = match.checked ? (match.label || "") : "Not checked";
    if (match.checked && match.isGuide) matchText += " (guide)";
    if (match.checked && match.optionName) matchText += ` - ${match.optionName}`;
    if (!match.checked && match.status === "unit_mismatch") matchText = "Not checked (unit)";
    if (!match.checked && match.status === "unavailable") matchText = "No local price";
    const matchLines = doc.wrap(matchText, cols[1] - 6, rowFont, false).slice(0, 4);
    const extra = [];
    if (line.arithmetic && !line.arithmetic.ok) extra.push("Arithmetic does not add up: " + (line.arithmetic.message || ""));
    if (!match.checked && match.reason) extra.push(match.reason);
    if (match.checked && match.conversion && match.conversion.note) extra.push(match.conversion.note);
    const extraLines = extra.flatMap((e) => doc.wrap(e, W - 10, 6.6, false).slice(0, 2));
    const linesCount = Math.max(descLines.length, matchLines.length, 1);
    const rowH = Math.max(24, linesCount * 9 + 8 + extraLines.length * 8.2);

    if (y + rowH > BOTTOM) {
      doc.newPage();
      y = M;
      doc.text(M, y, "SendFair Quote Check", { size: 9, bold: true, color: C.indigo });
      doc.text(M + 330, y, `${report.country.name}${report.inputs.town ? " · " + report.inputs.town : ""}`, { size: 9, color: C.muted });
      doc.line(M, y + 14, M + W, y + 14, { color: C.line });
      y += 26;
      tableHeader();
    }

    if (i % 2 === 1) doc.rect(M, y, W, rowH, { fill: [0.975, 0.979, 0.992] });

    let x = M;
    for (let d = 0; d < descLines.length; d++) doc.text(x + 3, y + 4 + d * 9, descLines[d], { size: rowFont, color: C.ink });
    x += cols[0];
    for (let d = 0; d < matchLines.length; d++) {
      doc.text(x + 3, y + 4 + d * 9, matchLines[d], { size: rowFont, color: match.checked ? C.ink : C.muted });
    }
    x += cols[1];
    doc.text(x + 3, y + 4, line.quantity == null ? "-" : String(Math.round(line.quantity * 100) / 100), { size: rowFont, color: C.ink });
    x += cols[2];
    doc.text(x + 3, y + 4, line.unit || "-", { size: rowFont, color: C.ink });
    x += cols[3];
    doc.text(x + 3, y + 4, line.unitPrice == null ? "-" : money(line.unitPrice, line.currency), { size: rowFont, color: C.ink });
    x += cols[4];
    doc.text(x + 3, y + 4, line.checked && line.ourPrice != null ? money(line.ourPrice, report.country.currency) : "-", { size: rowFont, color: C.ink });
    x += cols[5];
    const diffText = line.checked && line.diffPct != null ? pct(line.diffPct) : "-";
    const flagColor = line.checked ? (BAND_COLOR[line.flag.key] || C.ink) : C.muted;
    doc.text(x + 3, y + 4, diffText, { size: rowFont, bold: true, color: flagColor });

    let extraTop = y + 6 + linesCount * 9;
    for (const e of extraLines) {
      doc.text(M + 5, extraTop, e, { size: 6.6, color: C.muted });
      extraTop += 8.2;
    }
    y += rowH;
    doc.line(M, y, M + W, y, { color: C.line, width: 0.4 });
  }

  // Not checked
  const notChecked = report.lines.filter((l) => !l.checked);
  if (notChecked.length) {
    heading("Not checked", 14);
    para("These lines are not in the comparison. They may be fair; we either have no local price for them, or the unit could not be converted safely. Ask your builder to itemise them.", { size: 8.5, color: C.muted });
    for (const line of notChecked) {
      para(`- ${line.description}: ${line.match && line.match.reason ? line.match.reason : "We could not check this line."}`, { size: 8.3, color: C.ink, gap: 2 });
    }
  }

  // Quantity checks
  if (report.quantityChecks.length) {
    heading("Quantity checks: ask your builder", 14);
    para("These are planning questions, not accusations. A different scope or a different mix can explain them.", { size: 8.5, color: C.muted });
    for (const q of report.quantityChecks) para(`- ${q.message}`, { size: 8.5, color: C.ink, gap: 3 });
  }

  // Questions
  heading("Questions to ask your builder", 14);
  report.questions.forEach((q, i) => para(`${i + 1}. ${q}`, { size: 8.8, color: C.ink, gap: 3 }));

  // What is not covered
  heading("What this report does not cover", 14);
  for (const item of [
    "The plot of land, stamp duty, survey and title work.",
    "The contractor's fee, profit, overhead, financing and site preliminaries.",
    "Architect's, engineer's and quantity surveyor's fees, and any design changes.",
    "Structural design, soil conditions, retaining walls, water and power connections.",
    "Anything not in our price data, including imported or specialist finishes."
  ]) para(`- ${item}`, { size: 8.3, color: C.muted, gap: 1 });

  // Disclaimer
  heading("Disclaimer", 14);
  para(report.disclaimer, { size: 8.3, color: C.muted });
  para("SendFair is independent and run from Nairobi. We do not sell building materials, build houses or receive a fee from your builder. This report is a comparison, not a valuation.", { size: 8.3, color: C.muted });

  // Footers on every page
  for (let i = 0; i < doc.pages.length; i++) {
    doc.page = doc.pages[i];
    const top = doc.height - 28;
    doc.line(M, top, M + W, top, { color: C.line, width: 0.4 });
    doc.text(M, top + 6, "SendFair · sendfair.africa · Quote Check", { size: 7, color: C.muted });
    doc.text(M + W - 60, top + 6, `Page ${i + 1} of ${doc.pages.length}`, { size: 7, color: C.muted });
  }

  return doc.output();
}
