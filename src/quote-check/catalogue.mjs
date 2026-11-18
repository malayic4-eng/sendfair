/* Build the quote-check catalogue from the same house-build price data behind
   /cost-to-build/<country>/. One entry per priced item, with its unit and checked date.
   Cross-country "guide from" prices are listed but marked unavailable: a Nigerian timber
   price scaled from Kenya is not a Nigerian price, so it is never used for a verdict. */

import SFBuild from "../build-cost.js";

export const ITEM_UNITS = {
  cement: { unit: "bag", label: "Cement" },
  steel: { unit: "kg", label: "Steel" },
  roof: { unit: "m2", label: "Roofing" },
  sand: { unit: "m3", label: "Sand" },
  mason: { unit: "day", label: "Masons" },
  hand: { unit: "day", label: "Labourers" },
  blocks: { unit: "each", label: "Blocks" },
  ballast: { unit: "m3", label: "Ballast" },
  timber: { unit: "m2", label: "Roof timber" },
  window: { unit: "each", label: "Windows" },
  doorIn: { unit: "each", label: "Internal doors" },
  doorOut: { unit: "each", label: "External doors" },
  tiles: { unit: "m2", label: "Floor tiles" },
  ceiling: { unit: "m2", label: "Ceiling boards" },
  paint: { unit: "litre", label: "Paint" },
  elecPoint: { unit: "point", label: "Wiring" },
  pipe: { unit: "m", label: "Plumbing pipe" },
  wc: { unit: "each", label: "WCs" },
  tank: { unit: "each", label: "Water tank" },
  painter: { unit: "day", label: "Painter" },
  spark: { unit: "day", label: "Electrician" },
  plumber: { unit: "day", label: "Plumber" },
  carpenter: { unit: "day", label: "Carpenter" },
  ceilingFrame: { unit: "m2", label: "Ceiling frame" },
  gutter: { unit: "m", label: "Gutters and downpipes" },
  formwork: { unit: "m2", label: "Slab formwork" },
  basin: { unit: "each", label: "Wash basins" },
  shower: { unit: "each", label: "Showers" },
  sink: { unit: "each", label: "Kitchen sink" },
  septic: { unit: "each", label: "Septic tank" },
  kitchen: { unit: "m", label: "Kitchen cupboards" },
  wardrobe: { unit: "m", label: "Wardrobes" },
  boundary: { unit: "m", label: "Boundary wall" },
  gate: { unit: "each", label: "Gate" },
  permitTotal: { unit: "each", label: "Building permit and published plan fees" }
};

const EXTRA_PHRASES = {
  permitTotal: ["permit", "building permit", "plan approval", "plan fee", "building plan approval", "development permit", "construction permit", "county permit", "assembly permit"]
};

