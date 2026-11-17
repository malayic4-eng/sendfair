// French copy and formatters for the /fr/ pages. The dictionary lives in data/fr.json so it can be
// edited without touching the build. No runtime machine translation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FR = JSON.parse(fs.readFileSync(path.join(ROOT, "data/fr.json"), "utf8"));

// t("route.heading", { from: "le Royaume-Uni", to: "le Sénégal" })
export function t(key, vars) {
  const value = key.split(".").reduce((obj, k) => (obj && obj[k] != null ? obj[k] : undefined), FR);
  if (value == null) return "";
  return String(value).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
}

const NARROW = /[\u202f\u00a0]/g;

// 1 234,56 € · 250 000 FCFA
export function moneyFr(value, currency, digits) {
  const d = digits == null ? (Math.abs(value) >= 1000 ? 0 : 2) : digits;
  const n = Number(value).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).replace(NARROW, " ");
  return `${n} ${FR.money[currency] || currency}`;
}

export function dateFr(iso, opts) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("fr-FR", opts || { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function monthFr(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
}

// The fr.json file is the single source of UI copy; fail the build if a used key is missing.
export function assertFrKeys(keys) {
  const missing = keys.filter((k) => {
    const v = k.split(".").reduce((obj, part) => (obj && obj[part] != null ? obj[part] : undefined), FR);
    return typeof v !== "string" || !v.trim();
  });
  if (missing.length) throw new Error("fr.json is missing: " + missing.join(", "));
}
