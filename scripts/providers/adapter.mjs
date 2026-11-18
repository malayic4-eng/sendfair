// Shared helpers for provider adapters: field access, CSV, numbers, payout methods, 24-hour freshness.
// Adapters return quotes in the internal SendFair format; nothing here touches a provider website.
export const PAYOUT_ALIASES = {
  bank: ["bank", "bank transfer", "bank account", "bank_account", "account", "deposit", "bank deposit"],
  mobile: ["mobile", "mobile money", "mobile_money", "wallet", "momo", "mobile wallet", "mpesa", "m-pesa", "airtel money"],
  cash: ["cash", "cash pickup", "cash_pickup", "agent", "pickup", "cash collection"]
};

export function normalizePayout(value, fallback = ["bank"]) {
  const raw = Array.isArray(value) ? value : String(value == null ? "" : value).split(/[,;|/]+/);
  const out = new Set();
  for (const item of raw) {
    const k = String(item).trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    if (!k) continue;
    for (const [id, names] of Object.entries(PAYOUT_ALIASES)) {
      if (names.includes(k) || k === id) { out.add(id); break; }
    }
  }
  return out.size ? [...out] : [...fallback];
}

export function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[,\s£$€]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function getPath(obj, path) {
  if (!path || path === ".") return obj;
  return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Minimal RFC 4180 reader for the partner CSV feeds.
export function csvRows(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").filter((l) => l.trim().length);
  if (!lines.length) return [];
  const parse = (line) => {
    const out = []; let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = parse(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = parse(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] == null ? "" : cells[i]]));
  });
}

// A quote may be at most `hours` old and may not be from the future beyond a small clock skew.
export function withinHours(iso, now, hours = 24) {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return false;
  return now - t <= hours * 3600000 && t <= now + 5 * 60000;
}

export function toIso(iso) {
  const t = Date.parse(String(iso || ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
