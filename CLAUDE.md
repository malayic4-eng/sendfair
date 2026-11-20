# SendFair – project handbook for Claude

Read this first. It records how SendFair works, what has been decided, and what is still open, so any Claude session (from any account) can pick up the work.

## Owner and how to work with him

- Owner: Dr. Caleb Simiyu Malayi ("Wagwan"), Nairobi (EAT, UTC+3). Legal entity: Continental Flow Ltd. Contact on site: hello@sendfair.africa.
- He is not technical. Explain in plain words, give numbered click-by-click steps, and say which browser tab or page.
- Never ask him to paste passwords, API keys, tokens or client secrets into chat. He types those into the page himself.
- He accepts terms of service, consent screens and security settings (Cloudflare Access, Google Cloud ToS) himself. Claude does not.
- Work on a branch, open a PR via the REST API (`gh api repos/malayic4-eng/sendfair/pulls ...`; GraphQL `gh pr create` is blocked), and merge when he has asked for the change.

## What SendFair is

https://sendfair.africa. Two halves:
1. **Send money home**: compares money transfer providers (total cost incl. FX margin) from the UK, US, Canada etc. to African countries. Priority routes in `config.json` → `priorityRoutes`.
2. **Build a house back home**: `/cost-to-build/` calculator, `/material-prices/`, `/same-house/`, guides such as `/when-a-quote-looks-wrong/`, and **Quote Check** (paid quote analysis, NOT open yet).

Also: `/send-money-to/`, country pages, `/follow/` (one link to all socials, with QR).

Brand images: `brand/` (HD logo PNG/SVG, YouTube profile, banner, watermark), rendered by `node scripts/brand-assets.mjs`.

## Tech

- Static build: `npm run build` → `scripts/build.mjs` writes `dist/`. Tests: `npm test`.
- Cloudflare Worker: `src/worker.js` + `functions/`. Config `wrangler.jsonc`. Bindings: `SENDFAIR_KV`, `AI`, `QUOTE_CHECK_FILES` (R2).
- Deploys: Cloudflare Workers Builds from GitHub. Production `npx wrangler deploy`; previews `npx wrangler preview`. Build command for both is `npm run build` (previews failed before this was set).
- Public R2 media: `config.socialMediaBase`; daily reel at `social/<date>/reel.mp4` + `manifest.json`.
- Rates data: Wise Comparison API feed (`scripts/fetch-wise-feed.mjs`, `apply-wise-feed.mjs`), hourly via `.github/workflows/update-midmarket.yml`.
- Admin: `/admin` (Rate Desk) behind Cloudflare Access app "SendFair Rate Desk" plus an admin cookie. `/admin/social` (TikTok/YouTube connect), `/admin/comments` (comment reply drafts), `/admin/quote-checks/`.
- GitHub secrets cannot be set from Claude sessions (API blocked through the proxy), so platform tokens live in KV via the admin pages.

## Social automation

- Workflows: `social-reels.yml` (17:30 UTC daily), `social-posts.yml`, `post-facebook.yml`, `social-weekly.yml` (Mondays: performance + `data/social/weights.json`), `social-comments.yml` (05:00 UTC drafts), `social-token-check.yml`.
- Content: `scripts/social-content.mjs`. Templates in `data/social/schedule.json`: route, house, best-vs-average, material, tip, rate-move. Template picked by `pickTemplate` using weekly weights, with a building-content floor of ~25%.
- **Decision:** do NOT build content only around money transfers. House building and other services get strong engagement. Keep a mix.
- Audience weights for reels: Kenya 3, Nigeria 3, Ghana 3, Uganda 2, Zimbabwe 2.
- Every post/reel ends with "Follow us everywhere: sendfair.africa/follow".
- Facebook: Reel daily; site link goes in the first comment. Instagram: "link in bio" plus a question as first comment. Best single result so far: a Facebook Reel with ~8.2k views.
- **YouTube Shorts:** connected (Nov 2026) on channel "SendFair" @sendfair via Google Cloud project `sendfair`, OAuth client "SendFair Worker". The Worker cron (`*/20 17-21 * * *` UTC) posts the daily reel once. The project is unverified, so uploads may be **private** until YouTube's API audit is passed. Check the "Last 7 days" table on `/admin/social`.
- **TikTok:** not set up. Needs an app at developers.tiktok.com (Login Kit + Content Posting API, redirect `https://sendfair.africa/admin/social/callback/tiktok`), credentials saved on `/admin/social`, then TikTok audit. Posts are private until audited.
- Weekly trends: a scheduled task "SendFair weekly social trends" (Mondays) writes `data/social/trends.json` via vidIQ (building ≥3 items, transfers 2, other 1).
- Possible missing Meta permissions for comments/insights: pages_manage_engagement, instagram_manage_comments, read_insights, instagram_manage_insights.

## Build cost data: rules and known problems

