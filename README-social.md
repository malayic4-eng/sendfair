# SendFair social: Reels and carousels

The daily social post is **one short vertical Reel on four days and an Instagram carousel on three**
(Reels for reach to new people, carousels for saves and depth with people who already follow). This replaces the old queue (`scripts/social-posts.mjs` → `post-facebook` /
`post-instagram`), whose two daily cron jobs are now manual-only so they cannot double-post.

## Schedule (`data/social/schedule.json`)

| Key | Default | Meaning |
|---|---|---|
| `reelsPerDay` | 1 | One Reel on every day that is not a carousel day |
| `carouselDays` | `["tue","thu","sat"]` | Days that post a 4-slide carousel instead of a Reel on Instagram and Facebook |
| `imagePostDays` | `[]` | Days a single image is posted. Empty now; a single image is still the fallback if a Reel or carousel fails |
| `maxPerDay` | 2 | Never more than two automated posts per platform per day |
| `postTimeNairobi` | `17:00` | UK lunchtime, US East Coast morning |
| `templates` | route, best-vs-average, house, tip, rate-move | Rotated, no two days in a row the same |
| `rateMoveThresholdPct` | 1 | A rate-move Reel only when the week moved at least 1% |
| `tiktok` | false | TikTok Direct Post is off until the app is audited |

Routes rotate through `config.priorityRoutes`. Hashtags are per country in
`data/social/hashtags.json`.

## Carousel days

On a `carouselDays` weekday the plan gets a carousel of 5–7 slides at 1080×1350 (4:5), rendered with
the same renderer, Figtree fonts, country palette, header, flag, provider logos and the **same two
4K country photos** the Reel would use that day (same per-country rotation in `data/social/photos.json`):

1. Hook over the day's first photo, with a swipe cue
2. One figure per slide (the same ranked numbers as the Reel), with the provider logo
3. "What this means": one plain sentence whose every figure comes from those numbers
4. Save and share over the day's second photo

Slides are encoded to JPEG (Instagram accepts JPEG only) at `-q:v 2` with 4:4:4 chroma, uploaded to
R2 as `social/<date>/carousel-N.jpg`.

- **Instagram**: native carousel (child containers with `is_carousel_item=true`, a `CAROUSEL` parent,
  then `media_publish`). Counts as one post toward the 50-a-day limit. Music cannot be attached to
  carousels through the API (Reels only).
- **Facebook Page**: the cover slide as a single photo. Multi-photo posts are not wired up yet.
- **TikTok**: unchanged, still gets the Reel every day (flag is off).
- The Reel is still rendered and archived on carousel days for hand-posting.
- Idempotency keys `instagram-carousel` and `facebook-carousel`; log `type` is `carousel`. If the
  carousel fails, Instagram posts the cover slide as an image and records `fallback: true`.

To change the mix, edit `carouselDays` only.

## Trial Reels and trending audio (Instagram)

| Key | Default | Meaning |
|---|---|---|
| `igTrialReels` | true | Post Instagram Reels as Trial Reels (`trial_params`). Reels only |
| `igTrialGraduation` | `SS_PERFORMANCE` | Share with followers automatically if the Reel performs well; `MANUAL` waits for you in the app |
| `igAudioTrendingFirst` | true | Try Instagram's trending audio first, then the `igAudioQueries` genres |

Trial Reels are shown to non-followers first and stay off the grid and followers' feeds unless they
graduate. If Instagram refuses `trial_params` (for example an account that is not eligible yet), the
Reel is posted as a normal Reel and the log shows `trial: false`. Set `igTrialReels` to false to
stop trial posting.

## Daily flow

1. `scripts/social-content.mjs` builds `data/social/plan.json` from the same data and ranking as the
   site (`R.rank` with the same stale/hide rules and mid-market overrides). The plan holds the
   hook, the on-screen numbers, captions and links for Instagram (`?ref=ig`), Facebook (`?ref=fb`)
   and TikTok (`?ref=tt`).
2. `scripts/social-reel.mjs` renders 1080×1920 stills (indigo/marigold, SF logo, 90 px safe margin,
   text clear of the bottom 300 px) and encodes them with ffmpeg (`libx264`, `-preset veryfast`,
   `-an`, 30 fps, 12–20 s). It also writes the 1080×1920 cover, the 1080×1350 image post, the three
   captions and a manifest.
3. `.github/workflows/social-reels.yml` runs every day at 14:00 UTC (17:00 Nairobi), uploads the
   Reel to R2, publishes, uploads the Reel + cover + image + captions as a 30-day artifact, and
   commits `data/social/log.json`.

## Publishing

- **Instagram**: `media_type=REELS`, `video_url`, `caption`, `share_to_feed=true`; poll
  `status_code` until `FINISHED`, then `media_publish`.
- **Facebook Page**: `video_reels` start → upload → finish with
  `video_state=PUBLISHED` and the description (the caption includes the full `?ref=fb` URL, not just a
  link attachment).
- **TikTok**: off by default. When `schedule.tiktok` is true and `TIKTOK_ACCESS_TOKEN` is set, the
  Direct Post flow runs. TikTok only allows public posting after the developer app passes TikTok's
  audit; until then posts can only be private. While the flag is off, the MP4, cover and caption are
  saved in `data/social/tiktok/<date>/` and attached to the workflow run for a one-minute manual
  upload.

## R2 (public video URL)

