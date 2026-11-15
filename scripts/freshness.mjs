// Flag guides and house prices that have gone 90 days without a review.
// If GSC_ACCESS_TOKEN and GSC_SITE are set, also list Search Console pages
// whose clicks fell by more than 30% against the previous 28 days.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86400000;
const LIMIT = 90;
const now = Date.now();
const stale = [];

const guides = JSON.parse(fs.readFileSync(path.join(root, "data/guides.json"), "utf8"));
for (const item of [...guides.pillars, ...guides.articles]) {
  const age = (now - Date.parse(item.updated)) / DAY;
  if (!(age >= 0) || age > LIMIT) stale.push(`Guide "${item.title}" was marked ${item.updated || "with no date"}.`);
}

const costs = JSON.parse(fs.readFileSync(path.join(root, "data/build-costs.json"), "utf8"));
if (costs.nextReview && Date.parse(costs.nextReview) < now) {
  stale.push(`House prices were due for review on ${costs.nextReview}.`);
}

const token = process.env.GSC_ACCESS_TOKEN;
const site = process.env.GSC_SITE;
if (token && site) {
  const end = new Date(now - 3 * DAY).toISOString().slice(0, 10);
  const mid = new Date(now - 31 * DAY).toISOString().slice(0, 10);
  const start = new Date(now - 59 * DAY).toISOString().slice(0, 10);
  const query = async (startDate, endDate) => {
    const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate, dimensions: ["page"], rowLimit: 200 })
    });
    if (!res.ok) throw new Error(`Search Console ${res.status}`);
    const data = await res.json();
    const map = new Map();
    for (const row of data.rows || []) map.set(row.keys[0], row);
    return map;
  };
  try {
    const recent = await query(mid, end);
    const prior = await query(start, mid);
    for (const [url, row] of recent) {
      const before = prior.get(url);
      if (!before || before.clicks < 20) continue;
      if (row.clicks < before.clicks * 0.7) stale.push(`Search Console clicks fell for ${url}: ${before.clicks} to ${row.clicks}.`);
    }
  } catch (err) {
    console.error(String(err.message || err));
    process.exitCode = 1;
  }
} else {
  console.log("Search Console was not queried. Set GSC_ACCESS_TOKEN and GSC_SITE to include click drops.");
}

if (stale.length) {
  console.error("Pages to review:\n" + stale.map((s) => "  - " + s).join("\n"));
  process.exitCode = 1;
} else {
  console.log("No guide or house-price date is older than 90 days.");
}
