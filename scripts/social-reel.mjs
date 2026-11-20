// Renders the day's Reel: 1080x1920 stills in the brand style, encoded to H.264 MP4 with ffmpeg
// (preset veryfast, no audio track). Also writes the 1080x1350 image post, the cover and the
// ready-to-paste captions. Every final number comes from data/social/plan.json, which is built from
// the same ranking as the site. Without ffmpeg it still writes the stills and the manifest.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import * as D from "./reel-design.mjs";

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const plan = read("data/social/plan.json");
const schedule = plan.schedule || read("data/social/schedule.json");
const OUT = `data/social/reels/${plan.date}`;
const W = 1080, H = 1920;

// resvg-wasm cannot see system fonts, so the brand font ships with the repo (Figtree, SIL OFL 1.1,
// converted from the @fontsource WOFF files to TTF). The same files are used on every machine.
const FONT_FILES = ["src/fonts/figtree-latin-400-normal.ttf", "src/fonts/figtree-latin-700-normal.ttf"];
const FONT_BUFFERS = FONT_FILES.filter((f) => fs.existsSync(f)).map((f) => new Uint8Array(fs.readFileSync(f)));
if (FONT_BUFFERS.length < 2) throw new Error("Figtree TTFs missing in src/fonts/");
const FONT_FAMILY = "Figtree";

let wasmReady = false;
async function renderPng(svg) {
  if (!wasmReady) { await initWasm(fs.readFileSync("node_modules/@resvg/resvg-wasm/index_bg.wasm")); wasmReady = true; }
  const clean = svg.replaceAll('font-family="Arial, Helvetica, sans-serif"', `font-family="${FONT_FAMILY}"`);
  return new Resvg(clean, { fitTo: { mode: "width", value: W }, font: { fontBuffers: FONT_BUFFERS, defaultFontFamily: FONT_FAMILY } }).render().asPng();
}
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// The series name (plan.reel.series, set in social-content.mjs) labels the first frame; these are only
// for plans built before series existed.
const TAG = { route: "Rate of the day", "best-vs-average": "Best vs average", house: "What it costs to build", material: "Build back home", tip: "Sender's tip", "rate-move": "Rate alert" };
const BUILDING = new Set(["house", "material"]);
const prettyDate = (d) => { const x = new Date(String(d || "") + "T00:00:00Z"); return isNaN(x.getTime()) ? String(d || "") : x.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
const numPrefix = (value) => { const m = String(value).match(/^([A-Z]{3})\s/); return m ? m[1] + " " : ""; };
function countValue(row, k) {
  if (typeof row.final !== "number" || !isFinite(row.final)) return row.value;
  if (/^[+-]?\d+(\.\d+)?%$/.test(String(row.value).trim())) { const v = (row.final * k).toFixed(1); return `${String(row.value).trim().startsWith("+") && row.final * k > 0 ? "+" : ""}${v}%`; }
  const prefix = numPrefix(row.value);
  return `${prefix}${Math.round(row.final * k).toLocaleString("en")}`;
}
// Photos are downloaded into data/social/photo-cache/ by scripts/fetch-reel-photos.mjs (Unsplash
// License: free for commercial use). Without them the frames use the country gradient.
function photosFor(cid, date) {
  let list = {};
  try { list = read("data/social/photos.json"); } catch {}
  const ids = ((list.countries || {})[cid] || []).map((p) => p.id).filter((id) => fs.existsSync(`data/social/photo-cache/${id}.jpg`));
  if (!ids.length) return { a: null, b: null };
  // A country comes round about every 17 days; each visit moves on to the next pair of photos, so the
  // same country never repeats the photos of its previous reel, and the hook and the ending differ.
  const [y, m, d] = String(date).split("-").map(Number);
  const day = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) || 0;
  const visit = Math.floor(day / 17);
  const at = (n) => D.asset(`data/social/photo-cache/${ids[(visit * 2 + n) % ids.length]}.jpg`, "image/jpeg");
  return { a: at(0), b: ids.length > 1 ? at(1) : at(0) };
}
function countryOf(route) {
  const recv = new Set(read("data/corridors.json").receivers.map((r) => r.id));
  const parts = String(route || "").split("-");
  return parts.find((x) => recv.has(x)) || "";
}
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

