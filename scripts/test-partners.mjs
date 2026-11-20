// Checks the partner redirects (/go/flights, /go/esim, /go/<sponsor>) and the sponsor box on a build.
// Run after `node scripts/build.mjs`: node scripts/test-partners.mjs
import fs from "node:fs";
import path from "node:path";
import { onRequestGet } from "../functions/go/[provider].js";
import { sponsorsFor, sponsorLive, flightTarget } from "../src/partner-links.mjs";

const DIST = path.resolve("dist");
const issues = [];
const check = (ok, msg) => { if (!ok) issues.push(msg); };

const partners = JSON.parse(fs.readFileSync("data/partners.json", "utf8"));
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const testPartners = {
  ...partners,
  sponsors: [
    { id: "live-builder", name: "Live Builders", category: "Builder", blurb: "x", url: "https://example.com/live", countries: ["kenya"], starts: day(-1), ends: day(30) },
    { id: "old-builder", name: "Old Builders", category: "Builder", blurb: "x", url: "https://example.com/old", countries: ["kenya"], starts: day(-60), ends: day(-1) }
  ]
};

// Fake Cloudflare context: assets served from dist/, with partners.json swapped for the test data.
function ctx(url) {
  const kv = new Map();
  return {
    request: new Request(url),
    params: { provider: decodeURIComponent(new URL(url).pathname.split("/").pop()) },
    waitUntil: () => {},
    env: {
      SENDFAIR_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } },
      ASSETS: {
        fetch: async (u) => {
          const p = new URL(u).pathname;
          if (p === "/data/partners.json") return new Response(JSON.stringify(testPartners));
          const f = path.join(DIST, p);
          return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response("", { status: 404 });
        }
      }
    }
  };
}
const go = async (url) => (await onRequestGet(ctx(url))).headers.get("location");

const base = "https://sendfair.africa/go/";
// Travelpayouts tracked links (Aviasales program 100, Airalo program 541, marker 807652).
check(await go(base + "flights?o=LON&d=NBO&r=fly-kenya") === "https://tp.media/r?campaign_id=100&marker=807652&p=4114&trs=602820&u=" + encodeURIComponent("https://www.aviasales.com/?params=LONNBO1"), "flight link London to Nairobi (tracked Aviasales)");
check(await go(base + "flights?o=LON&d=LOS&r=fly-kenya") === "https://sendfair.africa/", "flight to an airport outside the country must go home");
check(await go(base + "flights?o=XXX&d=NBO&r=fly-kenya") === "https://sendfair.africa/", "unknown origin must go home");
check(await go(base + "esim?r=fly-kenya") === "https://tp.media/r?campaign_id=541&marker=807652&p=8310&trs=602820&u=" + encodeURIComponent(partners.travel.esimUrl), "esim link (tracked Airalo)");
check(await go(base + "live-builder?r=build-kenya") === "https://example.com/live", "live sponsor forwards");
check(await go(base + "old-builder?r=build-kenya") === "https://sendfair.africa/cost-to-build/kenya/", "expired sponsor goes back to the calculator");
check(await go(base + "nobody?r=build-kenya") === "https://sendfair.africa/", "unknown id goes home");
check(/wise\.com/.test(await go(base + "wise?r=uk-kenya") || ""), "transfer providers still redirect");

// Wrapped (affiliate) links encode the destination into {url}.
const wrapped = flightTarget({ ...partners, travel: { ...partners.travel, flightsWrap: "https://tp.media/r?marker=1&u={url}" } }, { origin: "LON", dest: "NBO", receiver: "kenya" });
check(wrapped === "https://tp.media/r?marker=1&u=" + encodeURIComponent("https://www.aviasales.com/?params=LONNBO1"), "flightsWrap encodes the destination");

check(sponsorsFor(testPartners, "kenya").map((s) => s.id).join() === "live-builder", "only live sponsors show");
check(!sponsorLive(testPartners.sponsors[1]), "expired sponsor is not live");

// Built pages
const read = (rel) => fs.readFileSync(path.join(DIST, rel), "utf8");
check(/sponsor-box/.test(read("cost-to-build/kenya/index.html")), "sponsor box on the Kenya calculator");
check(/sponsor-box/.test(read("cost-to-build/kenya/3-bedroom/index.html")), "sponsor box on a size page");
check(/flying-home\/kenya\//.test(read("send-money/uk-to-kenya/index.html")), "route page links to flying home");
check(/go\/flights\?o=LON&amp;d=NBO&amp;r=fly-kenya/.test(read("flying-home/kenya/index.html")), "flying-home page has flight links");
check(/links on the flying-home pages are affiliate links/.test(read("disclosure/index.html")), "disclosure says travel links are affiliate links");
check(/go\/kiwitaxi\?r=fly-kenya/.test(read("flying-home/kenya/index.html")), "flying-home page has airport pickup links");
check(!/go\/klook\?r=fly-ghana/.test(read("flying-home/ghana/index.html")) && /go\/klook\?r=fly-kenya/.test(read("flying-home/kenya/index.html")), "activities only where listed");
check(/advertise\//.test(read("sitemap.xml")) && /flying-home\/kenya\//.test(read("sitemap.xml")), "new pages in the sitemap");

if (issues.length) { console.error("partner test failed:\n  " + issues.join("\n  ")); process.exit(1); }
console.log("partner test: all checks passed");
