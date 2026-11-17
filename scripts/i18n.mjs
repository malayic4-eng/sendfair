// French copy and formatters for the /fr/ pages. The dictionary lives in data/fr.json so it can be
// edited without touching the build. No runtime machine translation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FR = JSON.parse(fs.readFileSync(path.join(ROOT, "data/fr.json"), "utf8"));

// t("route.heading", { from: "le Royaume-Uni", to: "le Sénégal" })
// Country names carry their article ("le Sénégal", "les États-Unis"), so French contractions are applied
// after filling in: "en le Sénégal" -> "au Sénégal", "en la Côte d'Ivoire" -> "en Côte d'Ivoire",
// "de le Royaume-Uni" -> "du Royaume-Uni", "de les États-Unis" -> "des États-Unis".
export function frGrammar(text) {
  return String(text)
    .replace(/\b([Ee])n le /g, (_, e) => (e === "E" ? "Au " : "au "))
    .replace(/\b([Ee])n les /g, (_, e) => (e === "E" ? "Aux " : "aux "))
    .replace(/\b([Ee])n la /g, "$1n ")
    .replace(/\b([Ee])n l'/g, "$1n ")
    .replace(/\b([Dd])e le /g, (_, d) => (d === "D" ? "Du " : "du "))
    .replace(/\b([Dd])e les /g, (_, d) => (d === "D" ? "Des " : "des "))
    .replace(/(^|\s)à le /g, "$1au ")
    .replace(/(^|\s)à les /g, "$1aux ");
}
export const capFirst = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

// A missing key fails the build (names.* may be absent: callers fall back to the English name).
export function t(key, vars) {
  const value = key.split(".").reduce((obj, k) => (obj && obj[k] != null ? obj[k] : undefined), FR);
  if (value == null) {
    if (key.startsWith("names.")) return "";
    throw new Error("fr.json is missing the key " + key);
  }
  return frGrammar(String(value).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : "")));
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
