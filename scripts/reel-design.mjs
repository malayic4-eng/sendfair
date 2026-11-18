// SendFair reel design: bright, country-coloured frames with photo backgrounds, white number cards,
// provider logos and motion. Pure functions that return SVG strings; social-reel.mjs renders them.
import fs from "node:fs";

export const W = 1080, H = 1920;
const M = 72;
const FONT = "Figtree";

// Vivid two-stop gradients drawn from each flag, plus a bright accent that reads on the dark end.
const PALETTES = {
  nigeria: ["#00b26b", "#003a24", "#ffd23f"],
  ghana: ["#e8173a", "#4a0614", "#fcd116"],
  kenya: ["#13a34a", "#06210f", "#ffd23f"],
  uganda: ["#e01b1b", "#2b0505", "#fcdc04"],
  zambia: ["#22a00a", "#062b00", "#ff9d00"],
  zimbabwe: ["#0a8f2e", "#071f0d", "#ffd200"],
  egypt: ["#d8193a", "#1c0308", "#f2c14e"],
  morocco: ["#d42a30", "#3a0508", "#36e3a0"],
  senegal: ["#00a24b", "#002b14", "#fdef42"],
  ivorycoast: ["#ff8a00", "#4d1f00", "#3ff0a0"],
  mali: ["#16c13f", "#04310f", "#fcd116"],
  cameroon: ["#00a37a", "#002a20", "#fcd116"],
  ethiopia: ["#0a9a3a", "#062a12", "#fcdd09"],
  southafrica: ["#00a35f", "#001f14", "#ffb612"],
  tanzania: ["#00a8e8", "#002a40", "#fcd116"],
  drc: ["#1a8cff", "#001b45", "#f7d618"],
  rwanda: ["#12a8e4", "#002f48", "#fad201"],
  _: ["#4b3bf0", "#120b4a", "#ffcc33"]
};
export const palette = (cid) => { const p = PALETTES[cid] || PALETTES._; return { top: p[0], bottom: p[1], accent: p[2] }; };

// Only flags that simple shapes draw correctly; the rest get a country-name pill instead.
const FLAGS = {
  nigeria: (w, h) => `<rect width="${w}" height="${h}" fill="#fff"/><rect width="${w / 3}" height="${h}" fill="#008751"/><rect x="${(2 * w) / 3}" width="${w / 3}" height="${h}" fill="#008751"/>`,
  ivorycoast: (w, h) => `<rect width="${w / 3}" height="${h}" fill="#f77f00"/><rect x="${w / 3}" width="${w / 3}" height="${h}" fill="#fff"/><rect x="${(2 * w) / 3}" width="${w / 3}" height="${h}" fill="#009e60"/>`,
  mali: (w, h) => `<rect width="${w / 3}" height="${h}" fill="#14b53a"/><rect x="${w / 3}" width="${w / 3}" height="${h}" fill="#fcd116"/><rect x="${(2 * w) / 3}" width="${w / 3}" height="${h}" fill="#ce1126"/>`,
  ghana: (w, h) => `<rect width="${w}" height="${h / 3}" fill="#ce1126"/><rect y="${h / 3}" width="${w}" height="${h / 3}" fill="#fcd116"/><rect y="${(2 * h) / 3}" width="${w}" height="${h / 3}" fill="#006b3f"/>${star(w / 2, h / 2, h / 6.5, "#000")}`,
  senegal: (w, h) => `<rect width="${w / 3}" height="${h}" fill="#00853f"/><rect x="${w / 3}" width="${w / 3}" height="${h}" fill="#fdef42"/><rect x="${(2 * w) / 3}" width="${w / 3}" height="${h}" fill="#e31b23"/>${star(w / 2, h / 2, h / 6, "#00853f")}`,
  cameroon: (w, h) => `<rect width="${w / 3}" height="${h}" fill="#007a5e"/><rect x="${w / 3}" width="${w / 3}" height="${h}" fill="#ce1126"/><rect x="${(2 * w) / 3}" width="${w / 3}" height="${h}" fill="#fcd116"/>${star(w / 2, h / 2, h / 6, "#fcd116")}`
};
function star(cx, cy, r, fill) {
  const pts = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.4 : r; pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`); }
  return `<polygon points="${pts.join(" ")}" fill="${fill}"/>`;
}

export const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function wrap(text, max) {
  const words = String(text || "").split(/\s+/), lines = [];
  let line = "";
  for (const w of words) { if ((line + " " + w).trim().length > max) { if (line) lines.push(line); line = w; } else line = (line + " " + w).trim(); }
  if (line) lines.push(line);
  return lines;
}
function fit(text, steps) {
  for (const st of steps) { const lines = wrap(text, st.chars); if (lines.length <= st.max) return { ...st, lines }; }
  const last = steps[steps.length - 1];
  return { ...last, lines: wrap(text, last.chars) };
}
const t = (x, y, size, fill, txt, o = {}) => `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${o.bold ? 700 : 400}" fill="${fill}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.opacity != null ? ` opacity="${o.opacity}"` : ""}${o.ls ? ` letter-spacing="${o.ls}"` : ""}>${txt}</text>`;
// Amounts, percentages and currency codes in a headline are coloured with the accent.
const isFigure = (w) => /[$£€]|\d|^[A-Z]{3}$/.test(w);
const lineSpans = (line, accent) => line.split(" ").map((w) => `<tspan fill="${isFigure(w) ? accent : "#ffffff"}">${esc(w)}</tspan>`).join(" ");

