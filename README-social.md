# SendFair social: Reels first

The daily social post is now **one short vertical Reel**, with image posts only when there is
something worth a still. This replaces the old queue (`scripts/social-posts.mjs` → `post-facebook` /
`post-instagram`), whose two daily cron jobs are now manual-only so they cannot double-post.

## Schedule (`data/social/schedule.json`)

| Key | Default | Meaning |
|---|---|---|
| `reelsPerDay` | 1 | One Reel every day |
| `imagePostDays` | `["tue","fri"]` | Days an image post is allowed |
| `maxPerDay` | 2 | Never more than two automated posts per platform per day |
| `postTimeNairobi` | `17:00` | UK lunchtime, US East Coast morning |
| `templates` | route, best-vs-average, house, tip, rate-move | Rotated, no two days in a row the same |
| `rateMoveThresholdPct` | 1 | A rate-move Reel only when the week moved at least 1% |
| `tiktok` | false | TikTok Direct Post is off until the app is audited |

Routes rotate through `config.priorityRoutes`. Hashtags are per country in
`data/social/hashtags.json`.

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

`.github/workflows/social-weekly.yml` (Mondays 07:00 UTC) reads the log, fetches plays/reach where
the Graph API allows, flags templates under half the average for two weeks, lists the last 14 days'
artifacts and emails it through Buttondown (or prints it if the key is absent).
