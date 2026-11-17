// Sends the latest complete month's report summary to the Buttondown list.
// Run by .github/workflows/monthly-report.yml on the 1st; safe to run by hand (prints the summary if no key).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReports, reportSummary } from "./report-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const escape = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const config = read("config.json");
const history = read("data/history.json");
const quotes = read("data/quotes.json").quotes || {};
const corridors = read("data/corridors.json");
const providers = Object.fromEntries(read("data/providers.json").providers.map((p) => [p.id, p]));
const midmarket = read("data/midmarket.json");
const currentMonth = process.env.SF_REPORT_MONTH || new Date().toISOString().slice(0, 7);
const reports = buildReports({ history, config, quotes, corridors, providers, midmarket, currentMonth });
const r = reports[reports.length - 1];
if (!r) { console.log("No complete month of history yet; nothing to send."); process.exit(0); }

const site = (process.env.SITE_URL || config.siteUrl || "https://sendfair.africa").replace(/\/$/, "");
const url = `${site}/reports/${r.month}/`;
const summary = reportSummary(r);
const key = process.env.BUTTONDOWN_API_KEY;
if (!key) {
  console.log(`BUTTONDOWN_API_KEY not set. ${r.label}\n${url}\n\n${summary}`);
  process.exit(0);
}

// The page is rebuilt by Cloudflare on the next data push; wait for it before mailing the link.
let live = false;
for (let i = 0; i < 10 && !live; i++) {
  try { const res = await fetch(url); live = res.ok; } catch {}
  if (!live) await new Promise((x) => setTimeout(x, 30000));
}
if (!live) { console.error(`Report page ${url} is not live yet; not sending.`); process.exit(1); }

const res = await fetch("https://api.buttondown.email/v1/emails", {
  method: "POST",
  headers: { Authorization: `Token ${key}`, "content-type": "application/json" },
  body: JSON.stringify({
    subject: `SendFair Remittance Cost Index — ${r.label}`,
    body: `<p>${escape(summary)}</p><p><a href="${url}">Read the full ${r.label} report</a>. CC BY 4.0. Source: SendFair (sendfair.africa).</p>`,
    status: "sent"
  })
});
console.log(`Buttondown: ${res.status} ${await res.text()}`);
if (!res.ok) process.exitCode = 1;
