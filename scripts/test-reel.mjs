// Renders one Reel of each template locally (no posting) and checks:
// duration within schedule.reel min–max seconds, 1080x1920, a silent audio track (Instagram mixes library music into it), under 15 MB when ffmpeg is available; every on-screen final
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
const schedule = read("data/social/schedule.json");
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
  if (reel.template === "material") {
    // Each row is the country's own listed price (BC.priceOf, quoted, not a guide), in its currency.
    const key = reel.route.split("-material-")[1];
    reel.numbers.forEach((n, i) => {
      const cid = reel.countries[i];
      const pr = BC.priceOf(buildCosts, cid, key, midmarket.rates || {});
      if (!pr || !pr.quoted) add(`material ${cid} ${key} is not a listed price`);
      else if (Math.abs(n.final - pr.price) > 1e-9) add(`material ${cid} ${key} ${n.final} != ${pr.price}`);
      const fx = R.midRate(midmarket, buildCosts.countries[cid].currency, "USD");
      if (Math.abs(n.usd - pr.price * fx) > 1e-6) add(`material ${cid} usd ${n.usd} != ${pr.price * fx}`);
    });
    for (let i = 1; i < reel.numbers.length; i++) if (reel.numbers[i].usd < reel.numbers[i - 1].usd) add("material rows not sorted by dollar price");
    return;
  }
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

const templates = ["route", "best-vs-average", "house", "material", "tip", "rate-move"];
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
    if (!(manifest.durationSeconds >= schedule.reel.minSeconds && manifest.durationSeconds <= schedule.reel.maxSeconds)) add(`${template} duration ${manifest.durationSeconds}s`);
    checkNumbers(plan);
    // Links: Facebook and Instagram text carries none (Facebook's first comment and the Instagram
    // bio carry it); the tagged links are in manifest.links. TikTok and YouTube keep the link.
    for (const [k, ref] of [["instagram", "ig"], ["facebook", "fb"], ["tiktok", "tt"], ["youtube", "yt"]]) if (!(manifest.links || {})[k] || !manifest.links[k].endsWith(`?ref=${ref}`)) add(`${template} links.${k} missing ?ref=${ref}`);
    for (const k of ["instagram", "facebook"]) if (/https?:\/\//.test(manifest.captions[k])) add(`${template} ${k} caption has a URL`);
    if (!manifest.captions.tiktok.includes("?ref=tt")) add(`${template} tiktok caption missing ?ref=tt`);
    if (manifest.captions.tiktok.length > 2200) add(`${template} tiktok caption over 2200`);
    const yt = manifest.captions.youtube || {};
    if (!yt.title || yt.title.length > 90 || !yt.title.endsWith(" #Shorts")) add(`${template} youtube title "${yt.title}"`);
    if (!String(yt.description).includes("?ref=yt") || !String(yt.description).includes("https://sendfair.africa/follow/?ref=yt")) add(`${template} youtube description links`);
    if (!manifest.comments || !manifest.comments.facebook.includes(manifest.links.facebook) || !manifest.comments.instagram) add(`${template} first comments missing`);
    const series = manifest.series && manifest.series.name;
    if (!series) add(`${template} no series`);
    for (const k of ["instagram", "facebook", "tiktok"]) {
      const c = manifest.captions[k];
      if (!c.startsWith(`${manifest.series.emoji} ${series} | `)) add(`${template} ${k} caption doesn't open with the series`);
      if (!manifest.question || !c.includes(manifest.question)) add(`${template} ${k} caption missing the question`);
      if (c.indexOf(manifest.question) > c.indexOf("Follow us everywhere")) add(`${template} ${k} question not above the follow line`);
    }
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
      if (!(secs >= schedule.reel.minSeconds - 0.2 && secs <= schedule.reel.maxSeconds + 0.2)) add(`${template} mp4 duration ${secs}`);
      if (bytes >= 15000000) add(`${template} mp4 ${Math.round(bytes / 1048576)} MB`);
    }
    // Carousel (carousel days): 2–10 slides, all 4:5 1080x1350, JPEG under 8 MB (Instagram accepts
    // JPEG only), and every figure in the insight slide traced back to the ranked numbers.
    if (plan.carousel) {
      const c = manifest.carousel;
      if (!c || !c.slides) add(`${template} carousel missing from manifest`);
      else {
        if (c.slides.length < 2 || c.slides.length > 10) add(`${template} carousel has ${c.slides.length} slides`);
        if (c.slides.length !== plan.reel.numbers.length + 3) add(`${template} carousel slide count ${c.slides.length}`);
        for (const f of c.slides) {
          const file = `data/social/reels/${plan.date}/${f}`;
          if (ffmpeg) {
            if (!f.endsWith(".jpg")) add(`${template} ${f} is not JPEG`);
            const b = fs.readFileSync(file);
            if (b[0] !== 0xff || b[1] !== 0xd8) add(`${template} ${f} is not a real JPEG`);
            if (b.length >= 8 * 1024 * 1024) add(`${template} ${f} over 8 MB`);
            const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", file]).toString()).streams[0];
            if (pr.width !== 1080 || pr.height !== 1350) add(`${template} ${f} ${pr.width}x${pr.height}`);
          } else {
            const s = pngSize(file);
            if (s.w !== 1080 || s.h !== 1350) add(`${template} ${f} ${s.w}x${s.h}`);
          }
        }
        const values = plan.reel.numbers.map((n) => n.value);
        const figs = String(plan.carousel.insight).match(/\b[A-Z]{3} [\d,]+(\.\d+)?|[+-]?\d+(\.\d+)?%/g) || [];
        for (const fig of figs) {
          if (values.includes(fig)) continue;
          if (template === "house") {
            const [eco, std, lux] = plan.reel.numbers.map((n) => n.final);
            const cur = plan.reel.receiveCurrency;
            const ok = [std - eco, lux - std].some((v) => fig === `${cur} ${Number(v).toLocaleString("en", { maximumFractionDigits: v >= 1000 ? 0 : 2, minimumFractionDigits: v >= 1000 ? 0 : 2 })}`);
            if (ok) continue;
          }
          add(`${template} insight figure "${fig}" not from the ranked numbers`);
        }
        if (!/Swipe/.test(plan.carousel.captions.instagram) || /https?:\/\//.test(plan.carousel.captions.instagram) || /https?:\/\//.test(plan.carousel.captions.facebook)) add(`${template} carousel caption missing swipe line or has a URL`);
      }
    }
    console.log(`ok ${template}: ${manifest.durationSeconds}s${plan.carousel && manifest.carousel ? `, carousel ${manifest.carousel.slides.length} slides` : ""}${ffmpeg ? `, ${(fs.statSync(`data/social/reels/${plan.date}/reel.mp4`).size / 1048576).toFixed(1)} MB` : " (stills only, no ffmpeg)"}`);
  } catch (e) {
    add(`${template} render: ${e.message || e}`);
  }
}
if (backup != null) fs.writeFileSync(PLAN, backup);
else try { fs.unlinkSync(PLAN); } catch {}
console.log(`reel test: ${rendered}/${templates.length} templates rendered, ${issues.length} issue(s)${ffmpeg ? "" : " (ffmpeg not found: MP4 checks skipped)"}`);
if (issues.length) process.exitCode = 1;
