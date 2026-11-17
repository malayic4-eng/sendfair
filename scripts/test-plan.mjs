// House-plan test: creates a plan through the real /api/plan handler (with local ASSETS + in-memory KV),
// then renders the plan page and checks the receipt, exclusions, quote comparison and noindex.
import fs from "node:fs";
import { onRequestPost } from "../functions/api/plan.js";
import { planPage } from "../src/plan-page.mjs";

const kv = new Map();
const env = {
  SENDFAIR_KV: {
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    put: async (k, v) => { kv.set(k, v); }
  },
  ASSETS: {
    fetch: async (req) => {
      const p = new URL(req.url).pathname.replace(/^\//, "");
      const body = fs.readFileSync(new URL("../" + p, import.meta.url));
      return new Response(body, { headers: { "content-type": "application/json" } });
    }
  }
};

const req = new Request("https://sendfair.africa/api/plan", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
  body: JSON.stringify({ country: "kenya", state: { size: "3", finish: "standard", site: "flat", quote: "5000000" } })
});
const res = await onRequestPost({ request: req, env });
const saved = await res.json();
if (res.status !== 200 || !saved.id) { console.error("plan save failed:", res.status, saved); process.exit(1); }

const plan = JSON.parse(kv.get("plan:" + saved.id));
const html = planPage({ plan, logo: '<svg width="34" height="34"></svg>', site: "https://sendfair.africa" });
fs.writeFileSync("dist/plan-preview.html", html);

const money = (n, cur) => {
  const d = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
  return cur + " " + Number(n).toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: 0 });
};
const expect = [
  ["id is 8 chars", /^[a-z0-9]{8}$/.test(saved.id)],
  ["plan url", saved.url === `/cost-to-build/kenya/plan/${saved.id}/`],
  ["receipt frozen with date", /Prices as of <strong>[^<]+<\/strong>/.test(html)],
  ["receipt total", html.includes(money(plan.receipt.total, plan.receipt.currency))],
  ["itemised lines", plan.receipt.lines.length > 10 && html.includes("Receipt total")],
  ["exclusions", html.includes("What is not in this receipt") && html.includes("Land.") && html.includes("contractor's fee")],
  ["quote comparison", html.includes("Their quote vs this receipt") && html.includes("Their figure is")],
  ["noindex", html.includes('name="robots" content="noindex"')],
  ["site URL", html.includes("sendfair.africa")],
  ["re-price link", html.includes("Re-price at today's prices")],
  ["WhatsApp share", html.includes("https://wa.me/?text=") && html.includes("itemised%20cost%20of%20the%20house")],
  ["plan_shared tracking", html.includes("plan_shared")]
];
let bad = 0;
for (const [name, ok] of expect) { if (!ok) { bad++; console.log("FAIL:", name); } }
console.log(`plan test: ${expect.length - bad}/${expect.length} checks passed; total ${money(plan.receipt.total, plan.receipt.currency)} for ${plan.receipt.houseName} in ${plan.receipt.countryName}; preview dist/plan-preview.html`);
if (bad) process.exitCode = 1;
