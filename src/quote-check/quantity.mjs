/* Quantity sanity checks. These use the same planning take-off as the house calculator
   and ask a question; they never call the builder dishonest. */

import SFBuild from "../build-cost.js";
import { unitShort } from "./units.mjs";

const FIELDS = {
  cement: ["cementBags", "bag"],
  steel: ["steelKg", "kg"],
  ballast: ["ballastM3", "m3"],
  sand: ["sandM3", "m3"],
  blocks: ["blocks", "each"],
  roof: ["roofM2", "m2"],
  timber: ["timberM2", "m2"],
  gutter: ["gutterM", "m"],
  windows: ["windows", "each"],
  doorIn: ["doorsIn", "each"],
  doorOut: ["doorsOut", "each"],
  tiles: ["tilesM2", "m2"],
  ceiling: ["ceilingM2", "m2"],
  ceilingFrame: ["ceilingM2", "m2"],
  paint: ["paintL", "litre"],
  kitchen: ["kitchenM", "m"],
  wardrobe: ["wardrobeM", "m"],
  elecPoint: ["elecPoints", "point"],
  pipe: ["pipeM", "m"],
  wc: ["wc", "each"],
  basin: ["wc", "each"],
  shower: ["wc", "each"],
  sink: ["sink", "each"],
  tank: ["tank", "each"],
  septic: ["septic", "each"],
  boundary: ["wallM", "m"],
  gate: ["gate", "each"],
  formwork: ["formworkM2", "m2"],
  mason: ["masonDays", "day"],
  hand: ["handDays", "day"],
  carpenter: ["carpenterDays", "day"],
  painter: ["painterDays", "day"],
  spark: ["sparkDays", "day"],
  plumber: ["plumbDays", "day"]
};

export function expectedQuantities(data, countryId, m2, storeys) {
  const country = data && data.countries && data.countries[countryId];
  if (!country || !(m2 > 0)) return null;
  try {
    const q = SFBuild.quantities(data, Number(m2), storeys >= 2 ? 2 : 1, country.roof);
    return { ...q, sink: 1, gate: 1, septic: 1, tank: 1 };
  } catch {
    return null;
  }
}

function expectedFor(key, expected, description) {
  if (!expected) return null;
  if (key === "tiles" && /\bwall\b/.test(String(description || "").toLowerCase())) {
    return { qty: expected.wallTilesM2, unit: "m2" };
  }
  const spec = FIELDS[key];
  if (!spec) return null;
  const qty = expected[spec[0]];
  if (!(qty > 0)) return null;
  return { qty, unit: spec[1] };
}

function moneyQty(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "–";
  return v >= 100 ? Math.round(v).toLocaleString("en") : Math.round(v * 10) / 10 + "";
}

/* Returns null when there is nothing to say, or an object describing the question. */
export function checkQuantity(line, match, options = {}) {
  if (!match || !match.checked || match.status !== "matched" || !match.conversion) return null;
  if (match.key === "permitTotal") return null;
  const expected = options.expected;
  if (!expected) return null;
  const target = expectedFor(match.key, expected, line.description);
  if (!target || !(target.qty > 0)) return null;
  const quoteQty = Number(match.conversion.qty);
  if (!(quoteQty > 0)) return null;

  const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : 0.4;
  const absMin = target.qty < 10 ? 1 : 0;
  const allowed = Math.max(target.qty * tolerance, absMin);
  const diff = quoteQty - target.qty;
  if (Math.abs(diff) <= allowed) return null;

  const high = diff > 0;
  const area = options.m2 > 0 ? `${Math.round(options.m2)} m²` : "the stated floor area";
  const unit = unitShort(target.unit);
  const ratio = quoteQty / target.qty;
  return {
    key: match.key,
    label: match.label,
    quoteQty,
    expectedQty: target.qty,
    unit,
    ratio,
    direction: high ? "high" : "low",
    message: `The quote lists ${moneyQty(quoteQty)} ${unit} of ${match.label.toLowerCase()} for about ${area}. Our planning take-off for a house this size is about ${moneyQty(target.qty)} ${unit} (${high ? "the quote is higher" : "the quote is lower"}). Ask your builder whether the difference is a different scope, a different mix, or a mistake.`
  };
}

export function quantityQuestions(checks) {
  return (checks || []).filter(Boolean).map((c) => c.message);
}
