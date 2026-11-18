/* Shared HTML for the private Quote Check pages served by the Worker. */

export function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function shell({ title, description, body, scripts = "", ga4 = "", bodyClass = "", assets = {} }) {
  const v = (value) => (value ? `?v=${esc(value)}` : "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#ffffff">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-48.png" sizes="48x48" type="image/png">
<link rel="stylesheet" href="/assets/fonts.css${v(assets.fonts)}">
<link rel="stylesheet" href="/assets/style.css${v(assets.siteCss)}">
<link rel="stylesheet" href="/assets/quote-check.css${v(assets.qccss)}">
</head>
<body class="qc-body ${esc(bodyClass)}">
<a class="skip" href="#content">Skip to content</a>
<header class="qc-top"><div class="wrap qc-top-in">
<a class="qc-brand" href="/"><span class="qc-mark" aria-hidden="true">S</span><span>SendFair</span></a>
<span class="qc-top-label">Quote Check</span>
</div></header>
<main id="content" tabindex="-1">${body}</main>
<footer class="qc-foot"><div class="wrap">
<p><strong>SendFair</strong> · Independent, run from Nairobi. <a href="/quote-check/">Quote Check</a> · <a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · <a href="/contact/">Contact</a></p>
<p class="qc-foot-note">Quote Check is a comparison of a builder's quote against SendFair's published local prices. It is not a professional valuation, quantity survey or structural design. Prices vary by site, supplier and season.</p>
</div></footer>
<script>window.SF=window.SF||{};window.SF.config=Object.assign({},window.SF.config,{ga4:"${esc(ga4)}"});window.SF.root="/";</script>
<script src="/assets/app.js${v(assets.app)}" defer></script>
${scripts.replace(/\/assets\/quote-check-report\.js/g, `/assets/quote-check-report.js${v(assets.report)}`)}
</body>
</html>`;
}
