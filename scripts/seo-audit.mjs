// SEO crawler/audit: walks the built site and reports broken internal links, missing/duplicate
// titles, missing/duplicate meta descriptions, missing/multiple H1, missing canonical, images
// without alt, and orphan pages (no inbound internal links). Writes data/seo-audit.json and
// exits non-zero when any high/critical issue is found so the workflow surfaces it.
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("dist");
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith(".html")) files.push(p); } })(OUT);

const rel = (p) => p.replace(OUT + path.sep, "").replace(/\\/g, "/");
const issues = [];
const add = (severity, type, page, detail) => issues.push({ severity, type, page: rel(page), detail });

const titleMap = new Map();
const descMap = new Map();
const linked = new Set();

const skipHref = (h) => !h || /^(https?:|mailto:|tel:|data:|javascript:)/.test(h) || h.startsWith("//") || h.includes("/go/") || /^go\//.test(h) || h.startsWith("/admin/") || h.startsWith("admin/");
const resolve = (file, href) => {
  if (href.startsWith("/")) return path.join(OUT, href.slice(1));
  return path.resolve(path.dirname(file), href);
};

for (const file of files) {
  const html = fs.readFileSync(file, "utf8");
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
  const canonical = (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || "";
  const noindex = /<meta name="robots" content="[^"]*noindex/.test(html);
  const h1s = (html.match(/<h1[^>]*>/g) || []).length;
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  const noAlt = imgs.filter((i) => !/\balt=/.test(i)).length;

  if (!title) add("high", "missing-title", file, "no <title>");
  if (!noindex && !desc) add("medium", "missing-description", file, "no meta description");
  if (!noindex && !canonical) add("high", "missing-canonical", file, "no canonical link");
  if (h1s === 0) add("high", "missing-h1", file, "no <h1>");
  else if (h1s > 1) add("medium", "multiple-h1", file, h1s + " <h1> tags");
  if (noAlt > 0) add("low", "missing-alt", file, noAlt + " image(s) without alt text");

  if (title) {
    if (titleMap.has(title)) add("medium", "duplicate-title", file, "same title as " + rel(titleMap.get(title)));
    else titleMap.set(title, file);
  }
  if (desc && !noindex) {
    if (descMap.has(desc)) add("medium", "duplicate-description", file, "same description as " + rel(descMap.get(desc)));
    else descMap.set(desc, file);
  }

  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    let href = m[1];
    if (skipHref(href)) continue;
    href = href.split("#")[0].split("?")[0];
    if (!href) continue;
    const target = resolve(file, href);
    const final = href.endsWith("/") ? path.join(target, "index.html") : target;
    if (fs.existsSync(final)) linked.add(final);
    else add("high", "broken-link", file, "dead link → " + href);
  }
}

for (const file of files) {
  if (linked.has(file)) continue;
  const r = rel(file);
  if (r === "404.html" || r === "offline.html" || r.startsWith("admin/")) continue;
  add("medium", "orphan-page", file, "no inbound internal links");
}

const counts = { critical: 0, high: 0, medium: 0, low: 0 };
for (const i of issues) counts[i.severity] = (counts[i.severity] || 0) + 1;
const report = { generatedAt: new Date().toISOString(), pages: files.length, counts, issues };
fs.writeFileSync("data/seo-audit.json", JSON.stringify(report, null, 1) + "\n");

console.log(`SEO audit: ${files.length} pages — ${issues.length} issue(s) (critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low})`);
for (const i of issues.slice(0, 60)) console.log(`  [${i.severity}] ${i.type}: ${i.page} — ${i.detail}`);
if (counts.critical > 0 || counts.high > 0) { console.error("\nHigh/critical SEO issues found."); process.exitCode = 1; }