const dataUri = (file, mime) => `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
const cache = new Map();
export function asset(file, mime) { if (!file || !fs.existsSync(file)) return null; if (!cache.has(file)) cache.set(file, dataUri(file, mime)); return cache.get(file); }

function background(pal, photo, zoom = 1, shade = "bottom") {
  const defs = `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${pal.top}"/><stop offset="1" stop-color="${pal.bottom}"/></linearGradient>
<radialGradient id="glowA" cx="0.85" cy="0.12" r="0.55"><stop offset="0" stop-color="${pal.accent}" stop-opacity="0.45"/><stop offset="1" stop-color="${pal.accent}" stop-opacity="0"/></radialGradient>
<radialGradient id="glowB" cx="0.1" cy="0.92" r="0.6"><stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.55"/><stop offset="0.28" stop-color="#000" stop-opacity="0.05"/><stop offset="0.5" stop-color="${pal.bottom}" stop-opacity="0.25"/><stop offset="0.78" stop-color="${pal.bottom}" stop-opacity="0.9"/><stop offset="1" stop-color="${pal.bottom}" stop-opacity="0.97"/></linearGradient>
<linearGradient id="tint" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${pal.top}" stop-opacity="0.35"/><stop offset="1" stop-color="${pal.bottom}" stop-opacity="0.15"/></linearGradient>
<pattern id="dots" width="36" height="36" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="2" fill="#fff" opacity="0.07"/></pattern>`;
  if (photo) {
    const pw = W * zoom, ph = H * zoom;
    return { defs, body: `<rect width="${W}" height="${H}" fill="${pal.bottom}"/><image href="${photo}" x="${(W - pw) / 2}" y="${(H - ph) / 2}" width="${pw}" height="${ph}" preserveAspectRatio="xMidYMid slice"/><rect width="${W}" height="${H}" fill="url(#tint)"/><rect width="${W}" height="${H}" fill="url(#shade)"/>` };
  }
  return { defs, body: `<rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#glowA)"/><rect width="${W}" height="${H}" fill="url(#glowB)"/><rect width="${W}" height="${H}" fill="url(#dots)"/>
<circle cx="${W + 60}" cy="${H * 0.46}" r="300" fill="none" stroke="${pal.accent}" stroke-width="40" opacity="0.18"/><circle cx="-80" cy="${H * 0.2}" r="190" fill="none" stroke="#fff" stroke-width="26" opacity="0.08"/>` };
}

function header(ctx, tag) {
  const flag = FLAGS[ctx.cid];
  const badge = flag
    ? `<g transform="translate(${W - M - 120},96)"><clipPath id="fc"><rect width="120" height="80" rx="14"/></clipPath><g clip-path="url(#fc)">${flag(120, 80)}</g><rect width="120" height="80" rx="14" fill="none" stroke="#fff" stroke-opacity="0.7" stroke-width="3"/></g>`
    : ctx.country ? `<g transform="translate(${W - M},96)"><rect x="${-(ctx.country.length * 21 + 56)}" width="${ctx.country.length * 21 + 56}" height="80" rx="40" fill="#ffffff" fill-opacity="0.16" stroke="#fff" stroke-opacity="0.5" stroke-width="2"/>${t(-(ctx.country.length * 21 + 56) / 2, 52, 34, "#fff", esc(ctx.country), { bold: true, anchor: "middle" })}</g>` : "";
  return `<g transform="translate(${M},96)"><rect width="80" height="80" rx="22" fill="#ffffff"/>${t(40, 54, 40, ctx.pal.bottom, "SF", { bold: true, anchor: "middle" })}${t(100, 54, 38, "#fff", "SendFair", { bold: true })}</g>${badge}
${tag ? `<g transform="translate(${M},${196})">${t(0, 34, 26, ctx.pal.accent, esc(tag.toUpperCase()), { bold: true, ls: 3 })}</g>` : ""}`;
}
function footer(ctx) {
  return `${t(M, H - 120, 28, "#fff", `Checked ${esc(ctx.date)} · rates and fees from sendfair.africa`, { opacity: 0.75 })}<rect x="${M}" y="${H - 96}" width="140" height="8" rx="4" fill="${ctx.pal.accent}"/>`;
}
const svg = (defs, body) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}</svg>`;

