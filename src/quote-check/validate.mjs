/* Validate what the extraction model returned. The model proposes; this code decides.
   It recomputes every line and the quote total, and it keeps arithmetic errors as findings
   about the quote rather than throwing the quote away. */

export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["currency", "quote_total", "line_items", "notes"],
  properties: {
    currency: { type: "string", description: "ISO 4217 code, for example KES or NGN." },
    quote_total: { type: ["number", "null"], description: "The total written on the quote, or null if none is written." },
    notes: { type: "string", description: "Anything unclear, such as a missing page or an unreadable figure." },
    line_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "quantity", "unit", "unit_price", "line_total", "currency"],
        properties: {
          description: { type: "string" },
          quantity: { type: ["number", "null"] },
          unit: { type: ["string", "null"] },
          unit_price: { type: ["number", "null"] },
          line_total: { type: ["number", "null"] },
          currency: { type: ["string", "null"] }
        }
      }
    }
  }
};

function numberOrNull(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[,\s]/g, "").replace(/^[^\d.-]+/, "").replace(/[^\d.-]+$/, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function cleanText(value, max) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function currencyCode(value) {
  const s = String(value == null ? "" : value).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : "";
}

export function validateExtraction(raw, options = {}) {
  const errors = [];
  const warnings = [];
  const maxLines = Math.max(1, Math.min(500, Number(options.maxLines) || 200));
  const fallbackCurrency = currencyCode(options.currency);

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["The extraction did not return a JSON object."], warnings, extraction: null, arithmetic: null };
  }

  const topCurrency = currencyCode(raw.currency) || fallbackCurrency;
  if (!topCurrency) errors.push("The quote currency is missing. Ask for the currency written on the quote.");

  const rawLines = Array.isArray(raw.line_items)
    ? raw.line_items
    : Array.isArray(raw.items)
      ? raw.items
      : Array.isArray(raw.lineItems)
        ? raw.lineItems
        : null;
  if (!rawLines) errors.push("The extraction has no line_items array.");
  if (rawLines && rawLines.length === 0) errors.push("No line items were found. Check that the file is readable and shows the quote table.");
  if (rawLines && rawLines.length > maxLines) errors.push(`The quote has more than ${maxLines} lines. Split it and try again.`);

  const lines = [];
  const lineErrors = [];
  let sumQuoted = 0;
  let sumEffective = 0;

  (rawLines || []).slice(0, maxLines).forEach((item, index) => {
    const row = index + 1;
    const lineCurrency = currencyCode(item && item.currency) || topCurrency;
    const description = cleanText(item && item.description, 300);
    if (!description) {
      errors.push(`Line ${row}: the description is empty.`);
      return;
    }
    if (item && item.currency && lineCurrency && topCurrency && lineCurrency !== topCurrency) {
      warnings.push(`Line ${row} says ${lineCurrency} but the quote says ${topCurrency}. It was read as ${topCurrency}.`);
    }

    let quantity = numberOrNull(item && item.quantity);
    let unitPrice = numberOrNull(item && (item.unit_price != null ? item.unit_price : item.unitPrice));
    let lineTotal = numberOrNull(item && (item.line_total != null ? item.line_total : item.lineTotal));
    const unit = cleanText(item && item.unit, 40);
    let derivedTotal = false;
    let derivedPrice = false;

    if (quantity != null && quantity <= 0) {
      lineErrors.push({ index, description, kind: "quantity", message: "The quantity is zero or negative." });
      quantity = null;
    }
    if (unitPrice != null && unitPrice < 0) {
      lineErrors.push({ index, description, kind: "price", message: "The unit price is negative." });
      unitPrice = null;
    }
    if (lineTotal != null && lineTotal < 0) {
      lineErrors.push({ index, description, kind: "total", message: "The line total is negative." });
      lineTotal = null;
    }

    if (quantity != null && unitPrice != null && lineTotal == null) {
      lineTotal = quantity * unitPrice;
      derivedTotal = true;
    }
    if (quantity != null && lineTotal != null && unitPrice == null) {
      unitPrice = lineTotal / quantity;
      derivedPrice = true;
    }

    if (quantity == null && lineTotal == null) {
      errors.push(`Line ${row} ("${description}") has no quantity and no amount. Ask for a clearer copy.`);
      return;
    }
    if (unitPrice == null && lineTotal == null) {
      errors.push(`Line ${row} ("${description}") has no unit price and no line total.`);
      return;
    }

    let expectedTotal = null;
    let arithmeticOk = true;
    if (quantity != null && unitPrice != null && lineTotal != null && !derivedTotal && !derivedPrice) {
      expectedTotal = quantity * unitPrice;
      const tolerance = Math.max(0.5, Math.abs(expectedTotal) * 0.005);
      arithmeticOk = Math.abs(lineTotal - expectedTotal) <= tolerance;
      if (!arithmeticOk) {
        lineErrors.push({
          index,
          description,
          kind: "arithmetic",
          quantity,
          unitPrice,
          writtenTotal: lineTotal,
          expectedTotal,
          difference: lineTotal - expectedTotal,
          message: `${quantity} x ${unitPrice} should be ${expectedTotal.toFixed(2)}, but the quote writes ${lineTotal.toFixed(2)}.`
        });
      }
    }

    const effectiveTotal = arithmeticOk
      ? (lineTotal != null ? lineTotal : quantity * unitPrice)
      : (expectedTotal != null ? expectedTotal : lineTotal);

    if (effectiveTotal != null) sumEffective += effectiveTotal;
    if (lineTotal != null) sumQuoted += lineTotal;

    lines.push({
      index,
      description,
      quantity,
      unit,
      unitPrice,
      lineTotal,
      effectiveTotal,
      currency: topCurrency,
      originalCurrency: lineCurrency,
      derivedTotal,
      derivedPrice,
      expectedTotal,
      arithmeticOk,
      unpriced: quantity == null && lineTotal == null
    });
  });

  if (!lines.length && !errors.length) errors.push("No usable line items were found.");

  const providedTotal = numberOrNull(raw.quote_total != null ? raw.quote_total : raw.quoteTotal);
  let quoteTotal = providedTotal;
  let totalSource = "quote";
  if (quoteTotal == null || quoteTotal <= 0) {
    quoteTotal = sumEffective;
    totalSource = "lines";
    if (providedTotal != null && providedTotal <= 0) warnings.push("The quote total is zero or negative, so the lines were added up instead.");
  }

  let totalError = null;
  if (providedTotal != null && providedTotal > 0 && sumEffective > 0) {
    const tolerance = Math.max(1, Math.abs(sumEffective) * 0.005);
    if (Math.abs(providedTotal - sumEffective) > tolerance) {
      totalError = {
        writtenTotal: providedTotal,
        sumLines: sumEffective,
        difference: providedTotal - sumEffective,
        message: `The lines add up to ${sumEffective.toFixed(2)}, but the quote total says ${providedTotal.toFixed(2)}.`
      };
    }
  }

  const notes = cleanText(raw.notes, 1000);
  const ok = errors.length === 0;

  return {
    ok,
    errors,
    warnings,
    extraction: ok
      ? {
          currency: topCurrency,
          quoteTotal,
          quoteTotalProvided: providedTotal,
          totalSource,
          notes,
          lineItems: lines
        }
      : null,
    arithmetic: {
      lineErrors,
      totalError,
      sumQuoted,
      sumEffective,
      quoteTotal,
      quoteTotalProvided: providedTotal,
      hasErrors: lineErrors.length > 0 || !!totalError
    }
  };
}
