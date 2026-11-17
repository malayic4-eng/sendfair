// Renders the day's Reel: 1080x1920 stills in the brand style, encoded to H.264 MP4 with ffmpeg
// (preset veryfast, no audio track). Also writes the 1080x1350 image post, the cover and the
// ready-to-paste captions. Every final number comes from data/social/plan.json, which is built from
// the same ranking as the site. Without ffmpeg it still writes the stills and the manifest.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const plan = read("data/social/plan.json");
const schedule = plan.schedule || read("data/social/schedule.json");
const OUT = `data/social/reels/${plan.date}`;
const INDIGO = "#1b2470", DEEP = "#101428", MARIGOLD = "#f6b52b", WHITE = "#ffffff", MUTED = "#c9cdea";
const W = 1080, H = 1920, MARGIN = 90;

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
const TAG = { route: "Today's rates", "best-vs-average": "Best vs average", house: "House costs", tip: "Money tip", "rate-move": "Rate move" };
const prettyDate = (d) => { const x = new Date(String(d || "") + "T00:00:00Z"); return isNaN(x.getTime()) ? String(d || "") : x.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
function wrap(text, max = 24) {
  const words = String(text || "").split(/\s+/), lines = [];
  let line = "";
  for (const w of words) { if ((line + " " + w).trim().length > max) { if (line) lines.push(line); line = w; } else line = (line + " " + w).trim(); }
  if (line) lines.push(line);
  return lines;
}
const numPrefix = (value) => { const m = String(value).match(/^([A-Z]{3})\s/); return m ? m[1] + " " : ""; };
function countValue(row, k) {
  if (typeof row.final !== "number" || !isFinite(row.final)) return row.value;
  if (String(row.value).trim().endsWith("%")) return `${(row.final * k).toFixed(1)}%`;
  if (/^[+-]?\d+(\.\d+)?%$/.test(String(row.value).trim())) return `${(row.final * k).toFixed(1)}%`;
  const prefix = numPrefix(row.value);
  return `${prefix}${Math.round(row.final * k).toLocaleString("en")}`;
}
function base(inner, tag = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${DEEP}"/><stop offset="1" stop-color="${INDIGO}"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
<rect x="0" y="0" width="${W}" height="8" fill="${MARIGOLD}"/>
<g><rect x="${MARGIN}" y="90" width="86" height="86" rx="22" fill="${MARIGOLD}"/><text x="${MARGIN + 43}" y="150" font-family="Arial, Helvetica, sans-serif" font-size="46" font-weight="700" fill="${DEEP}" text-anchor="middle">SF</text>
<text x="${MARGIN + 110}" y="150" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="${WHITE}">SendFair</text></g>
${tag ? `<text x="${W - MARGIN}" y="150" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="${MUTED}" text-anchor="end">${esc(tag)}</text>` : ""}
${inner}
<text x="${MARGIN}" y="1550" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="${MUTED}">Checked ${esc(prettyDate(plan.reel.checkDate))} · sendfair.africa</text>
<rect x="${MARGIN}" y="1580" width="${W - MARGIN * 2}" height="4" fill="${MARIGOLD}" opacity="0.5"/>
</svg>`;
}
function hookFrame(hook, tag) {
  const lines = wrap(hook, 26).slice(0, 3);
  const y0 = 520;
  const text = lines.map((l, i) => `<text x="${W / 2}" y="${y0 + i * 86}" font-family="Arial, Helvetica, sans-serif" font-size="76" font-weight="700" fill="${WHITE}" text-anchor="middle">${esc(l)}</text>`).join("");
  return base(text, tag);
}
function rowFrame(hook, row, active, tag) {
  const hlines = wrap(hook, 30).slice(0, 2);
  const head = hlines.map((l, i) => `<text x="${W / 2}" y="${430 + i * 54}" font-family="Arial, Helvetica, sans-serif" font-size="46" fill="${MUTED}" text-anchor="middle">${esc(l)}</text>`).join("");
  const big = `<text x="${W / 2}" y="980" font-family="Arial, Helvetica, sans-serif" font-size="120" font-weight="700" fill="${MARIGOLD}" text-anchor="middle">${esc(active.value)}</text>
<text x="${W / 2}" y="860" font-family="Arial, Helvetica, sans-serif" font-size="54" fill="${WHITE}" text-anchor="middle">${esc(active.label)}</text>`;
  const list = row.map((r, i) => `<text x="${MARGIN}" y="${1160 + i * 74}" font-family="Arial, Helvetica, sans-serif" font-size="38" fill="${r === active ? MARIGOLD : MUTED}">${esc(r.label)} — ${esc(r.value)}</text>`).join("");
  return base(head + big + list, tag);
}
function ctaFrame(tag) {
  return base(`<text x="${W / 2}" y="820" font-family="Arial, Helvetica, sans-serif" font-size="60" fill="${MUTED}" text-anchor="middle">Compare yours at</text>
<text x="${W / 2}" y="960" font-family="Arial, Helvetica, sans-serif" font-size="104" font-weight="700" fill="${MARIGOLD}" text-anchor="middle">sendfair.africa</text>
<rect x="${W / 2 - 250}" y="1040" width="500" height="96" rx="48" fill="${MARIGOLD}"/><text x="${W / 2}" y="1103" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="700" fill="${DEEP}" text-anchor="middle">Compare your amount</text>`, tag);
}
function endFrame(tag) {
  return base(`<text x="${W / 2}" y="880" font-family="Arial, Helvetica, sans-serif" font-size="58" fill="${WHITE}" text-anchor="middle">Compare yours at</text>
<text x="${W / 2}" y="1000" font-family="Arial, Helvetica, sans-serif" font-size="80" font-weight="700" fill="${MARIGOLD}" text-anchor="middle">sendfair.africa</text>`, tag);
}
function imageSvg(image, tag) {
  const wh = 1350, ww = 1080;
  const lines = wrap(image.headline, 24).slice(0, 3);
  const head = lines.map((l, i) => `<text x="${ww / 2}" y="${430 + i * 78}" font-family="Arial, Helvetica, sans-serif" font-size="68" font-weight="700" fill="${WHITE}" text-anchor="middle">${esc(l)}</text>`).join("");
  const rows = image.rows.map((r, i) => `<text x="${MARGIN}" y="${760 + i * 92}" font-family="Arial, Helvetica, sans-serif" font-size="44" fill="${MUTED}">${esc(r.label)}</text><text x="${ww - MARGIN}" y="${760 + i * 92}" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="700" fill="${MARIGOLD}" text-anchor="end">${esc(r.value)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ww}" height="${wh}" viewBox="0 0 ${ww} ${wh}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${DEEP}"/><stop offset="1" stop-color="${INDIGO}"/></linearGradient></defs>
<rect width="${ww}" height="${wh}" fill="url(#g)"/><rect width="${ww}" height="8" fill="${MARIGOLD}"/>
<g><rect x="${MARGIN}" y="80" width="78" height="78" rx="20" fill="${MARIGOLD}"/><text x="${MARGIN + 39}" y="133" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="700" fill="${DEEP}" text-anchor="middle">SF</text></g>
${head}${rows}
<text x="${MARGIN}" y="${wh - 190}" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="${MUTED}">${esc(image.footnote)}</text>
<rect x="${MARGIN}" y="${wh - 140}" width="330" height="72" rx="36" fill="${MARIGOLD}"/><text x="${MARGIN + 165}" y="${wh - 94}" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="700" fill="${DEEP}" text-anchor="middle">sendfair.africa</text>
</svg>`;
}

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

async function main() {
  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
  const reel = plan.reel;
  const tag = TAG[reel.template] || "";
  const frames = [];
  const release = (name, svg, secs) => frames.push({ name, svg, secs });
  release("hook", hookFrame(reel.hook, tag), 2.0);
  for (const row of reel.numbers) {
    release("count-" + frames.length + "a", rowFrame(reel.hook, reel.numbers, { ...row, value: countValue(row, 0.4) }, tag), 0.22);
    release("count-" + frames.length + "b", rowFrame(reel.hook, reel.numbers, { ...row, value: countValue(row, 0.8) }, tag), 0.22);
    release("row-" + row.label, rowFrame(reel.hook, reel.numbers, row, tag), 1.8);
  }
  release("cta", ctaFrame(tag), 1.4);
  release("end", endFrame(tag), 1.0);
  // Keep 12–20 s by stretching or trimming the row holds.
  let total = frames.reduce((a, f) => a + f.secs, 0);
  if (total < schedule.reel.minSeconds) { const add = (schedule.reel.minSeconds - total) / frames.length; frames.forEach((f) => { f.secs += add; }); }
  total = frames.reduce((a, f) => a + f.secs, 0);
  if (total > schedule.reel.maxSeconds) { const cut = (total - schedule.reel.maxSeconds) / frames.length; frames.forEach((f) => { f.secs = Math.max(0.12, f.secs - cut); }); }

  for (let i = 0; i < frames.length; i++) {
    const png = await renderPng(frames[i].svg);
    fs.writeFileSync(path.join(OUT, "frames", String(i).padStart(3, "0") + ".png"), png);
    if (i === 0) fs.writeFileSync(path.join(OUT, "cover.png"), png);
  }
  // concat list for ffmpeg (each still held for its duration)
  const concat = frames.map((f, i) => `file 'frames/${String(i).padStart(3, "0")}.png'\nduration ${f.secs.toFixed(3)}`).join("\n") + `\nfile 'frames/${String(frames.length - 1).padStart(3, "0")}.png'\n`;
  fs.writeFileSync(path.join(OUT, "concat.txt"), concat);

  let mp4 = null;
  if (hasFfmpeg) {
    try {
      execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an", "-movflags", "+faststart", "reel.mp4"], { cwd: OUT, stdio: "ignore" });
      mp4 = "reel.mp4";
      console.log(`Reel: ${OUT}/reel.mp4 (${(fs.statSync(path.join(OUT, mp4)).size / 1048576).toFixed(1)} MB, ${total.toFixed(1)}s)`);
    } catch (e) { console.error("ffmpeg failed:", e.message); }
  } else {
    console.log("ffmpeg not found: wrote the stills and manifest only.");
  }

  const image = plan.image || { headline: reel.hook, rows: reel.numbers.slice(0, 3), footnote: `Source: SendFair (sendfair.africa) · checked ${reel.checkDate}`, cta: "sendfair.africa", link: "" };
  const imagePng = await renderPng(imageSvg(image, "image"));
  fs.writeFileSync(path.join(OUT, "image.png"), imagePng);
  if (plan.image) fs.writeFileSync(path.join(OUT, `image-${plan.date}.png`), imagePng);
  for (const platform of ["instagram", "facebook", "tiktok"]) {
    fs.writeFileSync(path.join(OUT, `caption-${platform}.txt`), reel.captions[platform] + "\n");
  }
  const manifest = {
    date: plan.date, template: plan.template, route: plan.route, durationSeconds: +total.toFixed(1),
    checkedAt: reel.checkedAt, checkDate: reel.checkDate, numbers: reel.numbers,
    files: { reel: mp4, cover: "cover.png", image: "image.png", captions: ["instagram", "facebook", "tiktok"] },
    captions: reel.captions,
    image
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