// Hook: full-bleed photo (slow zoom), headline at the bottom with figures in the accent colour.
export function hookFrame(ctx, hook, tag, k = 1) {
  const bg = background(ctx.pal, ctx.photoA, 1 + 0.07 * k);
  const f = fit(hook, [{ chars: 16, max: 3, size: 108, lh: 118 }, { chars: 20, max: 4, size: 90, lh: 100 }, { chars: 24, max: 5, size: 76, lh: 86 }]);
  const y0 = 1420 - (f.lines.length - 1) * f.lh;
  const lines = f.lines.map((l, i) => `<text x="${M}" y="${y0 + i * f.lh}" font-family="${FONT}" font-size="${f.size}" font-weight="700">${lineSpans(l, ctx.pal.accent)}</text>`).join("");
  const pillW = 360;
  const pill = `<g transform="translate(${M},${y0 - f.size - 70})"><rect width="${pillW}" height="66" rx="33" fill="${ctx.pal.accent}"/>${t(pillW / 2, 44, 30, "#111", "TODAY'S CHECK", { bold: true, anchor: "middle", ls: 2 })}</g>`;
  return svg(bg.defs, bg.body + header(ctx, tag) + pill + lines + `<rect x="${M}" y="${y0 + (f.lines.length - 1) * f.lh + 50}" width="${200 * Math.min(1, k * 1.5)}" height="10" rx="5" fill="${ctx.pal.accent}"/>` + footer(ctx));
}

// Number: white card sliding up, big figure in the country colour, logo when the row names a provider,
// and every number of the story as chips underneath with the current one highlighted.
export function rowFrame(ctx, hook, rows, activeIndex, shownValue, enter = 1) {
  const bg = background(ctx.pal, null);
  const row = rows[activeIndex];
  const ease = 1 - Math.pow(1 - enter, 3);
  const dy = (1 - ease) * 120, op = 0.25 + 0.75 * ease;
  const f = fit(hook, [{ chars: 30, max: 2, size: 50, lh: 60 }, { chars: 36, max: 3, size: 42, lh: 52 }, { chars: 44, max: 4, size: 36, lh: 44 }]);
  const head = f.lines.map((l, i) => `<text x="${M}" y="${330 + i * f.lh}" font-family="${FONT}" font-size="${f.size}" font-weight="700">${lineSpans(l, ctx.pal.accent)}</text>`).join("");
  const cardY = 560 + (f.lines.length - 2) * 30;
  const logo = providerLogo(ctx, row.label);
  const valueSize = String(shownValue).length > 12 ? 118 : 148;
  const card = `<g transform="translate(0,${dy})" opacity="${op}">
<rect x="${M - 6}" y="${cardY + 18}" width="${W - 2 * M + 12}" height="540" rx="56" fill="#000" opacity="0.28"/>
<rect x="${M}" y="${cardY}" width="${W - 2 * M}" height="540" rx="52" fill="#ffffff"/>
<rect x="${M}" y="${cardY}" width="18" height="540" rx="9" fill="${ctx.pal.accent}"/>
${t(M + 70, cardY + 130, 52, "#3a3f55", esc(row.label), { bold: true })}
${logo ? `<g transform="translate(${W - M - 70 - 112},${cardY + 50})"><rect width="112" height="112" rx="28" fill="#f3f4f8"/><image href="${logo}" x="12" y="12" width="88" height="88"/></g>` : ""}
${t(M + 70, cardY + 340, valueSize, ctx.pal.top === "#ffffff" ? "#111" : darken(ctx.pal.top), esc(shownValue), { bold: true })}
<rect x="${M + 70}" y="${cardY + 400}" width="${(W - 2 * M - 140) * Math.min(1, ease)}" height="14" rx="7" fill="${ctx.pal.accent}"/>
${t(M + 70, cardY + 480, 32, "#6b7088", esc(activeIndex === rows.length - 1 ? "the number that matters" : `${activeIndex + 1} of ${rows.length}`))}
</g>`;
  const chipY = cardY + 640;
  const chips = rows.map((r, i) => {
    const on = i === activeIndex, y = chipY + i * 132;
    return `<g><rect x="${M}" y="${y}" width="${W - 2 * M}" height="110" rx="55" fill="${on ? ctx.pal.accent : "#ffffff"}" fill-opacity="${on ? 1 : 0.13}"/>
${t(M + 48, y + 70, 40, on ? "#111" : "#fff", esc(r.label), { bold: on })}${t(W - M - 48, y + 70, 42, on ? "#111" : ctx.pal.accent, esc(i <= activeIndex ? r.value : "…"), { bold: true, anchor: "end" })}</g>`;
  }).join("");
  return svg(bg.defs, bg.body + header(ctx, "") + head + card + chips + footer(ctx));
}

