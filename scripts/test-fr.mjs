// Checks the French dictionary and formatters used by the /fr/ pages.
import { FR, t, moneyFr, dateFr, monthFr, assertFrKeys } from "./i18n.mjs";

const required = [
  "nav.allRoutes", "nav.language", "nav.privacy",
  "footer.sendTo", "footer.disclaimer", "footer.copyright",
  "route.heading", "route.lede", "route.summaryBest", "route.summaryWorst", "route.howTo1Title", "route.receiveHeading", "route.faqHeading",
  "hub.heading", "hub.lede", "rates.heading", "rates.midVsText",
  "money.EUR", "money.XOF", "money.XAF"
];
assertFrKeys(required);

const empty = [];
(function walk(obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + "." + k : k;
    if (typeof v === "string" && !v.trim()) empty.push(key);
    else if (v && typeof v === "object") walk(v, key);
  }
})(FR, "");
if (empty.length) { console.error("fr.json empty strings: " + empty.join(", ")); process.exit(1); }

const checks = [
  ["t nav", t("nav.allRoutes") === "Toutes les destinations"],
  ["grammar", t("route.receiveHeading", { to: "le Sénégal" }) === "Façons de recevoir de l'argent au Sénégal" && t("route.receiveHeading", { to: "la Côte d'Ivoire" }) === "Façons de recevoir de l'argent en Côte d'Ivoire"],
  ["t interpolation", t("route.heading", { from: "le Royaume-Uni", to: "le Sénégal" }) === "Envoyer de l'argent depuis le Royaume-Uni vers le Sénégal"],
  ["money EUR", moneyFr(1234.56, "EUR", 2) === "1 234,56 €"],
  ["money XOF", moneyFr(250000, "XOF") === "250 000 FCFA"],
  ["month", monthFr("2026-11-16").startsWith("novembre")],
  ["date", dateFr("2026-11-16").includes("2026")]
];
let bad = 0;
for (const [name, ok] of checks) if (!ok) { bad++; console.error("FAIL: " + name); }
console.log(`fr: ${Object.keys(FR).length} sections, ${checks.length - bad}/${checks.length} checks passed, ${required.length} required keys present`);
if (bad) process.exitCode = 1;
