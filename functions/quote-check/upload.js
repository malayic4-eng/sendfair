// POST /api/quote-check/upload  multipart/form-data
// Accepts up to 5 files (PDF, JPG/PNG, XLSX, CSV), stores them privately, extracts the quote,
// validates the arithmetic and returns the free preview counts. No line-level result is returned
// until the order is paid.

import { json } from "../_lib.js";
import { loadSettings, enabled, testMode } from "./settings.js";
import { validateUploads } from "./files.js";
import { createOrder, loadPricingData } from "./orders.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function fail(message, status = 400, extra = {}) {
  return json({ error: message, ...extra }, status);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const settings = await loadSettings(env, request).catch(() => null);
  if (!settings) return fail("Quote Check is not available right now.", 503);
  const { config } = settings;
  if (!enabled(env, config)) {
    return fail("Quote Check is not open yet. Email hello@sendfair.africa and we will tell you when it opens.", 503, { code: "disabled" });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return fail("Send the quote as a form with the files attached.", 400);
  }

  const countryId = String(form.get("country") || "").trim().toLowerCase();
  const town = String(form.get("town") || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const bedrooms = Math.round(Number(form.get("bedrooms")));
  const storeys = Number(form.get("storeys")) === 2 ? 2 : 1;
  const m2 = Number(form.get("m2"));
  const email = String(form.get("email") || "").trim().toLowerCase();
  const consent = String(form.get("consent") || "").toLowerCase();
  let quoteCurrency = String(form.get("quoteCurrency") || "").trim().toUpperCase();

  let data;
  try { data = await loadPricingData(env, request); } catch { return fail("Site data is unavailable. Try again shortly.", 503); }
  const country = data.data.countries && data.data.countries[countryId];
  if (!country) return fail("Choose the country the house is in.", 400);
  if (!quoteCurrency) quoteCurrency = country.currency;
  if (!/^[A-Z]{3}$/.test(quoteCurrency)) return fail("Choose the currency the quote is written in.", 400);
  if (!EMAIL.test(email) || email.length > 200) return fail("Enter a valid email address.", 400);
  if (!(bedrooms >= 1 && bedrooms <= 10)) return fail("Choose the number of bedrooms.", 400);
  if (!(m2 >= 20 && m2 <= 1000)) return fail("Enter an approximate floor area between 20 and 1,000 m².", 400);
  if (!["on", "true", "1", "yes"].includes(consent)) {
    return fail("Tick the consent box so we can process the quote.", 400);
  }

  const files = form.getAll("files");
  const checked = await validateUploads(files, config);
  if (!checked.ok) return fail(checked.errors[0] || "Check the attached files.", checked.errors.some((e) => /larger than/.test(e)) ? 413 : 415, { details: checked.errors });

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  try {
    const result = await createOrder({
      env,
      request,
      settings,
      fields: { countryId, town, bedrooms, storeys, m2, quoteCurrency, email },
      files: checked.files,
      ip
    });
    return json({
      ok: true,
      order: {
        id: result.order.id,
        token: result.order.token,
        status: result.order.status,
        reportPath: `/quote-check/report/${result.order.token}/`
      },
      preview: result.preview,
      testMode: testMode(env, config)
    });
  } catch (err) {
    const code = err && err.code;
    if (code === "rate_limit") return fail(err.message, 429, { code });
    if (code === "storage" || code === "storage_too_large") return fail(err.message, 503, { code });
    if (code === "llm_not_configured") return fail("Quote Check is not switched on yet. Please try again later.", 503, { code });
    if (code === "extraction_invalid") return fail(err.message, 422, { code, details: (err.details || []).slice(0, 4) });
    if (code === "llm_failed" || code === "fixture_missing") return fail(err.message, 422, { code });
    if (code === "country") return fail(err.message, 400, { code });
    console.log("quote-check upload failed", code || (err && err.message));
    return fail("We could not read that quote. Try a clearer photo or a PDF, or email hello@sendfair.africa.", 500, { code: "upload_failed" });
  }
}

export function onRequest() {
  return json({ error: "Use POST." }, 405, { allow: "POST" });
}