// Call to action over the second photo.
export function ctaFrame(ctx, k = 1) {
  const bg = background(ctx.pal, ctx.photoB || ctx.photoA, 1.04 - 0.04 * k);
  const pw = W - 2 * M;
  return svg(bg.defs, bg.body + header(ctx, "") +
    t(M, 1180, 92, "#fff", "Who pays the", { bold: true }) + t(M, 1290, 92, ctx.pal.accent, "most today?", { bold: true }) +
    t(M, 1380, 40, "#fff", "Compare your own amount in seconds.", { opacity: 0.9 }) +
    `<g transform="translate(${M},1450)"><rect width="${pw}" height="128" rx="64" fill="#ffffff"/>${t(pw / 2, 84, 56, darken(ctx.pal.top), "sendfair.africa", { bold: true, anchor: "middle" })}</g>` +
    t(M, 1660, 30, "#fff", "Free · independent · 17 African countries", { opacity: 0.8 }) + footer(ctx));
}
export function endFrame(ctx) {
  const bg = background(ctx.pal, null);
  return svg(bg.defs, bg.body + `<g transform="translate(${W / 2 - 110},660)"><rect width="220" height="220" rx="60" fill="#fff"/>${t(110, 146, 110, ctx.pal.bottom, "SF", { bold: true, anchor: "middle" })}</g>` +
    t(W / 2, 1020, 76, "#fff", "SendFair", { bold: true, anchor: "middle" }) + t(W / 2, 1100, 44, ctx.pal.accent, "sendfair.africa", { bold: true, anchor: "middle" }) +
    t(W / 2, 1180, 34, "#fff", "Follow for a new rate check every day", { anchor: "middle", opacity: 0.85 }) + footer(ctx));
}

// 1080x1350 image post in the same style.
export function imagePost(ctx, image) {
  const w = 1080, h = 1350;
  const f = fit(image.headline, [{ chars: 22, max: 3, size: 74, lh: 84 }, { chars: 28, max: 4, size: 60, lh: 70 }]);
  const head = f.lines.map((l, i) => `<text x="${M}" y="${300 + i * f.lh}" font-family="${FONT}" font-size="${f.size}" font-weight="700">${lineSpans(l, ctx.pal.accent)}</text>`).join("");
  const y0 = 330 + f.lines.length * f.lh;
  const rows = image.rows.map((r, i) => `<rect x="${M}" y="${y0 + i * 118}" width="${w - 2 * M}" height="98" rx="49" fill="${i === 0 ? ctx.pal.accent : "#ffffff"}" fill-opacity="${i === 0 ? 1 : 0.14}"/>${t(M + 44, y0 + i * 118 + 63, 36, i === 0 ? "#111" : "#fff", esc(r.label), { bold: i === 0 })}${t(w - M - 44, y0 + i * 118 + 63, 38, i === 0 ? "#111" : ctx.pal.accent, esc(r.value), { bold: true, anchor: "end" })}`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ctx.pal.top}"/><stop offset="1" stop-color="${ctx.pal.bottom}"/></linearGradient><radialGradient id="gl" cx="0.9" cy="0.1" r="0.6"><stop offset="0" stop-color="${ctx.pal.accent}" stop-opacity="0.45"/><stop offset="1" stop-color="${ctx.pal.accent}" stop-opacity="0"/></radialGradient></defs>
<rect width="${w}" height="${h}" fill="url(#bg)"/><rect width="${w}" height="${h}" fill="url(#gl)"/>
<g transform="translate(${M},80)"><rect width="76" height="76" rx="20" fill="#fff"/>${t(38, 51, 38, ctx.pal.bottom, "SF", { bold: true, anchor: "middle" })}${t(96, 51, 36, "#fff", "SendFair", { bold: true })}</g>
${head}${rows}
${t(M, h - 170, 26, "#fff", esc(image.footnote), { opacity: 0.75 })}
<g transform="translate(${M},${h - 130})"><rect width="380" height="80" rx="40" fill="#fff"/>${t(190, 53, 36, darken(ctx.pal.top), "sendfair.africa", { bold: true, anchor: "middle" })}</g></svg>`;
}

function darken(hex) {
  const n = parseInt(hex.slice(1), 16), f = 0.62;
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
function providerLogo(ctx, label) {
  const hit = (ctx.providers || []).find((p) => String(label).includes(p.name));
  return hit ? asset(`src/logos/${hit.id}.png`, "image/png") : null;
}
