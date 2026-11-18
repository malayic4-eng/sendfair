// GET /quote-check/report/<token>/       private HTML report (preview before payment)
// GET /quote-check/report/<token>/pdf    the emailed PDF, only after payment

import { loadSettings, testMode as isTestMode, paymentProviderId } from "./settings.js";
import { getOrderByToken, readPdf } from "./store.js";
import { renderReportPage } from "./report-page.mjs";
import { resolveCharge } from "./payments.js";

async function siteInfo(env, request) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL("/data/site.json", request.url)));
    if (!res.ok) return { ga4: "", assets: {} };
    const site = await res.json();
    return { ga4: site.ga4MeasurementId || "", assets: site.quoteCheckAssets || {} };
  } catch {
    return { ga4: "", assets: {} };
  }
}

export async function onRequestGet(context, token, wantPdf = false) {
  const { env, request } = context;
  const settings = await loadSettings(env, request).catch(() => null);
  if (!settings) return new Response("Quote Check is not available right now.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const order = await getOrderByToken(env, token);

  if (wantPdf) {
    if (!order) return new Response("Not found.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const paid = order.status === "paid" || order.status === "report sent";
    if (!paid || order.purged) return new Response("Payment is required for the PDF.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const pdf = await readPdf(env, order);
    if (!pdf) return new Response("The PDF is not available. Use the resend option or contact us.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return new Response(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="sendfair-quote-check-${order.countryId}-${order.id}.pdf"`,
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer"
      }
    });
  }

  const url = new URL(request.url);
  const site = await siteInfo(env, request);
  const waiting = url.searchParams.get("paid") === "1";
  const provider = order ? paymentProviderId(env, settings.config) : "";
  const charge = order ? resolveCharge(settings.config, order.quoteCurrency, provider) : null;
  const html = renderReportPage({ order, settings, testMode: isTestMode(env, settings.config), ga4: site.ga4, assets: site.assets, charge, provider, waiting });
  return new Response(html, {
    status: order ? 200 : 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer"
    }
  });
}