async function main() {
  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
  const reel = plan.reel;
  const tag = (reel.series && reel.series.name) || TAG[reel.template] || "";
  const frames = [];
  const release = (name, svg, secs) => frames.push({ name, svg, secs });
  const cid = countryOf(reel.route);
  const recv = read("data/corridors.json").receivers.find((r) => r.id === cid);
  const photos = photosFor(cid, plan.date);
  const ctx = { cid, country: recv ? recv.name : "", pal: D.palette(cid), photoA: photos.a, photoB: photos.b, date: prettyDate(reel.checkDate), providers: read("data/providers.json").providers, building: BUILDING.has(reel.template),
    ...(reel.template === "material" ? { noBadge: true, lastNote: "the highest of these four, in dollars" } : {}) };
  // Hook: slow zoom over the photo (or the gradient), 2.4 s.
  // Hook: headline readable from the first frame, slow zoom, 1.8 s.
  const hookStep = String(reel.hook).length > 60 ? 0.16 : String(reel.hook).length > 40 ? 0.12 : 0.1; // ~1.8–2.9 s, longer for long headlines
  for (let i = 0; i < 18; i++) release("hook", D.hookFrame(ctx, reel.hook, tag, i / 17), hookStep);
  // Each number: the card slides up while the figure counts, then holds.
  reel.numbers.forEach((row, idx) => {
    const steps = [0.2, 0.4, 0.6, 0.75, 0.88, 0.96];
    steps.forEach((k, j) => release(`row-${idx}-${j}`, D.rowFrame(ctx, reel.hook, reel.numbers, idx, countValue(row, k), Math.min(1, (j + 1) / steps.length)), 0.06));
    release(`row-${idx}`, D.rowFrame(ctx, reel.hook, reel.numbers, idx, row.value, 1), 1.5);
  });
  // No separate end card: the call to action ends the reel so it loops straight back to the hook,
  // which keeps viewers watching (completion rate).
  for (let i = 0; i < 6; i++) release("cta", D.ctaFrame(ctx, i / 5), i < 5 ? 0.08 : 1.8);
  // Keep within schedule.reel.minSeconds–maxSeconds by stretching or trimming the holds.
  let total = frames.reduce((a, f) => a + f.secs, 0);
  const holds = frames.filter((f) => f.secs >= 1);
  if (total < schedule.reel.minSeconds) { const add = (schedule.reel.minSeconds - total) / holds.length; holds.forEach((f) => { f.secs += add; }); }
  total = frames.reduce((a, f) => a + f.secs, 0);
  if (total > schedule.reel.maxSeconds) { const cut = (total - schedule.reel.maxSeconds) / holds.length; holds.forEach((f) => { f.secs = Math.max(0.6, f.secs - cut); }); }

  for (let i = 0; i < frames.length; i++) {
    const png = await renderPng(frames[i].svg);
    fs.writeFileSync(path.join(OUT, "frames", String(i).padStart(3, "0") + ".png"), png);
    if (frames[i].name === "hook" && (i === 17 || i === frames.findLastIndex((f) => f.name === "hook"))) fs.writeFileSync(path.join(OUT, "cover.png"), png);
  }
  // concat list for ffmpeg (each still held for its duration)
  const concat = frames.map((f, i) => `file 'frames/${String(i).padStart(3, "0")}.png'\nduration ${f.secs.toFixed(3)}`).join("\n") + `\nfile 'frames/${String(frames.length - 1).padStart(3, "0")}.png'\n`;
  fs.writeFileSync(path.join(OUT, "concat.txt"), concat);
  // Closed captions (SRT) of what's on screen, for Facebook, which can't auto-caption reels without speech.
  {
    const ts = (t) => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };
    const spans = []; let t0 = 0;
    for (const f of frames) {
      const key = f.name === "hook" ? "hook" : f.name === "cta" ? "cta" : f.name.split("-").slice(0, 2).join("-");
      const last = spans[spans.length - 1];
      if (last && last.key === key) last.end = t0 + f.secs; else spans.push({ key, start: t0, end: t0 + f.secs });
      t0 += f.secs;
    }
    const textFor = (k) => k === "hook" ? reel.hook : k === "cta" ? (ctx.building ? D.CTA_TEXT.building.srt : D.CTA_TEXT.transfer.srt) : (() => { const r = reel.numbers[Number(k.split("-")[1])]; return r ? `${r.label}: ${r.value}` : ""; })();
    const srt = spans.map((sp, i) => `${i + 1}\n${ts(sp.start)} --> ${ts(sp.end)}\n${textFor(sp.key)}\n`).join("\n");
    fs.writeFileSync(path.join(OUT, "captions.en_US.srt"), srt);
  }

  let mp4 = null;
  if (hasFfmpeg) {
    try {
      // A silent AAC track is included on purpose: Instagram needs an audio stream to mix library music into.
      execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", "reel.mp4"], { cwd: OUT, stdio: "ignore" });
      mp4 = "reel.mp4";
      console.log(`Reel: ${OUT}/reel.mp4 (${(fs.statSync(path.join(OUT, mp4)).size / 1048576).toFixed(1)} MB, ${total.toFixed(1)}s)`);
      // reel-music.mp4: the same video with a royalty-free music bed (assets/music/*.mp3, one per day
      // in turn). Facebook, YouTube and TikTok can't add library music through their APIs, so they get
      // this file; Instagram keeps the silent reel.mp4 and adds a library song itself.
      const musicDir = path.join(process.cwd(), "assets/music");
      const tracks = fs.existsSync(musicDir) ? fs.readdirSync(musicDir).filter((f) => /\.(mp3|m4a)$/i.test(f)).sort() : [];
      if (tracks.length) {
        const day = Math.floor(Date.parse(plan.date + "T00:00:00Z") / 86400000);
        const track = path.join(musicDir, tracks[day % tracks.length]);
        const fadeOut = Math.max(0, total - 1.2).toFixed(2);
        execFileSync("ffmpeg", ["-y", "-i", "reel.mp4", "-stream_loop", "-1", "-i", track, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", `volume=0.8,afade=t=in:d=0.4,afade=t=out:st=${fadeOut}:d=1.2`, "-c:a", "aac", "-b:a", "160k", "-t", total.toFixed(2), "-movflags", "+faststart", "reel-music.mp4"], { cwd: OUT, stdio: "ignore" });
        console.log(`Reel with music: ${OUT}/reel-music.mp4 (${path.basename(track)})`);
      }
    } catch (e) { console.error("ffmpeg failed:", e.message); }
  } else {
    console.log("ffmpeg not found: wrote the stills and manifest only.");
  }

  const image = plan.image || { headline: reel.hook, rows: reel.numbers.slice(0, 3), footnote: `Source: SendFair (sendfair.africa) · checked ${reel.checkDate}`, cta: "sendfair.africa", link: "" };
  const imagePng = await renderPng(D.imagePost(ctx, image));
  fs.writeFileSync(path.join(OUT, "image.png"), imagePng);
  if (plan.image) fs.writeFileSync(path.join(OUT, `image-${plan.date}.png`), imagePng);
  // Carousel slides (carousel days only): 1080x1350 (4:5), the same renderer, fonts, palette and
  // photos as the Reel. Instagram only accepts JPEG, so each slide is encoded to a high-quality JPEG
  // (q 2, 4:4:4 chroma so text edges stay sharp). Without ffmpeg the PNGs are kept for review.
  let carouselFiles = null;
  if (plan.carousel) {
    const rows = reel.numbers;
    const total = rows.length + 3;
    const svgs = [D.carouselCover(ctx, reel.hook, tag, total), ...rows.map((_, i) => D.carouselRow(ctx, reel.hook, rows, i, i + 2, total)), D.carouselInsight(ctx, plan.carousel.insight, total - 1, total), D.carouselCta(ctx, total, total)];
    carouselFiles = [];
    for (let i = 0; i < svgs.length; i++) {
      const png = path.join(OUT, `carousel-${i + 1}.png`);
      fs.writeFileSync(png, await renderPng(svgs[i]));
      if (hasFfmpeg) {
        const jpg = `carousel-${i + 1}.jpg`;
        execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", png, "-pix_fmt", "yuvj444p", "-q:v", "2", path.join(OUT, jpg)]);
        carouselFiles.push(jpg);
      } else carouselFiles.push(`carousel-${i + 1}.png`);
    }
    for (const platform of ["instagram", "facebook"]) {
      fs.writeFileSync(path.join(OUT, `caption-carousel-${platform}.txt`), plan.carousel.captions[platform] + "\n");
    }
    console.log(`Carousel: ${carouselFiles.length} slides (${hasFfmpeg ? "JPEG" : "PNG only, no ffmpeg"})`);
  }
  for (const platform of ["instagram", "facebook", "tiktok"]) {
    fs.writeFileSync(path.join(OUT, `caption-${platform}.txt`), reel.captions[platform] + "\n");
  }
  const yt = reel.captions.youtube;
  if (yt) fs.writeFileSync(path.join(OUT, "caption-youtube.txt"), `${yt.title}\n\n${yt.description}\n`);
  const manifest = {
    date: plan.date, template: plan.template, route: plan.route, durationSeconds: +total.toFixed(1),
    checkedAt: reel.checkedAt, checkDate: reel.checkDate, numbers: reel.numbers,
    files: { reel: mp4, cover: "cover.png", image: "image.png", captions: ["instagram", "facebook", "tiktok", ...(yt ? ["youtube"] : [])] },
    // Final captions per platform. youtube is { title, description }. The Worker reads this file from
    // R2 to post the same Reel to TikTok and YouTube Shorts.
    captions: reel.captions,
    series: reel.series || null,
    question: reel.question || "",
    links: reel.links || null,
    comments: reel.comments || null,
    image,
    carousel: carouselFiles ? { slides: carouselFiles, captions: plan.carousel.captions } : null
  };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

  if (schedule.tiktok === false) {
    const tt = `data/social/tiktok/${plan.date}`;
    fs.mkdirSync(tt, { recursive: true });
    if (mp4) fs.copyFileSync(path.join(OUT, mp4), path.join(tt, "reel.mp4"));
    fs.copyFileSync(path.join(OUT, "cover.png"), path.join(tt, "cover.png"));
    fs.writeFileSync(path.join(tt, "caption.txt"), reel.captions.tiktok + "\n");
    fs.writeFileSync(path.join(tt, "README.txt"), "TikTok posting is off (or the developer app is not audited yet). Upload reel.mp4 by hand with this caption.\n");
  }
  console.log(`Plan ${plan.date}: ${plan.template}, ${frames.length} stills, ${total.toFixed(1)}s${mp4 ? "" : " (no MP4)"}`);
}

await main();