Data: `data/build-costs.json` (17 countries; Kenya = Nairobi). Logic: `src/build-cost.js`. Master research register (owner's spreadsheet, Nov 2026): 327 items in 20 categories, ~116 with a captured price (mainly Integrum 2026 Nairobi/Central handbook, FixIt, Fatali, Muhindi, NCA fee schedule).

Rules:
- Never put an all-in work rate (materials + labour + plant + overhead, e.g. Integrum) and a retail material price in the same total without saying so. Don't compare them.
- Every price needs a source, URL, unit, location and date. Show ranges, and label each line verified / guide / estimate.
- Don't publish generic structural (foundation/steel/concrete) quantities as advice. Point to drawings and an engineer, and a soil test first.

Known problems found Nov 2026, fixed 20 Nov 2026 (PR "Build cost accuracy"):
1. Kenya `wc`, `tank`, `carpenter` now have Kenyan sources (Shabbiri Hardware, CTM, KeNHA Price Reference Guide May 2026). `plumber`, `spark`, `painter` use KeNHA's Nairobi artisan day rates and are marked `guide: true` because KeNHA publishes no trade-specific rate. No Kenya line borrows from Ghana any more.
2. `gutter` and `formwork` carry `"allIn": true`; the receipt shows an "All-in rate" tag and the source says no separate labour is added.
3. Countries can set `pricesDated` (Kenya: "August to November 2026"); the sources panel shows it before the list review date.
4. Sand and ballast have low/typical/high options and state the assumed lorry volume.
5. Shower and sink have a second retailer's options. Basin still comes from one list.
Quote Check fixture for Kenya now matches 17 lines (the water tank has a Kenyan price).

Not priced at all yet: land/legal, site studies, professional fees, most of excavation/foundations as activities, waterproofing, drainage beyond the septic tank, most external works, appliances/solar/security, testing and handover.

## Everything that runs on a schedule

Times are UTC unless marked Nairobi (Nairobi = UTC+3).

**Claude scheduled tasks** (tied to the Claude account that created them; they do NOT move with the repo). The full prompts are in `docs/scheduled-tasks/` so they can be recreated word for word on another account:
| Task | When | What | Prompt |
|---|---|---|---|
| SendFair daily rate check | 09:37 and 19:37 Nairobi daily (evening = backup) | Reads provider rates in the owner's built-in browser, updates `data/quotes.json`, `mid-overrides.json`, Monday Trustpilot ratings, history; pushes; sends a WhatsApp-ready summary. Needs the owner's computer + Claude desktop app on. | `docs/scheduled-tasks/daily-rate-check.md` |
| SendFair weekly social trends | Mondays 09:13 Nairobi | vidIQ scan of trending Shorts/Reels/TikToks (≥3 building, 2 transfers, 1 other), writes `data/social/trends.json`. | `docs/scheduled-tasks/weekly-social-trends.md` |

**GitHub Actions** (in `.github/workflows/`, move with the repo):
| Workflow | When | 
|---|---|
| update-midmarket.yml | hourly at :17 (Wise feed / mid rates) |
| extra-providers.yml | hourly at :30 |
| seo-audit.yml | daily 03:15 |
| price-review.yml | daily 04:30 |
| social-comments.yml | daily 05:00 (comment reply drafts) |
| indexnow.yml | daily 05:41 |
| social-reels.yml | daily 17:30 (makes and posts the daily Reel) |
| social-weekly.yml | Mondays 07:00 (performance report + weights) |
| monthly-report.yml | 1st of month 06:00 |
| freshness.yml | 1st of month 09:00 |
| social-posts, post-facebook, post-launch, social-token-check, partner-feeds | manual only (Run workflow button) |
| pr-check.yml | on every pull request |

**Cloudflare Worker crons** (`wrangler.jsonc`, handled in `src/worker.js` `scheduled`):
| Cron | What |
|---|---|
| 08:30 and 18:30 daily | rate alerts and confirmation emails |
| 03:00 daily | Quote Check purge of old uploads and reports |
| every 20 min 17:00–21:59 | post today's Reel to YouTube Shorts / TikTok once (`functions/social/post.js`) |

If you add, change or delete any of these, update this section and the matching file in `docs/scheduled-tasks/`.

## Open to-do list (as of 20 Nov 2026)

- Build data: next, verify the top 40–50 Nairobi items with dated quotes; add a second basin source.
- Search Console (checked 20 Nov 2026): all 8 main pages are indexed. The ~245 "Crawled – currently not indexed" are long-tail amount pages (/send-money/<route>/<amount>/) and minor-route compare pages; leave them unless they start getting impressions.
- Owner's own steps: Instagram bio link, TikTok website link (app), WhatsApp Channel description, all set to `sendfair.africa/follow`. Claude can't do these: Instagram is signed out in the browser pane and the other two are phone-app only. Note: the Facebook login in the browser pane opens Meta Business Suite for an unrelated page "Onlineshop.com"; don't edit it.
- Check the first YouTube Short and, if private, guide him through the YouTube API audit. Channel set up 20 Nov 2026: description, link to /follow, profile picture, banner, watermark, contact email hello@sendfair.africa. Owner set country of residence and keywords himself.
- TikTok developer app + audit. Blocked on the owner signing up / logging in at developers.tiktok.com (Claude can't create accounts or type passwords); after that Claude can fill in the app form.
- Affiliate programmes with transfer providers; AdSense slots are empty.
- Verify the top 40–50 Nairobi build items with dated quotes, then pilot Quote Check with a small group. Quote Check must only judge lines with a like-for-like benchmark; otherwise say "no benchmark".
- Later: cost-by-house-size pages per country, real-build cost survey, decide depth for non-priority countries.

## History (merged PRs)

#11 audit fixes (data accuracy, slimmer homepage, `/send-money-to/`, noindex near-duplicates, hourly data job, PR checks) · #12 `/follow` page · #13 follow line in posts/reels · #14 daily Facebook reel · #15 engagement automation (posting time, first comments, series, weekly weights, comment drafts, TikTok/YouTube posting) · #16 fix "Forbidden (bad origin)" on `/admin/social` (Referrer-Policy same-origin) · #17 this handbook · #18 schedule list and scheduled-task prompts · #19 YouTube (@sendfair) added to footer, /follow page and site structured data (`config.youtubeUrl`) · #20 /follow title · #21 brand assets · #25 build cost accuracy (Kenyan sources, all-in tags, price dates, ranges).

Keep this file up to date when something important changes.
