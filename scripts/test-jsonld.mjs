// Validates the JSON-LD on every built page: one @context + @graph, every node has @type,
// the required fields per type, and the new rate/route/provider nodes are present.
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("dist");
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith(".html")) files.push(p); } })(OUT);
const rel = (p) => p.replace(OUT + path.sep, "").replace(/\\/g, "/");
const issues = [];
const add = (page, msg) => issues.push(`${page}: ${msg}`);

let pages = 0, graphs = 0, nodes = 0;
for (const file of files) {
  const html = fs.readFileSync(file, "utf8");
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) continue;
  pages++;
  let doc;
  try { doc = JSON.parse(m[1]); } catch (e) { add(rel(file), "invalid JSON: " + e.message); continue; }
  if (doc["@context"] !== "https://schema.org") add(rel(file), "missing @context");
  if (!Array.isArray(doc["@graph"])) { add(rel(file), "missing @graph"); continue; }
  graphs++;
  for (const item of doc["@graph"]) {
    nodes++;
    if (!item || typeof item !== "object" || Array.isArray(item)) { add(rel(file), "item is not an object"); continue; }
    const t = item["@type"];
    if (!t) { add(rel(file), "item without @type"); continue; }
    if (t === "FAQPage" && !Array.isArray(item.mainEntity)) add(rel(file), "FAQPage without mainEntity");
    if (t === "BreadcrumbList" && !Array.isArray(item.itemListElement)) add(rel(file), "BreadcrumbList without itemListElement");
    if (t === "Dataset" && !item.name) add(rel(file), "Dataset without name");
    if (t === "Article" && !item.headline) add(rel(file), "Article without headline");
    if (t === "Organization" && !item.name) add(rel(file), "Organization without name");
    if (t === "ExchangeRateSpecification") {
      if (!item.currency || !item.currentExchangeRate) add(rel(file), "ExchangeRateSpecification incomplete");
      else if (!(item.currentExchangeRate.price > 0) || !item.currentExchangeRate.priceCurrency) add(rel(file), "ExchangeRateSpecification price/currency missing");
    }
    if (t === "ItemList") {
      if (!Array.isArray(item.itemListElement) || !item.itemListElement.length) add(rel(file), "ItemList without items");
      else for (const li of item.itemListElement) {
        if (!li.position || !li.item || !li.item.name || !li.item.additionalProperty || !li.item.offers) add(rel(file), "ItemList entry incomplete (name/additionalProperty/offers)");
      }
    }
  }
}

function hasType(re, type) { const f = files.find((p) => re.test(rel(p))); return !!(f && fs.readFileSync(f, "utf8").includes(`"@type":"${type}"`)); }
const samples = [
  [/^rates\/[a-z]+-to-[a-z]+\/index\.html$/, "ExchangeRateSpecification"],
  [/^rates\/[a-z]+-to-[a-z]+\/index\.html$/, "Dataset"],
  [/^send-money\/[a-z-]+\/index\.html$/, "ItemList"],
  [/^providers\/[a-z]+\/index\.html$/, "Organization"]
];
let ok = 0;
for (const [re, type] of samples) { if (hasType(re, type)) ok++; else add("samples", `missing ${type} on pages matching ${re}`); }

console.log(`jsonld: ${pages} pages with JSON-LD, ${graphs} @graph documents, ${nodes} nodes, ${issues.length} issue(s); samples ${ok}/${samples.length} ok`);
issues.slice(0, 40).forEach((i) => console.log("  " + i));
if (issues.length) process.exitCode = 1;
