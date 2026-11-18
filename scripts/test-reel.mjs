// Renders one Reel of each template locally (no posting) and checks:
// duration 12-20 s, 1080x1920, a silent audio track (Instagram mixes library music into it), under 15 MB when ffmpeg is available; every on-screen final
// number matches the site's ranking; captions carry ?ref= links. Without ffmpeg it validates the stills
// and the manifest and says so.
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildPlan } from "./social-content.mjs";

const require = createRequire(import.meta.url);
const R = require("../src/rank.js");
const BC = require("../src/build-cost.js");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const config = read("config.json");
const corridors = read("data/corridors.json");
const quotes = read("data/quotes.json");
const providers = read("data/providers.json").providers;
const buildCosts = read("data/build-costs.json");
const regional = read("data/regional-factors.json");
const midmarket = read("data/midmarket.json");
try { const ov = read("data/mid-overrides.json"); if (ov && ov.rates && Date.now() - new Date(ov.updatedAt).getTime() < 36 * 3600000) Object.assign(midmarket.rates, ov.rates); } catch {}
let feed = { routes: {} };
try { feed = read("data/wise-feed.json"); } catch {}
const pmap = Object.fromEntries(providers.map((p) => [p.id, p]));
const DATE = new Date("2026-11-17T12:00:00Z");
const PLAN = "data/social/plan.json";
const backup = fs.existsSync(PLAN) ? fs.readFileSync(PLAN, "utf8") : null;
const issues = [];
const add = (m) => { issues.push(m); console.error("FAIL: " + m); };

function rowsFor(route, amount) {
  const [sid, rid] = route.split("-");
  const s = corridors.senders.find((x) => x.id === sid), r = corridors.receivers.find((x) => x.id === rid);
  const mid = R.midRate(midmarket, s.currency, r.currency);
  return R.rank({ list: (quotes.quotes || {})[route] || [], feed: (feed.routes || {})[route] || null, providers: pmap, amount, payout: "all", mid, now: Date.now(), staleH: config.staleAfterHours || 36, hideH: config.hideAfterHours || 72 }).filter((x) => !x.stale);
}
function trend(route, days) {
  const d = read("data/history.json").days || {};
  const dates = Object.keys(d).sort().slice(-days);
  const pts = dates.map((x) => ({ d: x, v: (d[x] || {})[route] })).filter((x) => x.v && (x.v.mid || x.v.best));
  if (pts.length < 2) return null;
  const first = pts[0].v.mid || pts[0].v.best / pts[0].v.amount, last = pts[pts.length - 1].v.mid || pts[pts.length - 1].v.best / pts[pts.length - 1].v.amount;
  return { pct: (last / first - 1) * 100 };
}
function pngSize(file) { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
function hasFfmpeg() { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } }

function checkNumbers(plan) {
  const reel = plan.reel;
  if (reel.template === "house") {
    const [cid, city] = reel.route.split("-");
    const house = (buildCosts.houses || []).find((h) => h.id === "3") || { m2: 110 };
    const factor = (((regional.countries || {})[cid] || {}).cities || {})[city]?.factor || 1;
    const eco = BC.regionalEstimate(buildCosts, cid, house.m2, 1, midmarket.rates || {}, {}, { finish: "economy" }, factor);
    const std = BC.regionalEstimate(buildCosts, cid, house.m2, 1, midmarket.rates || {}, {}, { finish: "standard" }, factor);
    const lux = BC.regionalEstimate(buildCosts, cid, house.m2, 1, midmarket.rates || {}, {}, { finish: "luxury" }, factor);
    const want = [eco.total, std.total, lux.total];
    reel.numbers.forEach((n, i) => { if (Math.abs(n.final - want[i]) > 1) add(`${reel.template} number ${i} ${n.final} != ${want[i]}`); });
    return;
  }
  const [sid, rid] = reel.route.split("-");
  const s = corridors.senders.find((x) => x.id === sid), r = corridors.receivers.find((x) => x.id === rid);
  const amount = config.defaultAmounts[s.currency] || 250;
  const rows = rowsFor(reel.route, amount);
  const top = rows[0], lowest = rows[rows.length - 1];
  const gap = top.gets - lowest.gets;
  if (reel.template === "route" || reel.template === "tip") {
    if (Math.abs(reel.numbers[0].final - top.gets) > 0.01) add(`${reel.template} best ${reel.numbers[0].final} != ${top.gets}`);
    if (Math.abs(reel.numbers[reel.numbers.length - 2].final - lowest.gets) > 0.01) add(`${reel.template} lowest != ${lowest.gets}`);
    if (Math.abs(reel.numbers[reel.numbers.length - 1].final - gap) > 0.01) add(`${reel.template} gap != ${gap}`);
  } else if (reel.template === "best-vs-average") {
    const avgGets = rows.reduce((a, x) => a + x.gets, 0) / rows.length;
    const avgCost = rows.reduce((a, x) => a + Math.max(0, 1 - x.gets / (amount * (R.midRate(midmarket, s.currency, r.currency) || 1))), 0) / rows.length;
    const extra = top.gets - avgGets;
    if (Math.abs(reel.numbers[0].final - avgCost * 100) > 0.06) add(`avg cost ${reel.numbers[0].final} != ${avgCost * 100}`);
    if (Math.abs(reel.numbers[1].final - top.gets) > 0.01) add(`best != ${top.gets}`);
    if (Math.abs(reel.numbers[2].final - extra) > 0.01) add(`extra != ${extra}`);
  } else if (reel.template === "rate-move") {
    const t = trend(reel.route, 7);
    const best = reel.numbers[reel.numbers.length - 1].final;
    if (Math.abs(best - top.gets) > 0.01) add(`rate-move best != ${top.gets}`);
    if (t && reel.numbers.length > 1 && Math.abs(reel.numbers[0].final - t.pct) > 0.06) add(`rate-move pct ${reel.numbers[0].final} != ${t.pct}`);
  }
}

