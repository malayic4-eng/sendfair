// /api/ask accepts only requests whose Origin (or, without one, Referer) is https://sendfair.africa or the
// request's own origin. 400 = allowed through (empty question), 403 = refused.  node scripts/test-ask.mjs
import { onRequestPost } from "../functions/api/ask.js";
const mk = (url, h) => new Request(url, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ question: "" }) });
const cases = [
  ["https://sendfair.africa/api/ask", {}, 403],
  ["https://sendfair.africa/api/ask", { Origin: "https://evil.example" }, 403],
  ["https://sendfair.africa/api/ask", { Origin: "null" }, 403],
  ["https://sendfair.africa/api/ask", { Referer: "https://evil.example/x" }, 403],
  ["https://sendfair.africa/api/ask", { Referer: "not a url" }, 403],
  ["https://sendfair.africa/api/ask", { Origin: "https://sendfair.africa" }, 400],
  ["https://sendfair.africa/api/ask", { Referer: "https://sendfair.africa/send-money/uk-to-kenya/" }, 400],
  ["https://sendfair.x.workers.dev/api/ask", { Origin: "https://sendfair.x.workers.dev" }, 400],
  ["https://sendfair.x.workers.dev/api/ask", { Origin: "https://other.x.workers.dev" }, 403],
  ["https://sendfair.africa/api/ask", { Origin: "https://evil.example", Referer: "https://sendfair.africa/" }, 403],
];
let bad = 0;
for (const [u, h, want] of cases) {
  const r = await onRequestPost({ request: mk(u, h), env: {} });
  const ok = r.status === want; if (!ok) bad++;
  console.log(ok ? "ok" : "FAIL", r.status, want, u, JSON.stringify(h));
}
console.log(`ask origin: ${cases.length} cases, ${bad} failure(s)`);
if (bad) process.exit(1);
