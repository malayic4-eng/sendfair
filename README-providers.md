# Provider quotes and the adapter interface

## Where quotes come from today

| Source | Fetch | Stored | Published |
|---|---|---|---|
| Wise comparison API | `scripts/fetch-wise-feed.mjs` | `data/wise-feed.json` | `scripts/apply-wise-feed.mjs` → `data/quotes.json` |
| WorldRemit (legacy scraper) | `scripts/fetch-worldremit.mjs` | `data/worldremit-quotes.json` | merged by `scripts/build.mjs` |
| Extra operators (legacy scraper) | `scripts/fetch-extra.mjs` | `data/extra-quotes.json` | merged by `scripts/build.mjs` |

The internal quote is:

```json
{
  "provider": "lemfi",
  "rate": 1900.5,
  "feeFixed": 0,
  "feePct": 0,
  "payout": ["bank", "mobile"],
  "speed": "Minutes",
  "note": "From LemFi's official partner feed (partner feed); confirm on the provider's site",
  "refAmount": 250,
  "checkedAt": "2026-11-18T16:00:00.000Z",
  "source": "partner-feed",
  "feed": true
}
```

`data/quotes.json` is `{ updatedAt, coverage, quotes: { "uk-nigeria": [quote, ...] } }`.

## The adapter interface

`scripts/providers/`:

- `adapter.mjs` — shared helpers (CSV, numbers, payout aliases, 24-hour freshness).
- `partner-feed.mjs` — `PartnerFeedAdapter`: one official JSON or CSV feed, field mapping from
  `data/adapters/<id>.json`. **It never scrapes a provider website.**
- `wise.mjs` — `WiseFeedAdapter`: the stored Wise feed in the same internal format (run with `--all`).
- `merge.mjs` — `mergeQuotes`: hand checks win, 24-hour drop, mid-market sanity, coverage update.
- `runner.mjs` — `runFeeds`: runs adapters, keeps failure state, alerts after two failures.
- `notify.mjs` — `notifyOwner`: Resend, a webhook, or the failing run.

Run them with:

```sh
node scripts/fetch-provider-quotes.mjs --only=partner   # the six official feeds
node scripts/fetch-provider-quotes.mjs --only=all       # also re-publish the stored Wise feed
node scripts/fetch-provider-quotes.mjs --dry-run        # fetch and print, write nothing
```

## The six partner-feed adapters (disabled by default)

| Provider | Env vars | Feed file config |
|---|---|---|
| LemFi | `LEMFI_FEED_URL`, `LEMFI_FEED_KEY` | `data/adapters/lemfi.json` |
| Sendwave | `SENDWAVE_FEED_URL`, `SENDWAVE_FEED_KEY` | `data/adapters/sendwave.json` |
| Taptap Send | `TAPTAPSEND_FEED_URL`, `TAPTAPSEND_FEED_KEY` | `data/adapters/taptapsend.json` |
| NALA | `NALA_FEED_URL`, `NALA_FEED_KEY` | `data/adapters/nala.json` |
| Afriex | `AFRIEX_FEED_URL`, `AFRIEX_FEED_KEY` | `data/adapters/afriex.json` |
| Mukuru | `MUKURU_FEED_URL`, `MUKURU_FEED_KEY` | `data/adapters/mukuru.json` |

An adapter runs **only when both env vars are set**. With no env vars it logs
`skipped (no env)` and is not counted as a failure. To enable one, add the two GitHub secrets (and
the same variables in Cloudflare if you run it there); no code change is needed.

### Feed config reference (`data/adapters/<id>.json`)

