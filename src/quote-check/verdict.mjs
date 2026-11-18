/* Verdict bands. The thresholds live in config/quote-check.json:
   default -15% / +15% / +35%. */

export const BAND_LABELS = {
  below: "Below typical",
  within: "Within typical range",
  above: "Above typical",
  well_above: "Well above typical",
  not_checked: "Not enough checked"
};

export const BAND_NOTES = {
  below: "The matched items are priced below our typical local prices. Check what is included and the quality of the materials before you pay.",
  within: "The matched items are close to our typical local prices. That is a fair range, not a guarantee.",
  above: "The matched items are above our typical local prices. Ask about the lines flagged below before you agree.",
  well_above: "The matched items are well above our typical local prices. Ask for a line-by-line breakdown before you pay anything.",
  not_checked: "We could not match enough of this quote to give a verdict. Ask your builder for an itemised quote with quantities and units."
};

export function bandFor(diffPct, thresholds = {}) {
  const below = Number.isFinite(thresholds.below) ? thresholds.below : -0.15;
  const above = Number.isFinite(thresholds.above) ? thresholds.above : 0.15;
  const wellAbove = Number.isFinite(thresholds.wellAbove) ? thresholds.wellAbove : 0.35;
  if (diffPct == null || diffPct === "") return { key: "not_checked", label: BAND_LABELS.not_checked, note: BAND_NOTES.not_checked };
  const p = Number(diffPct);
  if (!Number.isFinite(p)) return { key: "not_checked", label: BAND_LABELS.not_checked, note: BAND_NOTES.not_checked };
  let key;
  if (p < below) key = "below";
  else if (p <= above) key = "within";
  else if (p <= wellAbove) key = "above";
  else key = "well_above";
  return { key, label: BAND_LABELS[key], note: BAND_NOTES[key] };
}

export function coverageNote(lineCoverage, valueCoverage) {
  const line = Math.max(0, Math.min(1, Number(lineCoverage) || 0));
  const value = Math.max(0, Math.min(1, Number(valueCoverage) || 0));
  if (line === 0) return "None of the lines could be matched to our prices, so there is no verdict.";
  if (value < 0.4) {
    return `Only ${Math.round(value * 100)}% of the quote value could be matched to our prices. Treat the verdict as a partial view of the quote, not a verdict on the whole job.`;
  }
  return `${Math.round(line * 100)}% of the lines, covering ${Math.round(value * 100)}% of the quote value, were matched to our prices.`;
}
