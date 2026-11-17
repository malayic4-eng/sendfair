// Standalone, noindex plan page rendered by the Worker from a frozen receipt stored in KV.
// Pure string builder (no DOM), so it can be rendered in a local test as well.
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function money(n, cur) {
  if (!(n > 0) && n !== 0) return "–";
  const d = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
  return cur + " " + Number(n).toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: 0 });
}

function quoteText(amount, total, cur) {
  if (!(amount > 0)) return "";
  const diff = amount - total, pct = total > 0 ? Math.round(Math.abs(diff) / total * 100) : 0;
  const bits = [`Their figure is ${money(amount, cur)}. This receipt is ${money(total, cur)}.`];
  if (diff > total * 0.02) bits.push(`It is ${money(diff, cur)} above the receipt, about ${pct}%. Ask which line pays for the gap: the contractor's margin, haulage or a reserve.`);
  else if (diff < -total * 0.02) bits.push(`It is ${money(-diff, cur)} below the receipt, about ${pct}%. Ask which lines are missing: the finish, the septic tank, the boundary wall, the gate or the permit.`);
  else bits.push("It sits with this receipt. Ask them to show the same quantities.");
  return bits.join(" ");
}

export function planPage({ plan, logo, site, analytics = {} }) {
  const r = plan.receipt, cur = r.currency, country = plan.country;
  const withSet = String(plan.state && plan.state.with || "").split(",").filter(Boolean);
  const st = Object.assign({}, plan.state || {});
  const citySlug = /^[a-z]{2,30}$/.test(st.city || "") ? st.city : "";
  delete st.city;
  const q = new URLSearchParams(st).toString();
  const reprice = `/cost-to-build/${country}/${citySlug ? citySlug + "/" : ""}${q ? "?" + q : ""}`;
  const link = `${site}/cost-to-build/${country}/plan/${plan.id}/`;
  const waText = "Here's the itemised cost of the house: " + link;

  let lastGroup = null, rows = "";
  for (const l of r.lines) {
    if (l.group !== lastGroup) { rows += `<tr class="grp"><th colspan="4">${esc(l.group)}</th></tr>`; lastGroup = l.group; }
    const rate = l.qty > 0 && l.cost > 0 ? l.cost / l.qty : null;
    rows += `<tr><td><div class="item">${esc(l.label)}</div>${l.source ? `<div class="src">${esc(l.source)}</div>` : ""}</td><td class="qty">${esc(l.qtyLabel || "")}</td><td class="num">${rate ? money(rate, cur) : "–"}</td><td class="num">${l.cost > 0 ? money(l.cost, cur) : "–"}</td></tr>`;
  }

  let extra = 0, allow = "";
  if (withSet.includes("contingency")) { extra += r.contingency.amount; allow += `<li><strong>Contingency, ${Math.round(r.contingency.rate * 100)}%.</strong> ${money(r.contingency.amount, cur)}. ${esc(r.contingency.source)}</li>`; }
  if (withSet.includes("contractor")) { if (r.contractor.amount > 0) extra += r.contractor.amount; allow += `<li><strong>Contractor's fee.</strong> ${r.contractor.amount > 0 ? money(r.contractor.amount, cur) + ". " : "Not priced. "}${esc(r.contractor.source)}</li>`; }
  if (withSet.includes("professional")) allow += `<li><strong>Architect and engineer.</strong> Not priced. ${esc(r.professional.source)}</li>`;

  const quote = Number(plan.quote) > 0
    ? `<section class="card"><h2>Their quote vs this receipt</h2><p>${esc(quoteText(Number(plan.quote), r.total, cur))}</p></section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>House receipt: ${esc(r.houseName)} in ${esc(r.countryName)} · SendFair</title>
<style>
@font-face{font-family:Figtree;src:url(/assets/fonts/figtree-latin-wght-normal.woff2) format("woff2");font-weight:300 900;font-display:swap}
:root{--ink:#151b45;--muted:#5c6287;--indigo:#1b2470;--marigold:#f6b52b;--line:#e4e6f0;--bg:#f4f5fa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 Figtree,system-ui,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:0 20px}
header.wrap{display:flex;flex-direction:column;gap:10px;padding-top:28px}
.brand{display:inline-flex;align-items:center;gap:10px;font:800 1.25rem/1 Figtree,sans-serif;color:var(--indigo)}
.brand svg{width:34px;height:34px;flex:none}
.kicker{text-transform:uppercase;letter-spacing:.12em;font-size:.72rem;font-weight:700;color:var(--muted);margin:6px 0 0}
h1{font-size:1.9rem;line-height:1.15;margin:0}
.meta{color:var(--muted);margin:0}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 6px}
.actions a,.actions button{font:600 .9rem Figtree,sans-serif;border-radius:999px;padding:9px 15px;border:1px solid var(--indigo);background:transparent;color:var(--indigo);cursor:pointer;text-decoration:none}
.actions button.primary{background:var(--indigo);color:#fff}
main.wrap{padding-bottom:40px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:16px}
.card h2{font-size:1.05rem;margin:0 0 10px}
.total{font:800 2rem/1.1 Figtree,sans-serif;color:var(--indigo);margin:0 0 6px}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
tr.grp th{background:#f0f1f8;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--indigo);border-bottom:0}
td.qty{color:var(--muted);width:28%}
td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr.total th,tr.total td{border-top:2px solid var(--indigo);font-weight:800;font-size:1.05rem}
.item{font-weight:600}.src{color:var(--muted);font-size:.78rem;margin-top:2px}
ul{margin:8px 0 0;padding-left:18px}li{margin:4px 0}
footer{color:var(--muted);font-size:.85rem;margin-top:22px;border-top:1px solid var(--line);padding-top:12px}
@media print{
  @page{margin:14mm}
  body{background:#fff;font-size:11.5pt}
  .wrap{max-width:none;padding:0}
  .no-print{display:none!important}
  .card{border:0;padding:0;margin:0 0 14px;break-inside:avoid}
  header.wrap{padding-top:0}
  h1{font-size:20pt}.total{font-size:18pt}
  th,td{padding:5px 4px;font-size:10.5pt}
  tr.grp th{background:#eee;print-color-adjust:exact}
  a{color:inherit;text-decoration:none}
}
</style>
</head>
<body>
<header class="wrap">
  <div class="brand">${logo || ""}<span>SendFair</span></div>
  <p class="kicker">Itemised house cost</p>
  <h1>${esc(r.houseName)} in ${r.citySlug ? esc(r.city) + ", " : ""}${esc(r.countryName)}</h1>
  <p class="meta">${esc(r.area)} m² · ${esc(r.shape)} · ${esc(r.city)} · Prices as of <strong>${esc(r.updated)}</strong></p>
  <div class="actions no-print">
    <button type="button" id="copy">Copy link</button>
    <a id="wa" href="https://wa.me/?text=${encodeURIComponent(waText)}" target="_blank" rel="noopener">WhatsApp</a>
    <button type="button" class="primary" id="print">Download PDF</button>
    <a href="${esc(reprice)}">Re-price at today's prices</a>
  </div>
</header>
<main class="wrap">
  <section class="card">
    <h2>The receipt, without land or the contractor's fee</h2>
    <p class="total">${money(r.total, cur)}</p>
    <p class="meta">${r.quotedLines} listed prices, ${r.guideLines} planning guides, ${r.missing} lines with no published price in this check. Prices as of ${esc(r.updated)}; confirm on the supplier's screen before you pay.</p>
    <table>
      <thead><tr><th scope="col">Item</th><th scope="col">Quantity</th><th scope="col" class="num">Rate</th><th scope="col" class="num">Amount</th></tr></thead>
      <tbody>${rows}
        <tr class="total"><th colspan="3">Receipt total</th><td class="num">${money(r.total, cur)}</td></tr>
      </tbody>
    </table>
  </section>
  ${allow ? `<section class="card"><h2>Allowances you ticked</h2><p class="meta">The receipt above does not change when an allowance is ticked.</p><ul>${allow}</ul>${extra > 0 ? `<p><strong>Receipt plus the priced allowances: ${money(r.total + extra, cur)}.</strong> The receipt itself is still ${money(r.total, cur)}.</p>` : ""}</section>` : ""}
  ${quote}
  <section class="card">
    <h2>What is not in this receipt</h2>
    <ul>
      <li><strong>Land.</strong> The plot is not priced here.</li>
      <li><strong>The contractor's fee.</strong> A published small-job allowance is shown above only when you tick it; it is not in the receipt.</li>
      <li>Contingency, and the architect's and engineer's fees, only when ticked above.</li>
      <li>A land survey, water beyond the tank, a power connection, a retaining wall on a steep plot, and borrowing costs.</li>
    </ul>
  </section>
  <footer>SendFair · <a href="${esc(site)}/cost-to-build/${esc(country)}/">${esc(site.replace(/^https?:\/\//, ""))}/cost-to-build/${esc(country)}/</a> · This receipt is a check on a contractor's quote, not a quote.</footer>
</main>
<script>
(function(){
  // Same consent rule as the rest of the site: app.js stores the choice as JSON, and Google Analytics,
  // Tag Manager and Clarity load only after "all" (optional cookies) was accepted on sendfair.africa.
  var A=${JSON.stringify({ ga4: analytics.ga4 || "", gtm: analytics.gtm || "", clarity: analytics.clarity || "" }).replace(/</g, "\\u003c")};
  function allowed(){try{return JSON.parse(localStorage.getItem("sf-consent")||"null")==="all";}catch(e){return false;}}
  function load(){
    if(!allowed()||!(A.ga4||A.gtm||A.clarity)||window.__sfTrackers)return;
    window.__sfTrackers=true;window.dataLayer=window.dataLayer||[];
    if(A.gtm){window.dataLayer.push({"gtm.start":Date.now(),event:"gtm.js"});var g=document.createElement("script");g.async=true;g.src="https://www.googletagmanager.com/gtm.js?id="+encodeURIComponent(A.gtm);document.head.appendChild(g);}
    if(A.ga4){var s=document.createElement("script");s.async=true;s.src="https://www.googletagmanager.com/gtag/js?id="+encodeURIComponent(A.ga4);document.head.appendChild(s);window.gtag=function(){window.dataLayer.push(arguments);};window.gtag("js",new Date());window.gtag("config",A.ga4);}
    if(A.clarity){(function(c,l,a,r,i){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments);};var t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+encodeURIComponent(i);var y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script",A.clarity);}
  }
  load();
  function track(name,params){
    try{
      if(!allowed())return;
      window.dataLayer=window.dataLayer||[];
      window.dataLayer.push(Object.assign({event:name},params||{}));
      if(window.gtag)window.gtag("event",name,Object.assign({transport_type:"beacon"},params||{}));
    }catch(e){}
  }
  var link=location.href;
  var copy=document.getElementById("copy");
  if(copy)copy.addEventListener("click",function(){
    try{navigator.clipboard.writeText(link).then(function(){copy.textContent="Link copied";},{})}catch(e){}
    track("plan_shared",{country:${JSON.stringify(country)},method:"copy"});
  });
  var wa=document.getElementById("wa");
  if(wa)wa.addEventListener("click",function(){track("plan_shared",{country:${JSON.stringify(country)},method:"whatsapp"});});
  var pr=document.getElementById("print");
  if(pr)pr.addEventListener("click",function(){track("plan_shared",{country:${JSON.stringify(country)},method:"pdf"});window.print();});
})();
</script>
</body>
</html>`;
}
