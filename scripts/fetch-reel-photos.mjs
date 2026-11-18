// Downloads the reel background photos listed in data/social/photos.json (Unsplash License) into
// data/social/photo-cache/, 1600 px wide. Skips files already there; a failed download only means
// that frame uses the country gradient instead.
import fs from "node:fs";
const list = JSON.parse(fs.readFileSync("data/social/photos.json", "utf8"));
fs.mkdirSync("data/social/photo-cache", { recursive: true });
let ok = 0, fail = 0;
for (const [cid, photos] of Object.entries(list.countries || {})) {
  for (const p of photos) {
    const file = `data/social/photo-cache/${p.id}.jpg`;
    if (fs.existsSync(file) && fs.statSync(file).size > 20000) { ok++; continue; }
    try {
      const r = await fetch(`${p.src}?w=1400&q=80&fm=jpg&fit=crop`, { redirect: "follow" });
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