export function normalisePhrase(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phraseList(entry, synonyms) {
  const key = entry.key;
  const global = (synonyms && synonyms.global && synonyms.global[key]) || [];
  const local = (synonyms && synonyms.countries && synonyms.countries[entry.countryId] && synonyms.countries[entry.countryId][key]) || [];
  const list = [entry.label, key, ...EXTRA_PHRASES[key] || [], ...global, ...local];
  for (const option of entry.options || []) list.push(option.name);
  const seen = new Set();
  return list
    .map((x) => normalisePhrase(x))
    .filter((x) => {
      if (!x || seen.has(x)) return false;
      seen.add(x);
      return true;
    });
}

function optionFromChoice(choice) {
  return {
    id: choice.id,
    name: choice.name,
    price: Number(choice.price),
    quoted: !!choice.quoted,
    isGuide: !choice.quoted,
    source: choice.source || "",
    url: choice.url || "",
    norm: normalisePhrase(choice.name)
  };
}

function hasLocalPrice(country, key) {
  const item = country && country.items && country.items[key];
  return !!(item && (Number(item.price) > 0 || (Array.isArray(item.options) && item.options.some((o) => Number(o.price || o.amount) > 0))));
}

export function buildCatalogue({ data, countryId, rates, synonyms, permitTotal }) {
  const country = data && data.countries && data.countries[countryId];
  if (!country) return { country: null, countryId, currency: "", checked: "", entries: [], byKey: {} };
  const entries = [];
  const byKey = {};

  for (const [key, meta] of Object.entries(ITEM_UNITS)) {
    if (key === "permitTotal") continue;
    let priced = null;
    try {
      priced = SFBuild.priceOf(data, countryId, key, rates);
    } catch {
      priced = null;
    }
    if (!priced) continue;

    const local = hasLocalPrice(country, key);
    const entry = {
      key,
      countryId,
      label: meta.label,
      unit: meta.unit,
      unitName: `per ${meta.unit}`,
      available: local,
      reason: local
        ? ""
        : `No ${country.name} price in this check. The house calculator shows a guide scaled from another country, and we do not compare a quote with a scaled guide.`,
      checked: data.updated || "",
      price: local ? Number(priced.price) : null,
      quoted: local ? !!priced.quoted : false,
      isGuide: local ? !priced.quoted : true,
      source: priced.source || "",
      url: priced.url || "",
      optionId: priced.optionId || "",
      optionName: priced.optionName || "",
      options: local
        ? (priced.choices || []).filter((c) => Number(c.price) > 0).map(optionFromChoice)
        : [],
      defaultOptionId: ""
    };
    const def = entry.options.find((o) => o.id === priced.optionId) || entry.options.find((o) => o.isGuide === false) || entry.options[0];
    if (def) {
      entry.defaultOptionId = def.id;
      entry.price = def.price;
      entry.quoted = def.quoted;
      entry.isGuide = def.isGuide;
      entry.source = def.source || entry.source;
      entry.url = def.url || entry.url;
      entry.optionName = def.name;
    }
    entry.phrases = phraseList(entry, synonyms);
    entries.push(entry);
    byKey[key] = entry;
  }

  if (permitTotal && Number(permitTotal.amount) > 0) {
    const entry = {
      key: "permitTotal",
      countryId,
      label: ITEM_UNITS.permitTotal.label,
      unit: "each",
      unitName: "for the stated floor area",
      available: true,
      reason: "",
      checked: data.updated || "",
      price: Number(permitTotal.amount),
      quoted: false,
      isGuide: true,
      source: permitTotal.source || "The published permit fees for this country, added for the stated floor area.",
      url: permitTotal.url || "",
      optionId: "permit-total",
      optionName: "All published permit fees for the stated floor area",
      options: [{
        id: "permit-total",
        name: "All published permit fees for the stated floor area",
        price: Number(permitTotal.amount),
        quoted: false,
        isGuide: true,
        source: permitTotal.source || "",
        url: permitTotal.url || "",
        norm: "all published permit fees for the stated floor area"
      }],
      defaultOptionId: "permit-total"
    };
    entry.phrases = phraseList(entry, synonyms);
    entries.push(entry);
    byKey.permitTotal = entry;
  }

  return { country, countryId, currency: country.currency, checked: data.updated || "", entries, byKey };
}

/* Pick the published variant whose name best matches the words in the quote.
   Ties go to the default (typical) variant, so a plain "6 inch block" gets the typical price. */
export function chooseOption(entry, description) {
  if (!entry || !entry.options || !entry.options.length) return null;
  const text = normalisePhrase(description);
  const def = entry.options.find((o) => o.id === entry.defaultOptionId) || entry.options[0];
  let best = null;
  let bestScore = 0;
  for (const option of entry.options) {
    if (!option.norm) continue;
    let score = 0;
    if (text.includes(option.norm)) score = 2 + option.norm.length / 100;
    else {
      const words = option.norm.split(" ").filter((w) => w.length > 2);
      if (words.length) {
        const hit = words.filter((w) => text.split(" ").includes(w)).length;
        score = hit / words.length;
      }
    }
    const textLow = /\b(low|lower|budget|economy|cheap)\b/.test(text);
    const textHigh = /\b(high|upper|premium|luxury|large)\b/.test(text);
    const optLow = /\b(low|lower|budget|economy|cheap)\b/.test(option.norm);
    const optHigh = /\b(high|upper|premium|luxury|large)\b/.test(option.norm);
    if (textLow && !optLow && optHigh) score -= 1;
    if (textHigh && !optHigh && optLow) score -= 1;
    if (score > bestScore + 0.001) {
      bestScore = score;
      best = option;
    }
  }
  if (best && bestScore >= 0.5) return best;
  return def;
}
