// Scrapes WorldRemit's public web quote for each SendFair route using a headless browser
// (WorldRemit renders its rate with JavaScript, so a plain fetch returns no rate).
// Writes data/worldremit-quotes.json, which the build merges into the comparison.
// Run by .github/workflows/worldremit.yml on a schedule.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));

const corridors = read("data/corridors.json");
const config = read("config.json");

// SendFair sender id -> WorldRemit send country code (ISO) + currency. "europe" uses Germany
// as the eurozone proxy because WorldRemit asks for a specific send country.
const SEND = {
  uk: { cc: "gb", cur: "GBP" },
  us: { cc: "us", cur: "USD" },
  canada: { cc: "ca", cur: "CAD" },
  australia: { cc: "au", cur: "AUD" },
  europe: { cc: "de", cur: "EUR" },
};
// SendFair receiver id -> WorldRemit receive country code + currency.
const RECV = {
  nigeria: { cc: "ng", cur: "NGN" }, ghana: { cc: "gh", cur: "GHS" }, kenya: { cc: "ke", cur: "KES" },
  uganda: { cc: "ug", cur: "UGX" }, zambia: { cc: "zm", cur: "ZMW" }, zimbabwe: { cc: "zw", cur: "USD" },
  egypt: { cc: "eg", cur: "EGP" }, morocco: { cc: "ma", cur: "MAD" }, senegal: { cc: "sn", cur: "XOF" },
  ivorycoast: { cc: "ci", cur: "XOF" }, mali: { cc: "ml", cur: "XOF" }, cameroon: { cc: "cm", cur: "XAF" },
  ethiopia: { cc: "et", cur: "ETB" }, southafrica: { cc: "za", cur: "ZAR" }, tanzania: { cc: "tz", cur: "TZS" },
  drc: { cc: "cd", cur: "USD" }, rwanda: { cc: "rw", cur: "RWF" },
};

const jobs = [];
for (const s of corridors.senders) for (const r of corridors.receivers) {
  if (SEND[s.id] && RECV[r.id]) jobs.push({ route: `${s.id}-${r.id}`, from: SEND[s.id], to: RECV[r.id], amount: (config.defaultAmounts && config.defaultAmounts[SEND[s.id].cur]) || 250 });
}

function parseRate(text, fromCur, toCur) {
  const m = text.match(new RegExp("1\\s*" + fromCur + "\\s*=\\s*([\\d,.]+)\\s*" + toCur, "i"))
    || text.match(/1\s*[A-Z]{3}\s*=\s*([\d,.]+)\s*[A-Z]{3}/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
}

async function scrape(browser, job) {
  const url = `https://www.worldremit.com/en?selectfrom=${job.from.cc}&selectto=${job.to.cc}&amountfrom=${job.amount}&currencyfrom=${job.from.cur.toLowerCase()}&currencyto=${job.to.cur.toLowerCase()}`;
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(6000); // let the JavaScript quote render
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
    const rate = parseRate(text, job.from.cur, job.to.cur);
    if (!rate || rate <= 0) return null;
    return { provider: "worldremit", rate, feeFixed: 0, feePct: 0, payout: ["bank"], speed: "", note: "Updated automatically from WorldRemit; confirm on the provider's site", refAmount: job.amount, checkedAt: new Date().toISOString(), source: "worldremit" };
  } catch (e) {
    console.log(`${job.route}: ${e && e.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// Small concurrency pool so the whole run stays fast.
async function pool(jobs, limit, fn) {
  const results = new Array(jobs.length);
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < jobs.length) {
      const idx = i++;
      results[idx] = await fn(jobs[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

const browser = await chromium.launch();
const out = { updatedAt: new Date().toISOString(), quotes: {} };
let ok = 0, failed = 0;
try {
  const results = await pool(jobs, 6, async (job) => {
    const q = await scrape(browser, job);
    if (q) return q;
    return null;
  });
  for (let i = 0; i < jobs.length; i++) {
    if (results[i]) { out.quotes[jobs[i].route] = [results[i]]; ok++; } else failed++;
  }
} finally {
  await browser.close();
}

if (!ok) {
  console.error("WorldRemit: no quotes scraped. Refusing to write an empty file.");
  process.exitCode = 1;
} else {
  fs.writeFileSync(path.join(ROOT, "data/worldremit-quotes.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(`WorldRemit: ${ok} quotes scraped, ${failed} failed.`);
}