const templates = ["route", "best-vs-average", "house", "tip", "rate-move"];
const ffmpeg = hasFfmpeg();
let rendered = 0;
for (const template of templates) {
  const plan = buildPlan(DATE, template);
  if (!plan) { console.log(`skip ${template}: not eligible today`); continue; }
  fs.writeFileSync(PLAN, JSON.stringify(plan, null, 1) + "\n");
  try {
    execFileSync(process.execPath, ["scripts/social-reel.mjs"], { stdio: "inherit" });
    const manifest = read(`data/social/reels/${plan.date}/manifest.json`);
    rendered++;
    if (!(manifest.durationSeconds >= 12 && manifest.durationSeconds <= 20)) add(`${template} duration ${manifest.durationSeconds}s`);
    checkNumbers(plan);
    for (const ref of ["ig", "fb", "tt"]) if (!manifest.captions[{ ig: "instagram", fb: "facebook", tt: "tiktok" }[ref]].includes(`?ref=${ref}`)) add(`${template} caption missing ?ref=${ref}`);
    const cover = pngSize(`data/social/reels/${plan.date}/cover.png`);
    if (cover.w !== 1080 || cover.h !== 1920) add(`${template} cover ${cover.w}x${cover.h}`);
    const image = pngSize(`data/social/reels/${plan.date}/image.png`);
    if (image.w !== 1080 || image.h !== 1350) add(`${template} image ${image.w}x${image.h}`);
    if (ffmpeg) {
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", "-show_entries", "stream=codec_type,width,height", "-of", "json", `data/social/reels/${plan.date}/reel.mp4`]).toString());
      const v = (probe.streams || []).find((s) => s.codec_type === "video");
      const audio = (probe.streams || []).some((s) => s.codec_type === "audio");
      const bytes = Number(probe.format.size), secs = Number(probe.format.duration);
      if (!v || v.width !== 1080 || v.height !== 1920) add(`${template} video ${v && v.width}x${v && v.height}`);
      if (!audio) add(`${template} has no audio track (Instagram needs one to add music)`);
      else {
        const r = spawnSync("ffmpeg", ["-v", "info", "-i", `data/social/reels/${plan.date}/reel.mp4`, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
        const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr || "");
        if (m && m[1] !== "-inf" && Number(m[1]) > -60) add(`${template} audio track is not silent (${m[1]} dB)`);
      }
      if (!(secs >= 12 && secs <= 20)) add(`${template} mp4 duration ${secs}`);
      if (bytes >= 15000000) add(`${template} mp4 ${Math.round(bytes / 1048576)} MB`);
    }
    console.log(`ok ${template}: ${manifest.durationSeconds}s${ffmpeg ? `, ${(fs.statSync(`data/social/reels/${plan.date}/reel.mp4`).size / 1048576).toFixed(1)} MB` : " (stills only, no ffmpeg)"}`);
  } catch (e) {
    add(`${template} render: ${e.message || e}`);
  }
}
if (backup != null) fs.writeFileSync(PLAN, backup);
else try { fs.unlinkSync(PLAN); } catch {}
console.log(`reel test: ${rendered}/${templates.length} templates rendered, ${issues.length} issue(s)${ffmpeg ? "" : " (ffmpeg not found: MP4 checks skipped)"}`);
if (issues.length) process.exitCode = 1;
