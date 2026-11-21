// Monthly flight prices for the busiest routes home, from the Travelpayouts (Aviasales) Data API.
// Writes data/fares.json, which the build turns into "flight prices by month" pages. Needs the secret
// TRAVELPAYOUTS_TOKEN (the owner's API token from the Travelpayouts profile); without it, does nothing.
// The Data API returns prices travellers found in the last few days (cached), not live fares, and the
// pages say so. Run weekly by .github/workflows/fares.yml.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
const token = process.env.TRAVELPAYOUTS_TOKEN || "";
if (!token) { console.log("No TRAVELPAYOUTS_TOKEN: flight prices not fetched."); process.exit(0); }

const config = read("config.json"), partners = read("data/partners.json"), corridors = read("data/corridors.json");
const sender = Object.fromEntries(corridors.senders.map((s) => [s.id, s]));
const pairs = [];
for (const key of config.priorityRoutes || []) {
  const [sid, rid] = key.split("-");
  const origins = (partners.origins || {})[sid] || [], ports = (partners.airports || {})[rid] || [];
  for (const [o] of origins.slice(0, 2)) if (ports[0]) pairs.push({ o, d: ports[0][0], receiver: rid, currency: (sender[sid] || {}).currency || "USD" });
}
const months = [];
{ const d = new Date(); d.setUTCDate(1); for (let i = 0; i < 12; i++) { months.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); } }
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { updatedAt: new Date().toISOString(), note: "Lowest return fares travellers found on Aviasales in the last few days, by departure month (Travelpayouts Data API, cached). Live fares differ.", pairs: {} };
let ok = 0, fail = 0;
for (const p of pairs) {
  const k = `${p.o}-${p.d}`;
  if (out.pairs[k]) continue;
  const rows = [];
  for (const m of months) {
    const u = `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=${p.o}&destination=${p.d}&departure_at=${m}&one_way=false&direct=false&sorting=price&unique=false&limit=1&page=1&currency=${p.currency.toLowerCase()}&token=${encodeURIComponent(token)}`;
    try {
      const r = await fetch(u, { headers: { "accept-encoding": "gzip" } });
      const j = await r.json();
      const x = j && j.success !== false && Array.isArray(j.data) ? j.data[0] : null;
      if (x && x.price > 0) { rows.push({ month: m, price: Math.round(x.price), airline: x.airline || "", transfers: x.transfers ?? null, departure: x.departure_at || "", return: x.return_at || "" }); ok++; }
      else fail++;
    } catch { fail++; }
    await pause(250);
  }
  if (rows.length) out.pairs[k] = { origin: p.o, dest: p.d, receiver: p.receiver, currency: p.currency, months: rows };
}
fs.writeFileSync(path.join(ROOT, "data/fares.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`Flight prices: ${Object.keys(out.pairs).length} routes, ${ok} months priced, ${fail} with no cached price.`);
