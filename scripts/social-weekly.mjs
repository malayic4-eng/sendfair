// Weekly social summary: what was posted, its link, and (where the APIs allow) plays/reach.
// Sends to the Buttondown list when BUTTONDOWN_API_KEY is set; otherwise prints the summary.
import fs from "node:fs";

const log = JSON.parse(fs.readFileSync("data/social/log.json", "utf8"));
const version = process.env.FB_GRAPH_VERSION || "v22.0";
const token = process.env.FB_PAGE_TOKEN || "";
const runUrl = process.env.RUN_URL || "";
const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const rows = (log.attempts || []).filter((a) => a.date >= cutoff && a.status !== "dry-run");

async function insights(a) {
  if (!token || !a.postId) return {};
  const base = `https://graph.facebook.com/${version}/${a.postId}`;
  try {
    if (a.platform === "instagram") {
      const d = await fetch(`${base}/insights?metric=plays,reach&access_token=${token}`).then((r) => r.json());
      const v = (n) => (d.data || []).find((m) => m.name === n)?.values?.[0]?.value;
      return { plays: v("plays"), reach: v("reach") };
    }
    if (a.platform === "facebook") {
      const d = await fetch(`${base}/video_insights?metric=total_video_views&access_token=${token}`).then((r) => r.json());
      const v = (n) => (d.data || []).find((m) => m.name === n)?.values?.[0]?.value;
      return { plays: v("total_video_views") };
    }
  } catch {}
  return {};
}

const enriched = [];
for (const a of rows) enriched.push({ ...a, ...(await insights(a)) });
for (const a of enriched) {
  const orig = (log.attempts || []).find((x) => x.at === a.at);
  if (orig) Object.assign(orig, a);
}
fs.writeFileSync("data/social/log.json", JSON.stringify(log, null, 1) + "\n");

// Two consecutive weeks under half the average views is a flag.
const byTemplate = {};
for (const a of enriched) if (a.type === "reel" && a.plays) (byTemplate[a.template] = byTemplate[a.template] || []).push(a.plays);
const all = Object.values(byTemplate).flat();
const avg = all.length ? all.reduce((x, y) => x + y, 0) / all.length : 0;
const weak = Object.entries(byTemplate).filter(([, v]) => v.length >= 2 && v.reduce((x, y) => x + y, 0) / v.length < avg / 2).map(([k]) => k);

const lines = enriched.map((a) => `- ${a.date} ${a.platform} ${a.type}: ${a.status}${a.link ? ` — ${a.link}` : ""}${a.plays ? ` — ${a.plays} plays` : ""}${a.reach ? `, ${a.reach} reach` : ""}${a.error ? ` — ${a.error}` : ""}`);
const last14 = [...new Set((log.attempts || []).map((a) => a.date))].sort().slice(-14);
const downloads = last14.map((d) => `- ${d}: ${runUrl || "workflow artifacts"} (reel-${d})`);

const subject = `SendFair social, week ending ${new Date().toISOString().slice(0, 10)}`;
const body = `<p>Posts in the last 7 days:</p><ul>${lines.map((l) => `<li>${l.replace(/^\- /, "")}</li>`).join("") || "<li>No posts.</li>"}</ul>`
  + (weak.length ? `<p><strong>Templates under half the average for two weeks:</strong> ${weak.join(", ")}</p>` : "")
  + `<p>Download the last 14 days' Reels (MP4, cover, captions) from the workflow artifacts:</p><ul>${downloads.map((l) => `<li>${l.replace(/^\- /, "")}</li>`).join("")}</ul>`
  + `<p>SendFair, sendfair.africa</p>`;
const text = `${subject}\n\n${lines.join("\n")}\n\n${weak.length ? `Under half the average: ${weak.join(", ")}\n` : ""}${downloads.join("\n")}`;

// This is an internal report for the owner, never a newsletter. It is saved as a Buttondown DRAFT
// (drafts never go to subscribers) and, if SOCIAL_REPORT_EMAIL is set, a preview copy is sent to that
// address only (send-draft delivers to the listed recipients, not the list). It is also written to the
// GitHub run summary.
import("node:fs").then((fs) => { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${subject}\n\n${text}\n`); });
console.log(text);
const key = process.env.BUTTONDOWN_API_KEY, to = (process.env.SOCIAL_REPORT_EMAIL || "").trim();
if (key) {
  const H = { Authorization: `Token ${key}`, "content-type": "application/json" };
  const res = await fetch("https://api.buttondown.com/v1/emails", { method: "POST", headers: H, body: JSON.stringify({ subject: `[Internal] ${subject}`, body, status: "draft" }) });
  const draft = await res.json().catch(() => ({}));
  console.log(`Buttondown draft: ${res.status} ${draft.id || JSON.stringify(draft).slice(0, 200)}`);
  if (res.ok && draft.id && to) {
    const s = await fetch(`https://api.buttondown.com/v1/emails/${draft.id}/send-draft`, { method: "POST", headers: H, body: JSON.stringify({ recipients: [to] }) });
    console.log(`Preview sent to the owner only: ${s.status} ${(await s.text()).slice(0, 120)}`);
  }
}
