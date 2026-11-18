/* Turn a validated extraction into the report: matched lines, comparison totals,
   a verdict band, quantity questions and the list of things we did not check. */

import SFBuild from "../build-cost.js";
import { buildCatalogue } from "./catalogue.mjs";
import { matchLine } from "./match.mjs";
import { expectedQuantities, checkQuantity } from "./quantity.mjs";
import { bandFor, coverageNote } from "./verdict.mjs";
import { money, pct, dateLong } from "./config.mjs";

function fxRate(midmarket, from, to) {
  if (from === to) return 1;
  const rates = (midmarket && midmarket.rates) || {};
  const a = Number(rates[from]);
  const b = Number(rates[to]);
  if (!(a > 0) || !(b > 0)) return null;
  return b / a;
}

function clip(text, max) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function lineFlagKey(flag) {
  return flag && flag.key ? flag.key : "within";
}

export function analyseQuote(input) {
  const {
    extraction, validation, data, countryId, town, bedrooms, storeys, m2,
    quoteCurrency, midmarket, synonyms, config, now
  } = input;

  const country = data && data.countries && data.countries[countryId];
  if (!country) return { ok: false, error: "Unknown country." };
  const rates = (midmarket && midmarket.rates) || {};
  const countryCurrency = country.currency;
  const qCur = String(quoteCurrency || extraction.currency || countryCurrency).toUpperCase();

  let estimate = null;
  try {
    estimate = SFBuild.estimate(data, countryId, Number(m2), storeys >= 2 ? 2 : 1, rates);
  } catch {
    estimate = null;
  }
  if (!estimate) return { ok: false, error: "Could not build the comparison estimate for that house size." };

  const permitLines = estimate.lines.filter((l) => l.group === "Permits" && l.cost > 0);
  const permitTotal = permitLines.length
    ? {
        amount: permitLines.reduce((s, l) => s + l.cost, 0),
        source: permitLines.map((l) => `${l.label}: ${l.source}`).join(" "),
        url: permitLines.find((l) => l.url)?.url || ""
      }
    : null;

  const catalogue = buildCatalogue({ data, countryId, rates, synonyms, permitTotal });
  const expected = expectedQuantities(data, countryId, m2, storeys);

  const factor = fxRate(midmarket, qCur, countryCurrency);
  const fx = {
    from: qCur,
    to: countryCurrency,
    rate: factor,
    date: (midmarket && midmarket.updatedAt) || "",
    note: qCur === countryCurrency
      ? ""
      : factor
        ? `Quoted in ${qCur}; changed into ${countryCurrency} at the mid-market rate of ${factor.toLocaleString("en", { maximumFractionDigits: 4 })} on ${dateLong((midmarket && midmarket.updatedAt) || now)}.`
        : `We cannot convert ${qCur} into ${countryCurrency} today, so the lines are not compared.`
  };

  const lines = [];
  const quantityChecks = [];
  let checkedLines = 0;
  let matchedValue = 0;
  let estimateMatched = 0;

  for (const line of extraction.lineItems) {
    const match = matchLine(line, catalogue, synonyms, config);
    const unitPriceLocal = factor && line.unitPrice != null ? line.unitPrice * factor : null;
    const lineTotalLocal = factor && line.lineTotal != null ? line.lineTotal * factor : null;
    const effectiveLocal = factor && line.effectiveTotal != null ? line.effectiveTotal * factor : null;

    let quotedForCompare = null;
    let ourCost = null;
    let diff = null;
    let diffPct = null;
    let flag = null;
    let quantityCheck = null;
    let note = "";

    if (match.checked && factor && match.conversion) {
      const convertedQty = Number(match.conversion.qty);
      if (line.arithmeticOk && line.lineTotal != null) quotedForCompare = line.lineTotal * factor;
      else if (line.quantity != null && line.unitPrice != null) quotedForCompare = line.quantity * line.unitPrice * factor;
      else if (line.lineTotal != null) quotedForCompare = line.lineTotal * factor;

      if (quotedForCompare != null && convertedQty > 0 && match.ourPrice > 0) {
        ourCost = convertedQty * match.ourPrice;
        diff = quotedForCompare - ourCost;
        diffPct = ourCost > 0 ? diff / ourCost : null;
        flag = bandFor(diffPct, config.thresholds);
        checkedLines++;
        matchedValue += quotedForCompare;
        estimateMatched += ourCost;
        quantityCheck = checkQuantity(line, match, {
          expected,
          m2: Number(m2),
          tolerance: config.quantityTolerance
        });
        if (quantityCheck) quantityChecks.push(quantityCheck);
      } else {
        note = "The line has no usable amount to compare.";
      }
    }

    const convertedQty = match.conversion ? Number(match.conversion.qty) : null;
    const quotedUnitLocal = quotedForCompare != null && convertedQty > 0 ? quotedForCompare / convertedQty : null;

    lines.push({
      index: line.index,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      currency: qCur,
      unitPriceLocal,
      lineTotalLocal,
      effectiveLocal,
      arithmetic: {
        ok: line.arithmeticOk,
        expectedTotal: line.expectedTotal,
        message: line.arithmeticOk ? "" : (validation.arithmetic.lineErrors.find((e) => e.index === line.index) || {}).message || "The line total does not match quantity x unit price."
      },
      match,
      checked: !!(match.checked && ourCost != null),
      convertedQty,
      quotedForCompare,
      quotedUnitLocal,
      ourCost,
      ourPrice: match.ourPrice || null,
      diff,
      diffPct,
      flag: flag || { key: "not_checked", label: "Not checked", note: "" },
      quantityCheck,
      note
    });
  }

  const totalLines = lines.length;
  const quoteTotalLocal = factor && extraction.quoteTotal != null ? extraction.quoteTotal * factor : null;
  const unmatchedValue = quoteTotalLocal != null ? Math.max(0, quoteTotalLocal - matchedValue) : null;
  const difference = checkedLines ? matchedValue - estimateMatched : null;
  const differencePct = estimateMatched > 0 && difference != null ? difference / estimateMatched : null;
  const band = checkedLines ? bandFor(differencePct, config.thresholds) : bandFor(null, config.thresholds);
  const lineCoverage = totalLines ? checkedLines / totalLines : 0;
  const valueCoverage = quoteTotalLocal > 0 ? Math.min(1, matchedValue / quoteTotalLocal) : 0;

  const questions = [];
  const seen = new Set();
  const ask = (q) => {
    const text = String(q || "").trim();
    if (!text || seen.has(text) || questions.length >= 12) return;
    seen.add(text);
    questions.push(text);
  };

  for (const e of validation.arithmetic.lineErrors.filter((x) => x.kind === "arithmetic")) {
    ask(`The line "${clip(e.description, 70)}" says ${e.quantity} x ${e.unitPrice} = ${e.writtenTotal}, which does not add up. Ask for a corrected quote.`);
  }
  if (validation.arithmetic.totalError) {
    const t = validation.arithmetic.totalError;
    ask(`The lines add up to ${money(t.sumLines, qCur)} but the quote total says ${money(t.writtenTotal, qCur)}. Ask which figure is correct.`);
  }

  for (const l of lines) {
    if (!l.match || l.match.status === "excluded") continue;
    if (l.checked && (l.flag.key === "above" || l.flag.key === "well_above")) {
      const our = money(l.ourPrice, countryCurrency, l.ourPrice >= 1000 ? 0 : 2);
      const q = money(l.quotedUnitLocal != null ? l.quotedUnitLocal : l.unitPriceLocal, countryCurrency, l.ourPrice >= 1000 ? 0 : 2);
      ask(`Ask your builder why "${clip(l.description, 60)}" is priced at ${q} ${l.match.ourUnitName || ""} against our typical ${our} ${l.match.ourUnitName || ""} (${pct(l.diffPct)}).`);
    } else if (l.checked && l.flag.key === "below") {
      ask(`Ask your builder what is included in "${clip(l.description, 60)}": it is ${pct(l.diffPct)} below our typical price. Check the material quality and what the line leaves out.`);
    } else if (l.match && l.match.status === "unit_mismatch") {
      ask(`Ask for "${clip(l.description, 60)}" in ${l.match.ourUnit === "each" ? "pieces" : l.match.ourUnit} so it can be checked against our price.`);
    } else if (l.match && l.match.status === "unavailable") {
      ask(`Ask your builder to itemise "${clip(l.description, 60)}" separately. We have no local price for it in this check, so it is not in the comparison.`);
    } else if (l.match && (l.match.status === "unmatched" || l.match.status === "ambiguous")) {
      ask(`Ask your builder to itemise "${clip(l.description, 60)}". We could not match it to our price data, so it is not checked.`);
    }
  }

  for (const q of quantityChecks) ask(q.message);

  if (!questions.length) {
    ask("Ask your builder for a written breakdown with quantities, units and unit prices for every line, so each one can be checked.");
  }

  const checkedDate = data.updated || "";
  const result = {
    ok: true,
    version: 1,
    generatedAt: now || new Date().toISOString(),
    country: { id: countryId, name: country.name, currency: countryCurrency, city: country.city || "" },
    inputs: {
      town: String(town || ""),
      bedrooms: Number(bedrooms) || null,
      storeys: storeys >= 2 ? 2 : 1,
      m2: Number(m2) || null,
      quoteCurrency: qCur,
      houseType: storeys >= 2 ? "maisonette, two floors" : "bungalow, one floor"
    },
    checkedDate,
    checkedDateLabel: dateLong(checkedDate),
    fx,
    quote: {
      currency: qCur,
      total: extraction.quoteTotal,
      totalLocal: quoteTotalLocal,
      lineCount: totalLines,
      totalSource: extraction.totalSource,
      totalProvided: extraction.quoteTotalProvided
    },
    lines,
    unmatched: lines.filter((l) => !l.checked),
    quantityChecks,
    arithmetic: validation.arithmetic,
    summary: {
      totalLines,
      checkedLines,
      matchedLines: checkedLines,
      matchedQuoteValue: matchedValue,
      estimateMatched,
      difference,
      differencePct,
      band,
      coverage: { lines: lineCoverage, value: valueCoverage },
      coverageNote: coverageNote(lineCoverage, valueCoverage),
      quoteTotalLocal,
      unmatchedValue,
      quantityIssues: quantityChecks.length,
      guideLines: lines.filter((l) => l.checked && l.match && l.match.isGuide).length,
      arithmeticIssues: validation.arithmetic.lineErrors.filter((e) => e.kind === "arithmetic").length + (validation.arithmetic.totalError ? 1 : 0)
    },
    questions,
    disclaimer: config.disclaimer,
    notCheckedNote: "Lines under 'Not checked' are not in the comparison. They may be perfectly fair; we simply have no matching local price, or the unit could not be converted safely."
  };
  return { ok: true, report: result };
}

export { fxRate };
