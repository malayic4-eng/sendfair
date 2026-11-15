// Tells Bing (and other IndexNow search engines: Yandex, Seznam, Naver) about every page in the sitemap,
// so new and updated pages get crawled quickly. The key file is served at /<key>.txt to prove ownership.
// Run once a day by .github/workflows/indexnow.yml (and on demand).
const KEY = "058640bd53ad01bd934b671764bc57dd";
const HOST = "sendfair.africa";
const xml = await (await fetch(`https://${HOST}/sitemap.xml`)).text();
const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (!urls.length) { console.log("No URLs found in the sitemap"); process.exit(1); }
const res = await fetch("https://www.bing.com/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls.slice(0, 10000) })
});
const body = (await res.text()).slice(0, 300);
console.log(`IndexNow: submitted ${urls.length} URLs, response ${res.status} ${res.statusText} ${body}`);
// Bing answers 403 SiteVerificationNotCompleted while it is still checking a new key. That is a wait, not a fault,
// so the job passes and tries again tomorrow. Any other error still fails the job.
if (res.status === 403 && body.includes("SiteVerificationNotCompleted")) {
  console.log("::notice::Bing is still verifying the IndexNow key. Nothing to fix; it will retry tomorrow.");
  process.exit(0);
}
if (res.status >= 400) process.exit(1);
