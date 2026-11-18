// Runs the provider adapters and publishes their quotes into data/quotes.json.
//   node scripts/fetch-provider-quotes.mjs [--only=partner|all] [--dry-run] [--now=ISO]
// --only=partner (default) runs the six official partner feeds; --all also runs the stored Wise feed.
// A partner adapter runs only when both env vars in its data/adapters/<id>.json are set.
// Feed rows are marked "(partner feed)", quotes older than 24 h are dropped, and two failures in a
// row email the owner (Resend, or a webhook, or the GitHub Actions failure email as a last resort).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PartnerFeedAdapter } from "./providers/partner-feed.mjs";
import { WiseFeedAdapter } from "./providers/wise.mjs";
import { notifyOwner } from "./providers/notify.mjs";
import { runFeeds } from "./providers/runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const eq = args.find((a) => a.startsWith(f + "="));
  if (eq) return eq.slice(f.length + 1);
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};
const DRY = has("--dry-run");
const ONLY = val("--only", "partner");
const NOW = val("--now", new Date().toISOString());
const nowMs = Date.parse(NOW);
if (!Number.isFinite(nowMs)) { console.error("Invalid --now date."); process.exit(1); }
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const write = (p, text) => { if (!DRY) fs.writeFileSync(path.join(ROOT, p), text); };

const config = read("config.json");
const corridors = read("data/corridors.json");
const quotesFile = read("data/quotes.json");
const mid = read("data/midmarket.json").rates || {};
try { const ov = read("data/mid-overrides.json"); if (ov && ov.rates && Date.now() - new Date(ov.updatedAt).getTime() < 36 * 3600000) Object.assign(mid, ov.rates); } catch {}
const provFile = read("data/providers.json").providers;
const providers = new Set(provFile.map((p) => p.id));
const sendsFrom = Object.fromEntries(provFile.map((p) => [p.id, p.sendsFrom || []]));
const routes = corridors.senders.flatMap((s) => corridors.receivers.map((r) => `${s.id}-${r.id}`));
const routeCurrency = {};
for (const s of corridors.senders) for (const r of corridors.receivers) routeCurrency[`${s.id}-${r.id}`] = s.currency;

const adapters = [];
const dir = path.join(ROOT, "data/adapters");
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".json") || f === "state.json") continue;
  const full = path.join(dir, f);
  if (!fs.statSync(full).isFile()) continue;
  const cfg = JSON.parse(fs.readFileSync(full, "utf8"));
  if (cfg && cfg.kind === "partner-feed") adapters.push(new PartnerFeedAdapter(cfg));
}
if (ONLY === "all") adapters.push(new WiseFeedAdapter());
if (!adapters.length) { console.log("No adapters configured."); process.exit(0); }

const statePath = "data/adapters/state.json";
let state = {};
try { state = read(statePath); } catch {}

const { results, state: nextState } = await runFeeds({
  adapters, routes, quotesFile, mid, providers, sendsFrom,
  defaultAmounts: config.defaultAmounts || {}, routeCurrency, state, now: nowMs,
  notify: (msg) => notifyOwner(msg)
});

const ran = results.filter((r) => !r.skipped);
const added = results.reduce((a, r) => a + (r.added || 0), 0);
if (!DRY) {
  if (added) write("data/quotes.json", JSON.stringify(quotesFile, null, 1) + "\n");
  if (ran.length) {
    write(statePath, JSON.stringify(nextState, null, 1) + "\n");
    fs.appendFileSync(path.join(ROOT, "data/adapters/log.jsonl"), JSON.stringify({ at: new Date(nowMs).toISOString(), only: ONLY, results }) + "\n");
  }
}

for (const r of results) {
  if (r.skipped) console.log(`${r.id}: skipped (${r.skipped})`);
  else if (r.ok) console.log(`${r.id}: ok, ${r.added} added, ${r.kept} hand-kept, ${r.dropped} dropped, ${r.invalid} invalid${r.rows != null ? ` (${r.rows} rows)` : ""}`);
  else console.log(`${r.id}: FAILED (${r.consecutiveFailures} in a row) ${r.error}${r.alert ? ` — alert ${r.alert.sent || "NOT sent: " + r.alert.error}` : ""}`);
}

const unsent = results.filter((r) => r.alert && !r.alert.sent);
if (unsent.length && !DRY) {
  fs.appendFileSync(path.join(ROOT, "data/adapters/alerts.jsonl"), unsent.map((r) => JSON.stringify({ at: new Date(nowMs).toISOString(), id: r.id, error: r.error, alert: r.alert })).join("\n") + "\n");
  console.error("Owner alert could not be emailed; see data/adapters/alerts.jsonl. Failing the run so GitHub notifies the owner.");
  process.exitCode = 1;
}