```json
{
  "id": "lemfi",
  "name": "LemFi",
  "provider": "lemfi",
  "kind": "partner-feed",
  "env": { "url": "LEMFI_FEED_URL", "key": "LEMFI_FEED_KEY" },
  "auth": { "header": "Authorization", "prefix": "Bearer " },
  "format": "json",
  "rowsPath": "data.quotes",
  "mapping": {
    "route": "corridor",
    "from": "send_country",
    "to": "receive_country",
    "rate": "rate",
    "fee": "fee",
    "feePct": "fee_pct",
    "payout": "payout",
    "checkedAt": "checked_at",
    "speed": "speed",
    "refAmount": "ref_amount"
  },
  "fromMap": { "GB": "uk", "DE": "europe" },
  "toMap": { "NG": "nigeria", "SN": "senegal" },
  "feePctScale": 0.01,
  "defaults": { "payout": ["bank"], "speed": "" },
  "maxAgeHours": 24,
  "routes": ["uk-nigeria"]
}
```

- `format`: `json` or `csv`. For JSON, `rowsPath` is the dotted path to the array (`""` for a
  top-level array). For CSV, the first row is the header.
- `mapping.route` uses a route string such as `uk-nigeria`; otherwise `mapping.from` + `mapping.to`
  are combined, with `fromMap`/`toMap` translating ISO codes or carrier names to SendFair ids.
- `feePctScale`: `0.01` when the feed gives a percentage (0.5 → 0.005), `1` for a fraction.
- `payout` accepts an array or a string (`bank|mobile`, `bank transfer, cash pickup`), normalised to
  `bank`, `mobile`, `cash`.
- `routes` is optional; omit it to support every route the corridors allow.

## Rules applied by `merge.mjs`

- A quote older than 24 hours is dropped.
- A quote from a provider that does not send from that source market is dropped.
- A rate below 88% or above 103% of the mid-market rate is held back as a likely error.
- A hand-checked quote less than 30 hours old always wins; feed data never overwrites it.
- Partner rows are marked `source: "partner-feed"`, `feed: true` and `note` contains
  **“(partner feed)”** with the feed’s `checkedAt`; `data/quotes.json.coverage` gains the provider so
  the route page lists it.
- `scripts/build.mjs` treats `partner-feed` as automatic (not hand-checked) and shows the feed’s
  checked-at time.

## Failures and the owner alert

`data/adapters/state.json` keeps `consecutiveFailures`, `lastSuccess`, `lastError` and `alerted` per
adapter. On the **second consecutive failure** the owner is emailed once:

- Resend: set `RESEND_API_KEY`, `OWNER_ALERT_EMAIL` (optional `OWNER_ALERT_FROM`).
- Or a webhook: set `OWNER_ALERT_WEBHOOK`.
- If neither is set, the alert is written to `data/adapters/alerts.jsonl` and the run exits 1, so
  GitHub Actions emails the owner as a last resort.

`data/adapters/log.jsonl` gets one line per run with per-adapter `added`, `kept`, `dropped`, errors and
alerts. A success resets the counter and `alerted`. A single failure does not fail the run.

## Workflow

The hourly run is part of "Update rates" (`.github/workflows/update-midmarket.yml`): it runs the tests, then
`--only=partner`, and its changes to `data/quotes.json`, the state and the logs go into that workflow's single
commit, together with the rates, the Wise feed and the WorldRemit quotes.
`.github/workflows/partner-feeds.yml` is now manual only: its `dry_run` input (default true) fetches and logs
but writes nothing; with `dry_run` off it writes and commits like the hourly run.

## Tests

```sh
node scripts/test-adapters.mjs
```

12 checks, no network, using `data/adapters/sample/lemfi.json`, `sendwave.csv`, `taptapsend.json`
and `wise-feed.json`: JSON/CSV mapping, route maps, `feePctScale`, the 24-hour drop, the
“(partner feed)” mark, hand-check precedence, coverage, the two-failure alert, and a guard that the
adapter code contains no Playwright/Puppeteer.

## No scraping

The adapter interface only fetches the URL in its config. The old `fetch-worldremit.mjs` and
`fetch-extra.mjs` are legacy scrapers, outside this interface; retire them once official feeds cover
those providers.
