// Read-only check of FB_PAGE_TOKEN: which Page and Instagram account it reaches, and its permissions.
// Posts nothing. Run by .github/workflows/social-token-check.yml.
const v = process.env.FB_GRAPH_VERSION || "v22.0", pageId = process.env.FB_PAGE_ID, token = process.env.FB_PAGE_TOKEN;
if (!pageId || !token) { console.error("FB_PAGE_ID / FB_PAGE_TOKEN not set."); process.exit(1); }
const g = (p) => fetch(`https://graph.facebook.com/${v}/${p}${p.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`).then((r) => r.json());
const me = await g("me?fields=id,name");
const perms = await g("me/permissions");
const granted = (perms.data || []).filter((p) => p.status === "granted").map((p) => p.permission);
const accounts = await g("me/accounts?fields=id,name");
const page = (accounts.data || []).find((p) => String(p.id) === String(pageId));
const pageInfo = await g(`${pageId}?fields=name,instagram_business_account{username}`);
const need = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "instagram_basic", "instagram_content_publish"];
const missing = need.filter((p) => !granted.includes(p));
console.log(`Token user: ${me.name || me.error && me.error.message}`);
console.log(`Permissions granted: ${granted.join(", ") || "(none listed)"}`);
console.log(`Page ${pageId} in /me/accounts: ${page ? "yes (" + page.name + ")" : "no"}`);
console.log(`Page name: ${pageInfo.name || JSON.stringify(pageInfo.error)}; Instagram: ${pageInfo.instagram_business_account ? "@" + pageInfo.instagram_business_account.username : "not linked"}`);
if (missing.length || !page) { console.error(`Missing for posting: ${missing.join(", ") || "page not listed"}`); process.exit(1); }
console.log("OK: the token can post reels and images to the Page and Instagram.");
