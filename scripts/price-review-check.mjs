// Checks whether the house-building price data is due for its monthly review.
// Exits 1 when data/build-costs.json's "nextReview" date has passed, so the workflow
// can open a reminder issue. This automates the *reminder*; the actual price refresh
// is a short human/curation task (the prices come from published lists, not a live feed).
import fs from "node:fs";

const bc = JSON.parse(fs.readFileSync("data/build-costs.json", "utf8"));
const next = new Date(bc.nextReview + "T00:00:00Z");
const today = new Date().toISOString().slice(0, 10);
const todayStart = new Date(today + "T00:00:00Z");

console.log(`House prices — updated ${bc.updated}, next review ${bc.nextReview} (today ${today}).`);
if (next < todayStart) {
  console.log("OVERDUE: house prices need their monthly refresh.");
  process.exit(1);
}
console.log("Not due yet.");
