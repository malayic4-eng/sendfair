/* The stand-in checkout used in test mode. It is deliberately obvious that no money moves. */

import { esc, shell } from "./html.js";
import { money } from "../../src/quote-check/config.mjs";

export function renderTestPayPage({ order, amount, currency }) {
  return shell({
    title: "Test checkout · SendFair Quote Check",
    description: "Test-mode checkout for SendFair Quote Check.",
    body: `<section class="wrap qc-report">
<div class="qc-alert qc-test"><strong>Test mode.</strong> This is not a real checkout. No card is charged and no money moves. Use this to review the full Quote Check flow.</div>
<p class="qc-kicker">Quote Check · ${esc(order.countryName)}</p>
<h1>Test payment</h1>
<p class="qc-meta">${esc(order.countryName)} · ${esc(order.houseType)} · ${esc(order.m2)} m² · Reference ${esc(order.id)}</p>
<div class="qc-pay">
<h2>${money(amount, currency)}</h2>
<p>Pressing the button marks this test order paid and releases the full report. In live mode this page is replaced by Paystack or Flutterwave.</p>
<button type="button" class="qc-btn" id="qc-test-pay" data-order="${esc(order.id)}" data-token="${esc(order.token)}">Mark as paid in test mode</button>
<p class="qc-small" id="qc-test-msg" role="status"></p>
<p class="qc-small"><a href="/quote-check/report/${esc(order.token)}/">Back to the preview</a></p>
</div>
</section>`,
    scripts: `<script>
document.getElementById("qc-test-pay").addEventListener("click", function(){
  var b=this, m=document.getElementById("qc-test-msg");
  b.disabled=true; if(m) m.textContent="Releasing the report...";
  fetch("/api/quote-check/test-pay",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({order:b.getAttribute("data-order"),token:b.getAttribute("data-token")})})
    .then(function(r){return r.json().then(function(x){return {ok:r.ok,body:x}})})
    .then(function(r){ if(r.ok&&r.body.url){location.href=r.body.url;return} b.disabled=false; if(m) m.textContent=(r.body&&r.body.error)||"Could not release the report."; })
    .catch(function(){ b.disabled=false; if(m) m.textContent="Could not reach the server. Try again."; });
});
</script>`
  });
}
