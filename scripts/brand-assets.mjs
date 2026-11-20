// Renders SendFair brand images: HD logo, YouTube profile picture, banner and video watermark.
// Run: node scripts/brand-assets.mjs  → files in brand/. Uses the same mark as the site logo (scripts/build.mjs `tile`).
import fs from "node:fs";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

const INDIGO = "#111853", GOLD = "#f6b52b";
const S_PATH = "M318 -14Q251 -14 199 0Q147 13 110 40Q73 67 54 107Q34 146 32 197L177 239Q180 195 199 167Q219 139 252 125Q285 112 326 112Q363 112 389 121Q416 130 430 145Q444 161 444 179Q444 202 425 217Q407 232 374 243Q342 253 300 264Q253 276 207 290Q161 304 124 326Q87 349 64 384Q42 419 42 472Q42 535 74 580Q105 625 164 649Q224 674 306 674Q389 674 450 648Q511 623 544 575Q577 528 576 463L430 429Q430 458 422 481Q413 503 397 518Q382 534 358 541Q334 549 303 549Q268 549 244 541Q220 532 208 518Q196 504 196 485Q196 462 215 448Q233 433 267 422Q300 412 342 401Q385 391 430 377Q475 363 513 340Q552 318 576 281Q599 243 599 186Q599 123 566 78Q533 33 470 10Q407 -14 318 -14Z";
const F_PATH = "M33.2 22.2h11.2v-2.7l5.6 4.8-5.6 4.8v-2.7h-6.6v3.6h5.6v4.2h-5.6v8.1h-4.6z";
// The S-F mark in a 64x64 box.
const mark = (s = 1.05) => `<g transform="translate(32 32) scale(${s}) translate(-32 -32)" fill="${GOLD}"><path transform="translate(15.52 42.2) scale(.0275 -.0275)" d="${S_PATH}"/><path d="${F_PATH}"/></g>`;
// The app tile (rounded indigo square with a gold ring), 64x64 box.
const tile = () => `<rect x="1" y="1" width="62" height="62" rx="16" fill="${INDIGO}"/><rect x="4.5" y="4.5" width="55" height="55" rx="13" fill="none" stroke="${GOLD}" stroke-width="1.1" opacity=".7"/>${mark()}`;

const fonts = ["src/fonts/figtree-latin-400-normal.ttf", "src/fonts/figtree-latin-700-normal.ttf"].map((f) => new Uint8Array(fs.readFileSync(f)));
await initWasm(fs.readFileSync("node_modules/@resvg/resvg-wasm/index_bg.wasm"));
const png = (svg, w) => new Resvg(svg, { fitTo: { mode: "width", value: w }, font: { fontBuffers: fonts, defaultFontFamily: "Figtree" } }).render().asPng();
fs.mkdirSync("brand", { recursive: true });
const out = (name, svg, w) => { const b = png(svg, w); fs.writeFileSync(`brand/${name}`, b); console.log(name, w, Math.round(b.length / 1024) + " KB"); };

// 1. HD logo: the tile on a transparent background, 2048 px.
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${tile()}</svg>`;
fs.writeFileSync("brand/sendfair-logo.svg", logoSvg);
out("sendfair-logo-2048.png", logoSvg, 2048);

// 2. YouTube profile picture (shown as a circle): full indigo square, mark centred with room for the crop.
out("youtube-profile-800.png", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${INDIGO}"/><circle cx="32" cy="32" r="27" fill="none" stroke="${GOLD}" stroke-width="1" opacity=".6"/><g transform="translate(32 32) scale(1.25) translate(-32 -32)">${mark(1)}</g></svg>`, 800);

// 3. YouTube banner, 2560x1440. Everything that matters sits inside the 1546x423 safe area (x 507–2053, y 508–931) that every device shows.
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="2560" height="1440" viewBox="0 0 2560 1440">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1040"/><stop offset=".55" stop-color="${INDIGO}"/><stop offset="1" stop-color="#1d2a7a"/></linearGradient></defs>
<rect width="2560" height="1440" fill="url(#g)"/>
<circle cx="2330" cy="180" r="420" fill="${GOLD}" opacity=".06"/><circle cx="230" cy="1300" r="380" fill="${GOLD}" opacity=".05"/>
<g transform="translate(95 0)">
<g transform="translate(520 552) scale(5)">${tile()}</g>
<text x="890" y="660" font-family="Figtree" font-weight="700" font-size="128" fill="#ffffff">SendFair</text>
<text x="894" y="742" font-family="Figtree" font-weight="400" font-size="50" fill="#dfe3ff">Send money home for less.</text>
<text x="894" y="806" font-family="Figtree" font-weight="400" font-size="50" fill="#dfe3ff">Price the house you're building back home.</text>
<rect x="894" y="834" width="560" height="4" rx="2" fill="${GOLD}"/>
<text x="894" y="898" font-family="Figtree" font-weight="700" font-size="42" fill="${GOLD}">New Shorts daily · sendfair.africa</text>
</g>
</svg>`;
out("youtube-banner-2560x1440.png", banner, 2560);

// 4. Video watermark, 150x150 (YouTube shows it small, bottom right).
out("youtube-watermark-150.png", logoSvg, 150);

// 5. App icon (TikTok developer app, app stores): full-bleed indigo square, 1024 px.
out("app-icon-1024.png", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${INDIGO}"/><g transform="translate(32 32) scale(1.3) translate(-32 -32)">${mark(1)}</g></svg>`, 1024);
