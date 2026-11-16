// Scrapes extra remittance operators (Ria, Mukuru, TransferGo, Paysend, Xe, Small World, ACE,
// Sigue, OFX) using a headless browser. Each operator's calculator differs, so this v1 uses a
// shared harness + generic rate/fee extraction and dumps a sample of each operator's page text
// to data/extra-debug.txt so the per-operator parsing can be tuned.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
const corridors = read("data/corridors.json");
const config = read("config.json");

const SEND = {
  uk: { cc: "gb", cur: "GBP" }, us: { cc: "us", cur: "USD" }, canada: { cc: "ca", cur: "CAD" },
  australia: { cc: "au", cur: "AUD" }, europe: { cc: "de", cur: "EUR" },
};
const RECV = {
  nigeria: { cc: "ng", cur: "NGN" }, ghana: { cc: "gh", cur: "GHS" }, kenya: { cc: "ke", cur: "KES" },
  uganda: { cc: "ug", cur: "UGX" }, zambia: { cc: "zm", cur: "ZMW" }, zimbabwe: { cc: "zw", cur: "USD" },
  egypt: { cc: "eg", cur: "EGP" }, morocco: { cc: "ma", cur: "MAD" }, senegal: { cc: "sn", cur: "XOF" },
  ivorycoast: { cc: "ci", cur: "XOF" }, mali: { cc: "ml", cur: "XOF" }, cameroon: { cc: "cm", cur: "XAF" },
  ethiopia: { cc: "et", cur: "ETB" }, southafrica: { cc: "za", cur: "ZAR" }, tanzania: { cc: "tz", cur: "TZS" },
  drc: { cc: "cd", cur: "USD" }, rwanda: { cc: "rw", cur: "RWF" },
};

// Operators that survived testing. The rest were removed:
// - Ria, Mukuru, ACE Money Transfer: blocked by Cloudflare bot protection (anti-bot page).
// - Sigue: the company has shut down ("Sigue Corporation is no longer operating").
// - Small World: smallworldfs.com is now a finance content farm, not the remitter.
// - OFX: public page shows only the interbank rate, not their actual customer rate.
// - Xe: URL params are ignored (returns a default India quote -> wrong data).
// TransferGo and Paysend need correct calculator URLs (the ones below 404 for now); fix before re-enabling.
const OPERATORS = [
  { id: "transfergo", name: "TransferGo", url: (f, t, a) => `https://www.transfergo.com/en?from=${f.cc.toUpperCase()}&to=${t.cc.toUpperCase()}&amount=${a}` },
  { id: "paysend", name: "Paysend", url: (f, t, a) => `https://paysend.com/en/send-money` },
];

function parseRate(text, fromCur, toCur) {
  const m = text.match(new RegExp("1\\s*" + fromCur + "\\s*=\\s*([\\d,.]+)\\s*" + toCur, "i"))
    || text.match(/1\s*[A-Z]{3}\s*=\s*([\d,.]+)\s*[A-Z]{3}/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
}
function parseFee(text) {
  const m = text.match(/Fee\s*\n+\s*([\d,.]+)\s*[A-Z]{3}/) || text.match(/(?:fee|transfer fee)\s*[:]?\s*([\d,.]+)\s*[A-Z]{3}/i);
  return m ? parseFloat(m[1].replace(/,/g, "")) : 0;
}

const jobs = [];
for (const s of corridors.senders) for (const r of corridors.receivers) {
  if (SEND[s.id] && RECV[r.id]) jobs.push({ route: `${s.id}-${r.id}`, from: SEND[s.id], to: RECV[r.id], amount: (config.defaultAmounts && config.defaultAmounts[SEND[s.id].cur]) || 250 });
}

async function scrape(browser, op, job) {
  const page = await browser.newPage();
  try {
    await page.goto(op.url(job.from, job.to, job.amount), { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(6000);
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
    const rate = parseRate(text, job.from.cur, job.to.cur);
    const promo = /first transfer|promo|new customer/i.test(text);
    if (!rate || rate <= 0 || promo) return { quote: null, text };
    const fee = parseFee(text);
    return { quote: { provider: op.id, rate, feeFixed: fee, feePct: 0, payout: ["bank"], speed: "", note: `Updated automatically from ${op.name}; confirm on the provider's site`, refAmount: job.amount, checkedAt: new Date().toISOString(), source: "scrape" }, text };
  } catch (e) {
    console.log(`${op.id} ${job.route}: ${e && e.message}`);
    return { quote: null, text: "" };
  } finally {
    await page.close();
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const workers = Array.from({ length: limit }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } });
  await Promise.all(workers);
  return out;
}

const browser = await chromium.launch();
{ const w = await browser.newPage(); try { await w.goto("https://www.riamoneytransfer.com", { waitUntil: "domcontentloaded", timeout: 45000 }); await w.waitForTimeout(4000); } catch {} await w.close(); }

const out = { updatedAt: new Date().toISOString(), quotes: {} };
const debug = [];
for (const op of OPERATORS) {
  // Scrape a small sample per operator for now: first 4 routes (us->first 4 receivers).
  const sample = jobs.slice(0, 4);
  const results = await pool(sample, 4, (job) => scrape(browser, op, job));
  let ok = 0;
  for (let i = 0; i < sample.length; i++) {
    if (results[i] && results[i].quote) { out.quotes[sample[i].route] = [...(out.quotes[sample[i].route] || []), results[i].quote]; ok++; }
  }
  debug.push(`===== ${op.id} (${op.name}) — scraped ${ok}/${sample.length} sample routes =====\n` + (results[0] ? results[0].text : "(no text)"));
  console.log(`${op.id}: ${ok}/${sample.length} sample routes`);
}

await browser.close();

if (Object.keys(out.quotes).length === 0) {
  console.log("Extra providers: no quotes scraped, nothing to write.");
} else {
  fs.writeFileSync(path.join(ROOT, "data/extra-quotes.json"), JSON.stringify(out, null, 1) + "\n");
  fs.writeFileSync(path.join(ROOT, "data/extra-debug.txt"), debug.join("\n\n") + "\n");
  console.log(`Extra providers: wrote data/extra-quotes.json with ${Object.keys(out.quotes).length} route-quotes.`);
}