Meta needs a public URL for the video and cover. Create an R2 bucket with a public domain (or a
signed URL) and set:

- Repository **variable** `R2_PUBLIC_BASE` — e.g. `https://cdn.sendfair.africa`
- Secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET`

The workflow uploads `social/<date>/reel.mp4`, `cover.png` and `image.png` with
`npx wrangler r2 object put`. Without `R2_PUBLIC_BASE` the workflow still renders and archives the
Reel but skips publishing.

## Other secrets

`FB_PAGE_ID`, `FB_PAGE_TOKEN` (Page/System-user token with `pages_manage_posts`,
`instagram_basic`, `instagram_content_publish`), optional `TIKTOK_ACCESS_TOKEN`, and
`BUTTONDOWN_API_KEY` for the weekly summary.

## Dry run

```sh
node scripts/social-content.mjs
node scripts/social-reel.mjs
DRY_RUN=1 node scripts/social-publish.mjs
```

The workflow's `workflow_dispatch` has a `dry_run` input (default true) that renders, writes the log
and calls no publishing API.

## Idempotency and logging

Every attempt is appended to `data/social/log.json` with platform, type (reel/image), post id,
template, route, status and error. The key is `sha256(platform|route|date|template)`; an entry with
status `posted` makes a rerun skip that platform. If a Reel fails to render or publish, the publisher
posts the 4:5 image instead and records `fallback: true`; nothing is posted twice.

## Test

```sh
node scripts/test-reel.mjs
```

It renders one Reel of each template locally (no posting) and checks duration 12–20 s, 1080×1920, no
audio track, under 15 MB, the 4:5 image, and that every on-screen final number matches the site's
ranking. Without ffmpeg it validates the stills and the manifest and says so.

## Weekly summary

`.github/workflows/social-weekly.yml` (Mondays 07:00 UTC) runs `scripts/social-weekly.mjs`:

- Fetches per-post metrics for posts from the last 28 days (Instagram: views, reach, likes, comments,
  saves, shares; Facebook Reels: plays, reach, reactions, comments, shares; Facebook photos: views,
  reach, reactions, comments, shares) and stores them in `data/social/performance.json`. Every call is
  non-fatal; refused metrics or permissions are listed in the report.
- Ranks by content type (transfers / building / other), template, route and platform, lists the top 3
  posts with links and one "what to do more of" line. If `data/social/trends.json` exists, a
  "Trending in your niche" section is added.
- Writes `data/social/weights.json` (28 days, bounded 0.5–2.0, 1.0 until a bucket has 3 posts).
  `scripts/social-weights.mjs` exports `pickTemplate(date, templates, weights)`: the plain rotation
  when there are no weights, otherwise a date-seeded weighted pick that never repeats yesterday's
  template and keeps building content at 25% or more of picks (15% only when 28 days of data clearly
  show it underperforming).
- Sends a Buttondown draft with a preview to `SOCIAL_REPORT_EMAIL` as before; if Buttondown is not set
  up or fails, the text goes to the owner through Resend/webhook (`scripts/providers/notify.mjs`).

Token permissions for metrics: `read_insights` (Facebook post/video insights), `pages_read_engagement`
(reactions, comments, permalinks), `instagram_manage_insights` (Instagram insights). Without them the
report still runs and lists what was missing.

## Comment replies

`.github/workflows/social-comments.yml` (daily 05:00 UTC) runs `scripts/social-comments.mjs`, which
reads the last 3 days of comments on our Facebook and Instagram posts and uploads
`social/comments.json` (only public fields: name/username, text, time, permalink) to the public R2
bucket. `/admin/comments` (behind the Rate Desk sign-in) lists unanswered comments with an AI reply
draft (Workers AI, cached 7 days in KV) and Copy, Open comment, Regenerate and Mark done buttons.
Replies are never posted automatically. Needs `pages_read_engagement` / `pages_read_user_content`
(Facebook) and `instagram_manage_comments` (Instagram) on the token.

`.github/workflows/social-weekly.yml` (Mondays 07:00 UTC) reads the log, fetches plays/reach where
the Graph API allows, flags templates under half the average for two weeks, lists the last 14 days'
artifacts and emails it through Buttondown (or prints it if the key is absent).

## TikTok and YouTube Shorts from the Worker (`/admin/social`)

The Worker posts the day's Reel itself, so no GitHub or Worker secrets are needed. The owner opens
`https://sendfair.africa/admin/social/` (Rate Desk sign-in), saves the TikTok and Google app
credentials, presses **Connect**, and the page holds step-by-step setup instructions.

- Cron `*/20 17-21 * * *` (UTC) reads `<socialMediaBase>/social/<Nairobi date>/manifest.json`; when it
  exists, it streams `reel.mp4` straight into TikTok (Direct Post, `FILE_UPLOAD`, one chunk) and
  YouTube (resumable upload, `#Shorts` title from `manifest.captions.youtube`).
- Credentials, tokens, OAuth state and results live in `SENDFAIR_KV` (`social:*`, `posted:<platform>:<date>`).
  A day is claimed (`in-progress`) before uploading; failed runs retry up to 3 times a day; an
  interrupted upload is not retried automatically (use **Post today's Reel now**).
- Keep `schedule.tiktok` false for the GitHub TikTok path while the Worker posts to TikTok, or TikTok gets the Reel twice.
- Code: `functions/social/`; test: `node scripts/test-social-connect.mjs`.
