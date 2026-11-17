// Tests for the WhatsApp rate bot parser, reply formatter and signature check.
import { parseMessage, formatReply, verifySignature, hashPhone, routeUrl } from "../src/whatsapp.mjs";

const cases = [
  ["UK Nigeria 300", { from: "uk", to: "nigeria", amount: 300 }],
  ["US Kenya 250", { from: "us", to: "kenya", amount: 250 }],
  ["Naija 300 from UK", { from: "uk", to: "nigeria", amount: 300 }],
  ["Canada Ghana 500", { from: "canada", to: "ghana", amount: 500 }],
  ["Europe Senegal 200", { from: "europe", to: "senegal", amount: 200 }],
  ["€200 Senegal", { from: "europe", to: "senegal", amount: 200 }],
  ["£300 to Naija", { from: "uk", to: "nigeria", amount: 300 }],
  ["$250 Kenya", { from: "us", to: "kenya", amount: 250 }],
  ["alert UK Nigeria 250 470000", { alert: true, from: "uk", to: "nigeria", amount: 250, target: 470000 }],
  ["stop", { stop: true }],
  ["UK", { from: "uk", need: "destination" }],
  ["300", { need: "source" }],
  ["UK Nigeria", { from: "uk", to: "nigeria", need: "amount" }],
  ["Nigeria 300", { to: "nigeria", amount: 300, need: "source" }],
  ["alert UK Nigeria 250", { alert: true, need: "target" }]
];
let bad = 0;
for (const [input, want] of cases) {
  const got = parseMessage(input);
  const ok = Object.entries(want).every(([k, v]) => got[k] === v)
    && (!want.from || got.from === want.from) && (!want.to || got.to === want.to)
    && (!want.amount || got.amount === want.amount) && (!want.target || got.target === want.target)
    && (!want.need || got.need === want.need) && (want.stop ? got.stop === true : true)
    && (want.alert ? got.alert === true : true);
  if (!ok) { bad++; console.error("FAIL parse:", JSON.stringify(input), "->", JSON.stringify(got)); }
}

const rows = [
  { p: { name: "Wise" }, gets: 460130, ev: { fee: 0, rate: 1863.32 } },
  { p: { name: "Remitly" }, gets: 458000, ev: { fee: 2.99, rate: 1850 } },
  { p: { name: "WorldRemit" }, gets: 455000, ev: { fee: 1.99, rate: 1840 } }
];
const reply = formatReply({ fromLabel: "the UK", toLabel: "Nigeria", amount: 300, currency: "GBP", receiveCurrency: "NGN", rows, checkedAt: "2026-11-17T12:56:00Z", url: "https://sendfair.africa/send-money/uk-to-nigeria/?ref=wa" });
const replyOk = reply.includes("1. Wise") && reply.includes("Best:") && reply.includes("?ref=wa") && reply.length < 1000;
if (!replyOk) { bad++; console.error("FAIL reply:", reply); }

const exact = routeUrl("uk", "nigeria", 250, "GBP");
const loose = routeUrl("uk", "nigeria", 300, "GBP");
if (exact !== "/send-money/uk-to-nigeria/250/?ref=wa") { bad++; console.error("FAIL exact url:", exact); }
if (loose !== "/send-money/uk-to-nigeria/?ref=wa") { bad++; console.error("FAIL loose url:", loose); }

const raw = JSON.stringify({ hello: "world" });
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
if (!(await verifySignature("secret", raw, `sha256=${hex}`))) { bad++; console.error("FAIL signature valid"); }
if (await verifySignature("secret", raw + "x", `sha256=${hex}`)) { bad++; console.error("FAIL signature tampered"); }
const h = await hashPhone("447700900123", "salt");
if (!/^[0-9a-f]{32}$/.test(h) || h !== (await hashPhone("447700900123", "salt"))) { bad++; console.error("FAIL hash"); }
if (h === (await hashPhone("447700900123", "other"))) { bad++; console.error("FAIL hash salt"); }

console.log(`whatsapp: ${cases.length} parse cases, ${bad} issue(s), reply ${reply.length} chars`);
if (bad) process.exitCode = 1;
