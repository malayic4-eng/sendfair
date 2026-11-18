// Downloads the reel background photos listed in data/social/photos.json (Unsplash License) into
// data/social/photo-cache/ at 4K portrait size (2160x3840). Skips files already there; a failed download only means
// that frame uses the country gradient instead.
import fs from "node:fs";
const list = JSON.parse(fs.readFileSync("data/social/photos.json", "utf8"));
fs.mkdirSync("data/social/photo-cache", { recursive: true });
// Only today's country is needed (the plan is built first); --all fetches everything.
let only = null;
try { if (!process.argv.includes("--all")) { const plan = JSON.parse(fs.readFileSync("data/social/plan.json", "utf8")); only = String(plan.route || "").split("-").find((x) => (list.countries || {})[x]) || null; } } catch {}
let ok = 0, fail = 0;
for (const [cid, photos] of Object.entries(list.countries || {})) {
  if (only && cid !== only) continue;
  for (const p of photos) {
    const file = `data/social/photo-cache/${p.id}.jpg`;
    if (fs.existsSync(file) && fs.statSync(file).size > 20000) { ok++; continue; }
    try {
      // 4K portrait (2160x3840), cropped to the most interesting part of the photo.
      const r = await fetch(`${p.src}?w=2160&h=3840&fit=crop&crop=entropy&q=85&fm=jpg`, { redirect: "follow" });
      const type = r.headers.get("content-type") || "";
      if (!r.ok || !type.startsWith("image/")) throw new Error(`${r.status} ${type}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(file, buf);
      ok++;
      console.log(`${cid}: ${p.id} (${Math.round(buf.length / 1024)} KB)`);
    } catch (e) { fail++; console.log(`${cid}: ${p.id} failed (${e.message})`); }
  }
}
console.log(`photos: ${ok} ready, ${fail} failed`);
