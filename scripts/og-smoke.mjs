// Local smoke test for the share card: renders the real card for UK→Kenya £250 to PNG files in dist/.
// Run: node scripts/og-smoke.mjs   (not part of the site build)
import fs from "node:fs";
import satori from "satori";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { resultCard } from "../src/og-result.mjs";
import { resultModel } from "../src/og-model.mjs";

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
const config = read("../config.json");
const data = {
  quotes: read("../data/quotes.json"),
  feed: read("../data/wise-feed.json"),
  providers: read("../data/providers.json"),
  corridors: read("../data/corridors.json"),
  midmarket: read("../data/midmarket.json"),
  site: { staleAfterHours: config.staleAfterHours, hideAfterHours: config.hideAfterHours, preferAutoAfterHours: config.preferAutoAfterHours, handLockHours: config.handLockHours, defaultAmounts: config.defaultAmounts }
};
const route = process.argv[2] || "uk-kenya", amount = Number(process.argv[3] || 250);
const m = resultModel(data, route, amount, Date.now());
if (!m) throw new Error("no live data for " + route);
const nf = (v) => Math.round(v).toLocaleString("en");
const model = {
  amountLabel: amount,
  country: m.r.name,
  bestName: m.best.p.name,
  bestGets: m.r.currency + " " + nf(m.best.gets),
  delta: "+" + m.r.currency + " " + nf(m.best.gets - m.lowest.gets) + " more than the lowest",
  date: new Date(data.quotes.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
};

const font400 = fs.readFileSync(new URL("../src/fonts/figtree-latin-400-normal.woff", import.meta.url));
const font700 = fs.readFileSync(new URL("../src/fonts/figtree-latin-700-normal.woff", import.meta.url));
await initWasm(fs.readFileSync(new URL("../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url)));
for (const story of [false, true]) {
  const w = story ? 1080 : 1200, h = story ? 1920 : 630;
  const svg = await satori(resultCard({ ...model, story }), { width: w, height: h, fonts: [{ name: "Figtree", data: font400, weight: 400 }, { name: "Figtree", data: font700, weight: 700 }] });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: w } }).render().asPng();
  const out = `dist/og-test-${story ? "story" : "wide"}.png`;
  fs.writeFileSync(out, png);
  console.log(out, w + "x" + h, png.length + " bytes");
}
