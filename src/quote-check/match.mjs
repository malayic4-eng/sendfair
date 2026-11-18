/* Match a quote line to one item in the SendFair price catalogue.
   Conservative on purpose: a weak or ambiguous match is "not checked", not a guess. */

import { convertUnit, normaliseUnit, unitShort } from "./units.mjs";
import { chooseOption } from "./catalogue.mjs";

export function normaliseText(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text) {
  return normaliseText(text).split(" ").filter(Boolean);
}

function entryTokens(entry) {
  const set = new Set();
  for (const phrase of entry.phrases || []) {
    for (const w of phrase.split(" ")) if (w.length > 1) set.add(w);
  }
  for (const option of entry.options || []) for (const w of option.norm.split(" ")) if (w.length > 1) set.add(w);
  return set;
}

function phraseScore(desc, phrase) {
  if (!phrase) return 0;
  if (desc === phrase) return 0.98;
  const paddedDesc = ` ${desc} `;
  const padded = ` ${phrase} `;
  if (paddedDesc.includes(padded)) return 0.9 + Math.min(phrase.split(" ").length * 0.012, 0.07);
  if (phrase.includes(desc) && desc.length >= 3 && phrase.split(" ").length <= 4) return 0.72;
  return 0;
}

function excludedBy(description, synonyms) {
  const desc = ` ${normaliseText(description)} `;
  for (const phrase of (synonyms && synonyms.exclude) || []) {
    const p = normaliseText(phrase);
    if (p && desc.includes(` ${p} `)) return phrase;
  }
  return "";
}

function scoreEntry(desc, descWords, entry) {
  let best = 0;
  for (const phrase of entry.phrases || []) best = Math.max(best, phraseScore(desc, phrase));
  const eTokens = entryTokens(entry);
  let overlap = 0;
  for (const w of descWords) if (eTokens.has(w)) overlap++;
  const descCoverage = descWords.length ? overlap / descWords.length : 0;
  const entryCoverage = eTokens.size ? overlap / eTokens.size : 0;
  const keyToken = entry.key.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`).split(" ");
  const keyHit = keyToken.some((w) => w.length > 2 && descWords.includes(w)) ? 1 : 0;
  const tokenScore = Math.min(0.86, 0.55 * descCoverage + 0.35 * entryCoverage + 0.1 * keyHit);
  return Math.max(best, tokenScore);
}

function assumedQuantity(line, entry) {
  if (line.quantity != null && line.quantity > 0) return { qty: line.quantity, note: "" };
  if (entry.unit === "each") return { qty: 1, note: "The quote does not state a quantity; treated as one item." };
  return null;
}

export function matchLine(line, catalogue, synonyms, config = {}) {
  const description = String(line.description || "");
  const desc = normaliseText(description);
  const excluded = excludedBy(description, synonyms);
  if (excluded) {
    return {
      status: "excluded",
      checked: false,
      key: "",
      label: "",
      reason: `Not in our price data (${excluded}). It is listed here so the quote is complete, not checked.`
    };
  }

  if (!desc || !catalogue || !catalogue.entries || !catalogue.entries.length) {
    return { status: "unmatched", checked: false, key: "", label: "", reason: "No readable description to match." };
  }

  const descWords = words(description);
  const scored = catalogue.entries
    .map((entry) => ({ entry, score: scoreEntry(desc, descWords, entry) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < 0.5) {
    return {
      status: "unmatched",
      checked: false,
      key: "",
      label: "",
      score: best ? best.score : 0,
      reason: "We could not match this line to an item in our price data, so it is not checked."
    };
  }
  if (second && second.entry.key !== best.entry.key && best.score < 0.9 && best.score - second.score < 0.06) {
    return {
      status: "ambiguous",
      checked: false,
      key: best.entry.key,
      label: best.entry.label,
      score: best.score,
      reason: `This could be ${best.entry.label} or ${second.entry.label}. Ask for a clearer description; we did not guess.`
    };
  }

  const entry = best.entry;
  if (!entry.available) {
    return {
      status: "unavailable",
      checked: false,
      key: entry.key,
      label: entry.label,
      score: best.score,
      ourUnit: entry.unit,
      reason: entry.reason || `No ${catalogue.country ? catalogue.country.name : ""} price for this item in our data.`
    };
  }

  const option = chooseOption(entry, description) || { id: entry.optionId, name: entry.optionName, price: entry.price, quoted: entry.quoted, isGuide: entry.isGuide, source: entry.source, url: entry.url };
  if (!(option.price > 0)) {
    return {
      status: "unavailable",
      checked: false,
      key: entry.key,
      label: entry.label,
      reason: "Our data has no usable price for this item this month."
    };
  }

  const qty = assumedQuantity(line, entry);
  if (!qty) {
    return {
      status: "quantity_missing",
      checked: false,
      key: entry.key,
      label: entry.label,
      optionName: option.name,
      score: best.score,
      ourUnit: entry.unit,
      reason: `The quote does not state how much ${entry.label.toLowerCase()} it includes, so the price cannot be compared.`
    };
  }

  let quotedUnit = line.unit;
  if (!normaliseUnit(quotedUnit)) {
    if (entry.unit === "each") quotedUnit = "each";
    else {
      return {
        status: "unit_missing",
        checked: false,
        key: entry.key,
        label: entry.label,
        optionName: option.name,
        score: best.score,
        ourUnit: entry.unit,
        reason: `The quote does not state a unit. Our ${entry.label.toLowerCase()} price is ${entry.unit === "each" ? "for one item" : `per ${unitShort(entry.unit)}`}.`
      };
    }
  }

  const conversion = convertUnit(qty.qty, quotedUnit, entry.unit, {
    itemKey: entry.key,
    roofSheetM2: config.roofSheetM2,
    steelBarKg: config.steelBarKg,
    lorryM3: config.lorryM3
  });
  if (!conversion) {
    return {
      status: "unit_mismatch",
      checked: false,
      key: entry.key,
      label: entry.label,
      optionName: option.name,
      score: best.score,
      ourUnit: entry.unit,
      reason: `Our price is ${entry.unit === "each" ? "for one item" : `per ${unitShort(entry.unit)}`}, and the quote uses "${line.unit || "no unit"}". We do not convert that, so this line is not checked.`
    };
  }

  const notes = [qty.note, conversion.note].filter(Boolean).join(" ");
  return {
    status: "matched",
    checked: true,
    key: entry.key,
    label: entry.label,
    optionId: option.id,
    optionName: option.name,
    score: best.score,
    ourUnit: entry.unit,
    ourUnitName: entry.unitName,
    ourPrice: Number(option.price),
    quoted: !!option.quoted,
    isGuide: !!option.isGuide,
    source: option.source || entry.source,
    url: option.url || entry.url,
    checkedDate: entry.checked,
    conversion: {
      qty: conversion.qty,
      factor: conversion.factor,
      fromUnit: normaliseUnit(quotedUnit),
      toUnit: entry.unit,
      note: notes
    },
    reason: ""
  };
}

export function matchLines(lines, catalogue, synonyms, config) {
  return (lines || []).map((line) => ({ line, match: matchLine(line, catalogue, synonyms, config) }));
}
