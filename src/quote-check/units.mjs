/* Unit names and the small set of conversions Quote Check is willing to make.
   Anything outside this list is "not checked", never guessed. */

const ALIASES = {
  bag: "bag", bags: "bag", sack: "bag", sacks: "bag", "50kg bag": "bag", "50 kg bag": "bag",
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  g: "g", gram: "g", grams: "g", gm: "g", gms: "g",
  tonne: "tonne", tonnes: "tonne", ton: "tonne", tons: "tonne", t: "tonne",
  m3: "m3", "m³": "m3", cbm: "m3", "cu m": "m3", "cubic metre": "m3", "cubic meter": "m3",
  "cubic metres": "m3", "cubic meters": "m3", "cum": "m3",
  m2: "m2", "m²": "m2", sqm: "m2", "sq m": "m2", "sqmtr": "m2", "square metre": "m2",
  "square meter": "m2", "square metres": "m2", "square meters": "m2",
  ft2: "ft2", "ft²": "ft2", sqft: "ft2", "sq ft": "ft2", "square foot": "ft2", "square feet": "ft2",
  m: "m", metre: "m", meter: "m", metres: "m", meters: "m", rm: "m", lm: "m",
  "running metre": "m", "running meter": "m", "running metres": "m", "linear metre": "m", "linear meter": "m",
  ft: "ft", foot: "ft", feet: "ft", "running foot": "ft",
  each: "each", unit: "each", units: "each", no: "each", nos: "each", number: "each",
  pc: "each", pcs: "each", piece: "each", pieces: "each", item: "each", items: "each",
  block: "each", blocks: "each", brick: "each", bricks: "each",
  litre: "litre", liter: "litre", litres: "litre", liters: "litre", l: "litre", ltr: "litre", ltrs: "litre",
  day: "day", days: "day", man_day: "day", "man day": "day", "man days": "day",
  point: "point", points: "point", "light point": "point", "socket point": "point",
  sheet: "sheet", sheets: "sheet",
  bar: "bar", bars: "bar", length: "bar", lengths: "bar",
  trip: "trip", trips: "trip", lorry: "trip", lorries: "trip", load: "trip", loads: "trip", "lorry load": "trip",
  roll: "roll", rolls: "roll",
  set: "set", sets: "set"
};

const PREFIXES = [
  [/^bags?\b/, "bag"], [/^sacks?\b/, "bag"], [/^blocks?\b/, "each"], [/^bricks?\b/, "each"],
  [/^sheets?\b/, "sheet"], [/^bars?\b/, "bar"], [/^lengths?\b/, "bar"], [/^days?\b/, "day"],
  [/^points?\b/, "point"], [/^pcs?\b/, "each"], [/^pieces?\b/, "each"], [/^units?\b/, "each"],
  [/^m3\b/, "m3"], [/^m2\b/, "m2"], [/^m\b/, "m"], [/^ft2\b/, "ft2"], [/^ft\b/, "ft"],
  [/^kgs?\b/, "kg"], [/^tonnes?\b/, "tonne"], [/^tons?\b/, "tonne"], [/^litres?\b/, "litre"],
  [/^lorr(y|ies)\b/, "trip"], [/^trips?\b/, "trip"], [/^loads?\b/, "trip"]
];

export function normaliseUnit(raw) {
  let s = String(raw == null ? "" : raw)
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  s = s.replace(/^per\s+/, "").replace(/\s+each$/, "");
  if (ALIASES[s]) return ALIASES[s];
  for (const [re, unit] of PREFIXES) if (re.test(s)) return unit;
  if (s.endsWith("s") && ALIASES[s.slice(0, -1)]) return ALIASES[s.slice(0, -1)];
  return s;
}

export function unitLabel(unit) {
  return {
    bag: "per bag", kg: "per kg", tonne: "per tonne", g: "per gram", m3: "per m³", m2: "per m²",
    ft2: "per ft²", m: "per m", ft: "per ft", each: "each", litre: "per litre", day: "per day",
    point: "per point", sheet: "per sheet", bar: "per bar", trip: "per trip", roll: "per roll", set: "per set"
  }[unit] || unit || "unit";
}

