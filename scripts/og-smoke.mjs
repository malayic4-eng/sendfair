// Local smoke test for the share card: renders the Satori tree to PNG files in dist/.
// Run: node scripts/og-smoke.mjs   (not part of the site build)
import fs from "node:fs";
import satori from "satori";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { resultCard } from "../src/og-result.js";

const font400 = fs.readFileSync(new URL("../src/fonts/figtree-latin-400-normal.woff", import.meta.url));
const font700 = fs.readFileSync(new URL("../src/fonts/figtree-latin-700-normal.woff", import.meta.url));
await initWasm(fs.readFileSync(new URL("../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url)));

const model = { amountLabel: "£250", country: "Nigeria", bestName: "Instarem", bestGets: "NGN 416,330", delta: "+NGN 8,410 more than the lowest", date: "17 Nov 2026" };
for (const story of [false, true]) {
  const w = story ? 1080 : 1200, h = story ? 1920 : 630;
  const svg = await satori(resultCard({ ...model, story }), { width: w, height: h, fonts: [{ name: "Figtree", data: font400, weight: 400 }, { name: "Figtree", data: font700, weight: 700 }] });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: w } }).render().asPng();
  const out = `dist/og-test-${story ? "story" : "wide"}.png`;
  fs.writeFileSync(out, png);
  console.log(out, w + "x" + h, png.length + " bytes");
}
