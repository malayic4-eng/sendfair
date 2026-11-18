/* Quote Check settings. Shared by the build, the Worker and the tests. */

export const DEFAULT_CONFIG = {
  enabled: false,
  serviceName: "Quote Check",
  prices: { KES: 1500, NGN: 12000, GHS: 120, USD: 12, GBP: 9, EUR: 10 },
  defaultPriceCurrency: "USD",
  thresholds: { below: -0.15, above: 0.15, wellAbove: 0.35 },
  limits: { maxFiles: 5, maxFileMb: 15, maxTotalMb: 45, uploadsPerHour: 6, uploadsPerEmailPerDay: 3 },
  retentionDays: 30,
  quantityTolerance: 0.4,
  roofSheetM2: 2.7,
  steelBarKg: 10.65,
  lorryM3: { sand: 11, ballast: 12 },
  extraction: { provider: "openai", model: "", maxLines: 200 },
  payment: { provider: "test", testMode: false },
  ownerEmail: "hello@sendfair.africa",
  fromEmail: "hello@sendfair.africa",
  consentVersion: "2026-11-18",
  disclaimer:
    "This is an estimate for comparison, not a professional valuation or quantity survey. Prices vary by site, supplier and season. Always confirm a price with your own supplier and ask your builder about anything flagged here."
};

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const positive = (v, fallback) => (num(v, fallback) > 0 ? num(v, fallback) : fallback);

export function mergeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const base = DEFAULT_CONFIG;
  const thresholds = src.thresholds || {};
  const limits = src.limits || {};
  const prices = {};
  for (const [cur, amount] of Object.entries({ ...base.prices, ...(src.prices || {}) })) {
    const code = String(cur || "").toUpperCase();
    if (/^[A-Z]{3}$/.test(code) && Number(amount) > 0) prices[code] = Number(amount);
  }
  // When the merchant account only takes some currencies, only those fees are shown or charged.
  const payCurrencies = src.payment && Array.isArray(src.payment.currencies)
    ? src.payment.currencies.map((c) => String(c).toUpperCase()).filter((c) => prices[c] > 0)
    : [];
  if (payCurrencies.length) for (const cur of Object.keys(prices)) if (!payCurrencies.includes(cur)) delete prices[cur];
  return {
    ...base,
    ...src,
    enabled: src.enabled === true,
    serviceName: String(src.serviceName || base.serviceName),
    prices,
    defaultPriceCurrency: /^[A-Z]{3}$/.test(String(src.defaultPriceCurrency || "").toUpperCase())
      ? String(src.defaultPriceCurrency).toUpperCase()
      : base.defaultPriceCurrency,
    thresholds: {
      below: Math.min(-0.01, num(thresholds.below, base.thresholds.below)),
      above: Math.max(0.01, num(thresholds.above, base.thresholds.above)),
      wellAbove: Math.max(0.02, num(thresholds.wellAbove, base.thresholds.wellAbove))
    },
    limits: {
      maxFiles: Math.max(1, Math.min(10, Math.round(positive(limits.maxFiles, base.limits.maxFiles)))),
      maxFileMb: Math.max(1, Math.min(50, positive(limits.maxFileMb, base.limits.maxFileMb))),
      maxTotalMb: Math.max(1, Math.min(200, positive(limits.maxTotalMb, base.limits.maxTotalMb))),
      uploadsPerHour: Math.max(1, Math.round(positive(limits.uploadsPerHour, base.limits.uploadsPerHour))),
      uploadsPerEmailPerDay: Math.max(1, Math.round(positive(limits.uploadsPerEmailPerDay, base.limits.uploadsPerEmailPerDay)))
    },
    retentionDays: Math.max(1, Math.min(365, Math.round(positive(src.retentionDays, base.retentionDays)))),
    quantityTolerance: Math.max(0.05, Math.min(1, num(src.quantityTolerance, base.quantityTolerance))),
    roofSheetM2: positive(src.roofSheetM2, base.roofSheetM2),
    steelBarKg: positive(src.steelBarKg, base.steelBarKg),
    lorryM3: { ...base.lorryM3, ...(src.lorryM3 || {}) },
    extraction: { ...base.extraction, ...(src.extraction || {}) },
    payment: { ...base.payment, ...(src.payment || {}) },
    ownerEmail: String(src.ownerEmail || base.ownerEmail),
    fromEmail: String(src.fromEmail || base.fromEmail),
    consentVersion: String(src.consentVersion || base.consentVersion),
    disclaimer: String(src.disclaimer || base.disclaimer)
  };
}

/* The one-off fee for a quote currency. Countries outside the price list pay the default
   currency's fee, so a Ugandan quote is charged in USD rather than given an invented shilling price. */
export function priceFor(config, quoteCurrency) {
  const cur = String(quoteCurrency || "").toUpperCase();
  if (config.prices[cur] > 0) return { currency: cur, amount: config.prices[cur] };
  const fallback = config.defaultPriceCurrency;
  const amount = config.prices[fallback] > 0 ? config.prices[fallback] : DEFAULT_CONFIG.prices.USD;
  return { currency: config.prices[fallback] > 0 ? fallback : "USD", amount };
}

export function isEnabled(env, config) {
  const flag = env && env.QUOTE_CHECK_ENABLED;
  if (flag === "true" || flag === "1") return true;
  if (flag === "false" || flag === "0") return false;
  return !!(config && config.enabled);
}

export function isTestMode(env, config) {
  if (env && (env.QUOTE_CHECK_TEST_MODE === "true" || env.QUOTE_CHECK_TEST_MODE === "1")) return true;
  if (env && env.QUOTE_CHECK_TEST_MODE === "false") return false;
  return !!(config && config.payment && config.payment.testMode);
}

/* Money for reports and emails. Currency codes stay in front, so the PDF does not need
   a Naira or Cedi glyph that its built-in font cannot print. */
export function money(value, currency, digits) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  const d = digits == null ? (Math.abs(n) >= 1000 ? 0 : 2) : digits;
  return `${String(currency || "").toUpperCase()} ${n.toLocaleString("en", {
    minimumFractionDigits: d,
    maximumFractionDigits: d
  })}`;
}

export function pct(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

export function dateLong(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
