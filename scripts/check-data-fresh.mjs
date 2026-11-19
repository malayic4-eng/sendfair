// Fails (exit 1) when the Wise feed has stopped refreshing: data/wise-feed.json older than 6 hours, or no
// routes with quotes. Run as the last step of the "Update rates" workflow (with `if: always()`), so a
// failed run makes GitHub email the owner. If RESEND_API_KEY + OWNER_ALERT_EMAIL or OWNER_ALERT_WEBHOOK
// are set, the owner is also told directly, at most about once a day (when the feed first turns 6 h
// old, then every 24 h), so a long outage does not send an email every 30 minutes.
//   node scripts/check-data-fresh.mjs [--now=ISO] [--feed=path] [--max-age-h=6]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshnessProblems } from "./feed-lib.mjs";
import { notifyOwner } from "./providers/notify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const val = (k, d) => { const a = process.argv.find((x) => x.startsWith(k + "=")); return a ? a.slice(k.length + 1) : d; };
const now = Date.parse(val("--now", new Date().toISOString()));
const maxAgeH = Number(val("--max-age-h", 6));
const file = val("--feed", path.join(ROOT, "data/wise-feed.json"));

let feed = null;
try { feed = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const problems = freshnessProblems({ feed, now, maxAgeH });
if (!problems.length) {
  const routes = Object.values(feed.routes || {}).filter((p) => p && Object.keys(p).length).length;
  console.log(`Data fresh: Wise feed updated ${((now - Date.parse(feed.updatedAt)) / 3600000).toFixed(1)} h ago, ${routes} routes with quotes.`);
  process.exit(0);
}
problems.forEach((p) => console.error("STALE DATA: " + p));

const ageH = feed && feed.updatedAt ? (now - Date.parse(feed.updatedAt)) / 3600000 : NaN;
// Direct alert once when the feed first goes stale (first hour past the limit), then once a day.
const due = !isFinite(ageH) || (ageH - maxAgeH) % 24 < 1;
const configured = (process.env.RESEND_API_KEY && process.env.OWNER_ALERT_EMAIL) || process.env.OWNER_ALERT_WEBHOOK;
if (configured && due) {
  const res = await notifyOwner({
    subject: "SendFair: exchange-rate data is not updating",
    text: problems.join("\n") + "\n\nUntil this is fixed the site keeps showing the last prices, marked with their age. Check the WISE_API_TOKEN secret and the latest \"Update rates\" run in GitHub Actions."
  });
  console.log("Owner alert: " + (res.sent ? "sent via " + res.sent : "not sent (" + res.error + ")"));
}
process.exit(1);