export function unitShort(unit) {
  return {
    bag: "bag", kg: "kg", tonne: "tonne", g: "g", m3: "m³", m2: "m²", ft2: "ft²", m: "m", ft: "ft",
    each: "each", litre: "litre", day: "day", point: "point", sheet: "sheet", bar: "bar", trip: "trip",
    roll: "roll", set: "set"
  }[unit] || unit || "unit";
}

const MASS = { kg: 1, tonne: 1000, g: 0.001 };
const LENGTH = { m: 1, ft: 0.3048 };
const AREA = { m2: 1, ft2: 0.09290304 };
const VOLUME = { m3: 1, litre: 0.001 };

/* Convert a quoted quantity into our catalogue unit. Returns null when the conversion
   is not one we can defend. The note goes into the report, so the reader sees the assumption. */
export function convertUnit(quantity, fromRaw, toRaw, context = {}) {
  const from = normaliseUnit(fromRaw);
  const to = normaliseUnit(toRaw);
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 0) return null;
  if (!from || !to) return null;
  if (from === to) return { qty, factor: 1, note: "" };

  if (MASS[from] && MASS[to]) {
    const factor = MASS[from] / MASS[to];
    return {
      qty: qty * factor,
      factor,
      note: from === "tonne" || to === "tonne" ? "A tonne is taken as 1,000 kg." : ""
    };
  }
  if (LENGTH[from] && LENGTH[to]) {
    const factor = LENGTH[from] / LENGTH[to];
    return { qty: qty * factor, factor, note: from === "ft" || to === "ft" ? "One foot is 0.3048 m." : "" };
  }
  if (AREA[from] && AREA[to]) {
    const factor = AREA[from] / AREA[to];
    return { qty: qty * factor, factor, note: from === "ft2" || to === "ft2" ? "One square foot is 0.0929 m²." : "" };
  }
  if (VOLUME[from] && VOLUME[to]) {
    const factor = VOLUME[from] / VOLUME[to];
    return { qty: qty * factor, factor, note: "One cubic metre is 1,000 litres." };
  }

  // Roofing sheets: the price data states that a 3 m sheet is about 2.7 m² of cover.
  if (from === "sheet" && to === "m2" && context.itemKey === "roof" && context.roofSheetM2 > 0) {
    return {
      qty: qty * context.roofSheetM2,
      factor: context.roofSheetM2,
      note: `One sheet is taken as ${context.roofSheetM2} m² of cover, the assumption in our roofing price.`
    };
  }
  if (from === "m2" && to === "sheet" && context.itemKey === "roof" && context.roofSheetM2 > 0) {
    return {
      qty: qty / context.roofSheetM2,
      factor: 1 / context.roofSheetM2,
      note: `One sheet is taken as ${context.roofSheetM2} m² of cover, the assumption in our roofing price.`
    };
  }

  // Steel bars: the price data uses a 12 mm x 12 m bar of about 10.65 kg.
  if (from === "bar" && to === "kg" && context.itemKey === "steel" && context.steelBarKg > 0) {
    return {
      qty: qty * context.steelBarKg,
      factor: context.steelBarKg,
      note: `One 12 mm x 12 m bar is taken as ${context.steelBarKg} kg, the assumption in our steel price.`
    };
  }
  if (from === "kg" && to === "bar" && context.itemKey === "steel" && context.steelBarKg > 0) {
    return {
      qty: qty / context.steelBarKg,
      factor: 1 / context.steelBarKg,
      note: `One 12 mm x 12 m bar is taken as ${context.steelBarKg} kg, the assumption in our steel price.`
    };
  }

  // A lorry load of sand or ballast: the volume is in the published source.
  if (from === "trip" && to === "m3" && context.lorryM3 && context.lorryM3[context.itemKey] > 0) {
    const m3 = context.lorryM3[context.itemKey];
    return { qty: qty * m3, factor: m3, note: `One load is taken as ${m3} m³, the volume in our source for this item.` };
  }
  if (from === "trip" && to === "each") return null;

  return null;
}

export function isCountUnit(unit) {
  return normaliseUnit(unit) === "each";
}
