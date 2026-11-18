# SendFair

Money transfer comparison for the African diaspora: 5 sending countries/regions (US, UK, Canada, Australia, Europe) × 17 receiving countries (Nigeria, Ghana, Kenya, Uganda, Zambia, Zimbabwe, Egypt, Morocco, Senegal, Côte d'Ivoire, Mali, Cameroon, Ethiopia, South Africa, Tanzania, DR Congo, Rwanda) = 85 route pages. Services are ranked by how much the family actually receives, and every quote is refreshed automatically from Wise's comparison data.

The Gulf guide at `/send-money-from-the-gulf/` compares the ways of sending from the Gulf (exchange houses, bank remittance services, mobile wallets, apps, cash networks) using the quotes you enter on Gulf routes.

Hosting is free (Cloudflare Pages). The only fixed running cost is the domain, about $10–15 a year. Quote Check adds per-order payment and AI extraction costs, described in its section below.

---

## What's in this folder

| Path | What it is |
|---|---|
| `config.json` | Site name, domain, email, daily routes, and switches for ads, alerts, click tracking and delivery reports |
| `data/providers.json` | The 35 transfer services. **Paste affiliate links here** once approved. `sendsFrom` = countries each one sends from; `type` = app, exchange, bank, wallet or network (used on the Gulf guide) |
| `data/quotes.json` | Daily quotes. Written by the Rate Desk, don't edit by hand |
| `data/midmarket.json` | Market reference rates, updated automatically |
| `data/corridors.json` | Countries, currencies and ways to receive |
| `src/` | Styles, fonts, the ranking engine (`rank.js`), page script, Rate Desk (`admin.html`), share images (`og/`) |
| `config/quote-check.json`, `data/quote-check/`, `src/quote-check/`, `functions/quote-check/` | The paid Quote Check service: fee and thresholds, editable synonyms, sample fixtures, matching, extraction, payments, report and admin. See the Quote Check section below. |
| `functions/`, `src/worker.js`, `wrangler.jsonc` | Small server functions for delivery reports, click counting and click stats, and Cloudflare's deploy settings |
| `scripts/` | Site build, rate fetchers |
| `tools/make-og.py` | Regenerates share images if you ever add countries |
| `.github/workflows/` | Automatic reference-rate updates |

---

## One-time setup (about 1 hour)

### 1. Buy the domain
Check `sendfair.co`, `sendfair.africa` or `getsendfair.com` at Namecheap or Cloudflare Registrar. In `config.json` set `siteUrl` (e.g. `https://sendfair.co`) and `contactEmail`.

### 2. Put the code on GitHub
1. Create a free account at github.com.
2. **New repository** → name it `sendfair` → create.
3. Click **uploading an existing file** and drag in everything from this folder, including the hidden `.github` folder and `.nvmrc` (on Mac press Cmd+Shift+. in Finder to see hidden files). Commit.
4. **Settings → Actions → General → Workflow permissions** → **Read and write permissions** → Save.
5. **Actions → Update reference rates → Run workflow** once.

### 3. Publish with Cloudflare (Workers)
1. Free account at dash.cloudflare.com.
2. **Workers & Pages → Create application → Import a repository** → pick `sendfair` → **Deploy**. All settings (build step, pages folder, storage) come from `wrangler.jsonc`, so leave the build fields as they are.
3. You get a free `sendfair.<your-name>.workers.dev` address.
4. Your domain: open the `sendfair` Worker → **Settings → Domains & Routes → Add → Custom domain**.

Every change in the repository (including each Rate Desk publish) rebuilds the site. If a data file ever has a mistake, the build stops with a plain list of what to fix, and the previous version stays live.

### 4. Token for the Rate Desk
1. GitHub → photo → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Only select repositories → `sendfair`. Permissions: **Contents → Read and write**. Expiry: 90 days (set a reminder to renew).
3. Open `https://yourdomain/admin/`, fill in step 1 and press **Save settings**. The token stays only in your browser.

### 5. Lock the Rate Desk (recommended, free)
Cloudflare dashboard → **Zero Trust → Access → Applications → Add an application → Self-hosted**. Application domain: `yourdomain` with path `admin`. Policy: **Allow**, include **Emails** → your email. You'll get a one-time code by email when you open `/admin/`.

---

## Daily routine (about 30–45 minutes)

1. Open `https://yourdomain/admin/`. The coloured chips show progress: green done, yellow partly done, **bold** = daily routes.
2. Pick a route. Yesterday's numbers are filled in, with how long ago each was checked.
3. For each provider, open its calculator for the **reference amount** shown (£250, $300, C$400, A$450; AED/SAR/QAR 1,000; KWD/BHD/OMR 100) and type:
   - **They get**: the amount the provider says arrives. The rate is worked out for you. (Or type the rate directly.)
   - **Fixed fee** and/or **% fee** in the sending currency. On UAE, Saudi, Bahrain and Oman routes, type the fee **including VAT** (the Rate Desk reminds you).
   - **Receive by**: tick at least one.
   - **Variant**: only if the provider gives a different rate for, say, mobile money vs bank. Use **+ variant** for a second row.
4. Any row you edit is ticked **Checked today**. Untouched rows keep their old time, so the site honestly shows "Not rechecked today" for them.
5. The **Check** column flags likely typos.
6. **Save and go to next route.** Providers you leave empty are dropped from that route, so tomorrow's list is shorter. **Add a provider** brings one back.
7. **Publish to live site** when done.
8. **Today's post** → **Write post** → **Copy**, and paste into your WhatsApp groups, Facebook groups and channel.

Do the 8 daily routes every day (set in `config.json` → `priorityRoutes`) and the other routes every second day.

How the site treats age: older than 36 hours shows "Not rechecked today", ranks below fresh quotes and never gets "Most money home". Older than 72 hours is hidden.

---

## Making money

### Affiliate links
When a program approves you, open `data/providers.json` on GitHub (pencil icon), paste the link into that provider's `affiliateUrl`, commit. If the network supports a tracking or sub-ID parameter, put `{route}` there (for example `...&subid={route}`) and each route's earnings show separately in the network's reports.

### Google AdSense (UK visitors need a consent message)
1. Apply at adsense.google.com after 20–30 days live with traffic.
2. **Before turning ads on:** in AdSense open **Privacy & messaging** and publish the **European regulations** consent message. Google requires a certified consent message for visitors in the UK and Europe; its own one is free.
3. Put your `ca-pub-…` ID into `config.json` → `adsenseClient`. The privacy page updates itself.

### Rate alerts
Create a free list on MailerLite or Buttondown. Put its form action URL in `newsletterFormAction` and its name (e.g. `MailerLite`) in `emailProvider`, so the privacy page names it. Or create a WhatsApp Channel and put its link in `whatsappChannelUrl`.

---

## Optional features (switch on when ready)

### Delivery-time reports and click tracking
Both are switched on and already connected to the `sendfair` storage space (see `wrangler.jsonc`).

To see click counts in the Rate Desk: open the `sendfair` Worker → **Settings → Variables and Secrets → Add** → type **Secret**, name `STATS_KEY`, value a long random password. Put the same value in the Rate Desk's "Stats key".

Reports: visitors pick a service and how long it took. After 3 reports in two months, the route shows "Usually arrives: ..." for that service. One report per visitor per service per day; IP addresses are never stored.

Clicks: "Go to" buttons pass through `/go/...`, which counts the click and forwards to your affiliate link.

To switch either off, set `reportsEnabled` or `trackClicks` to `false` in `config.json`.

### Wise comparison feed (automatic)
If you get a Wise API token (Wise account → Settings → API tokens), add it in GitHub → **Settings → Secrets and variables → Actions → New repository secret** named `WISE_API_TOKEN`. Every 30 minutes the workflow fetches Wise's collected quotes for many providers and publishes them automatically, marked "(auto)" on the site. If the first run shows errors in the Actions log, send them to me.

### Analytics
Cloudflare → **Web Analytics** → add site → copy the token into `cfAnalyticsToken`. It uses no cookies.

---

## Quote Check (paid builder-quote review)

Quote Check is a paid service at `/quote-check/`, with a landing page for each of the 17 countries (`/quote-check/kenya/`, `/quote-check/nigeria/`, and so on). A visitor uploads a builder's quote (PDF, JPG/PNG photo, XLSX or CSV). SendFair extracts the lines, matches them to the same published prices behind `/cost-to-build/<country>/`, and shows a free preview: number of line items, quote total, and how many lines can be matched. The line-by-line report unlocks after a verified one-off payment.

The whole feature is behind `QUOTE_CHECK_ENABLED`. It is **off by default**.

### What is in the feature

| Path | What it is |
|---|---|
| `config/quote-check.json` | Fee per currency, verdict thresholds, upload limits, retention, safe quantity assumptions |
| `data/quote-check/synonyms.json` | Owner-editable local names for each price item (`mabati`, `sandcrete blocks`, `sharp sand`, …) and the do-not-price list |
| `data/quote-check/fixtures/` | Three sample quotes (Kenya, Nigeria, Ghana) with expected reports; one XLSX bill of quantities for the parser test |
| `src/quote-check/` | Extraction validation, catalogue, matching, quantity checks, verdict bands, analysis, PDF writer |
| `functions/quote-check/` | Upload, extraction, storage, payments, webhooks, report page, admin API, purge |
| `src/quote-check.js`, `src/quote-check.css` | Upload page script and styles |
| `src/quote-check-admin.html` | The owner's `/admin/quote-checks/` screen |
| `test/` | Automated tests for validation, matching, bands, fixtures, PDF, XLSX and the full API flow |

### Turn it on

The flag is checked twice:

1. **At build time** (`node scripts/build.mjs`): when off, the Quote Check pages are still written for review but carry `noindex`, the calls-to-action are left out of the home page and the house calculator, and the upload form is disabled. When on, the pages are indexable and the links appear.
2. **At runtime** (the Worker): when off, `/api/quote-check/upload`, checkout, test-pay and webhooks refuse with 503.

To review locally:

```bash
QUOTE_CHECK_ENABLED=true QUOTE_CHECK_TEST_MODE=true node scripts/build.mjs
```

To go live on Cloudflare:

1. Worker → **Settings → Variables and Secrets** → add `QUOTE_CHECK_ENABLED` = `true` (plain text).
2. Set the build environment variable `QUOTE_CHECK_ENABLED=true` for the Worker build (Settings → Build → Variables) and deploy, so the pages and links are built switched on.
3. Set the other variables below.
4. Do one live payment, confirm the order shows **paid** and the owner email arrives, then refund that test payment from the provider dashboard.

When off, visitors who open `/quote-check/` directly see the pitch and a "not open yet" notice, and nothing can be uploaded or charged.

### Environment variables and secrets

| Name | Where | What it does |
|---|---|---|
| `QUOTE_CHECK_ENABLED` | Worker var + build var | `true` turns uploads, payments, links and indexing on. Default off. |
| `QUOTE_CHECK_TEST_MODE` | Worker var + build var | `true` uses the sample fixtures and the visible test checkout. No card is charged. |
| `PAYMENT_PROVIDER` | Worker var | `paystack` or `flutterwave`. Ignored while test mode is on. |
| `PAYSTACK_SECRET_KEY` | Worker secret | Paystack secret key (`sk_live_…` or `sk_test_…`). |
| `FLUTTERWAVE_SECRET_KEY` | Worker secret | Flutterwave secret key (`FLWSECK-…`). |
| `FLUTTERWAVE_SECRET_HASH` | Worker secret | The hash you set in the Flutterwave webhook settings. |
| `LLM_PROVIDER` | Worker var | `openai`, `anthropic`, `google` or `mock`. Default `openai`; test mode forces `mock`. |
| `LLM_API_KEY` | Worker secret | Key for the extraction provider (or use `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`). |
| `LLM_MODEL` | Worker var | Model id, for example `gpt-4o` or a Claude or Gemini vision model. |
| `LLM_BASE_URL` | Worker var (optional) | An OpenAI-compatible base URL, for example an OpenRouter endpoint. |
| `QUOTE_CHECK_OWNER_EMAIL` | Worker var (optional) | Where paid-order emails go. Defaults to `ownerEmail` in `config/quote-check.json`. |
| `ADMIN_PASSWORD` | Worker secret (already used) | Protects both `/admin/` and `/admin/quote-checks/`. |

Private upload storage:

1. Cloudflare → **R2 → Create bucket** → name it `sendfair-quote-check`.
2. In `wrangler.jsonc`, uncomment the `r2_buckets` line.
3. Deploy. Without R2, Quote Check falls back to the existing KV namespace and refuses files over 18 MB.

Email uses the existing `EMAIL` binding in `wrangler.jsonc`. The domain must be onboarded for Cloudflare Email Sending (`send_email` binding) before the PDF email will send.

### How to set the fee and the verdict bands

Edit `config/quote-check.json`:

```json
"prices": { "KES": 1500, "NGN": 12000, "GHS": 120, "USD": 12, "GBP": 9, "EUR": 10 }
```

A quote in one of those currencies pays that fee. A quote in any other currency (UGX, ZMW, XOF, …) pays the `defaultPriceCurrency` fee (USD by default). The landing page and checkout show the same figure.

Each order also costs the payment provider's fee and one LLM extraction call. Set the prices above those costs; the report does not add a hidden charge.

Verdict bands:

```json
"thresholds": { "below": -0.15, "above": 0.15, "wellAbove": 0.35 }
```

- Below typical: difference below −15%
- Within typical range: −15% to +15%
- Above typical: +15% to +35%
- Well above typical: above +35%

Other useful settings: `retentionDays` (default 30), `limits` (files, size, rate limits), `quantityTolerance` (default 40%), and the safe conversion assumptions (`roofSheetM2`, `steelBarKg`, `lorryM3`). Do not add a conversion unless the published source supports it; anything outside the list is reported as "not checked".

### How to switch the payment provider to live

**Paystack (Kenya-based merchant):**

1. Create the account and complete the Kenya business verification.
2. Copy the secret key into the Worker secret `PAYSTACK_SECRET_KEY`.
3. In Paystack → Settings → API Keys & Webhooks, set the webhook URL to `https://sendfair.africa/api/quote-check/webhook/paystack`.
4. Set `PAYMENT_PROVIDER=paystack`, `QUOTE_CHECK_TEST_MODE=false`, `QUOTE_CHECK_ENABLED=true`.
5. Make one small live payment. The webhook is only a notification: SendFair calls Paystack's verify endpoint and checks the amount and currency before releasing the report.
6. Refund the test payment from Paystack.

**Flutterwave:**

1. Copy the secret key into `FLUTTERWAVE_SECRET_KEY`.
2. Set a secret hash in the Flutterwave dashboard and put the same value in `FLUTTERWAVE_SECRET_HASH`.
3. Set the webhook URL to `https://sendfair.africa/api/quote-check/webhook/flutterwave`.
4. Set `PAYMENT_PROVIDER=flutterwave`, `QUOTE_CHECK_TEST_MODE=false`, `QUOTE_CHECK_ENABLED=true`.
5. Make one live payment, confirm the report and owner email, then refund it from Flutterwave.

Paystack supports NGN, GHS, KES, ZAR and USD. If the visitor's quote currency is GBP or EUR, Checkout charges the USD fee instead (the UI shows the charge currency before payment). Flutterwave supports a wider list. The provider module is `functions/quote-check/payments.js`; add another provider there and to `PROVIDERS`.

### How extraction works

- The provider is swappable (`openai`, `anthropic`, `google`, `mock`). The key stays in the Worker environment.
- The prompt asks for a strict JSON object: `currency`, `quote_total`, and `line_items` with `description`, `quantity`, `unit`, `unit_price`, `line_total`, `currency`.
- Code, not the model, validates every number: it recomputes quantity × unit price, adds the lines, compares the written total, and records arithmetic errors in the quote itself. The recalculated line totals are used for the comparison.
- CSV and XLSX are parsed locally. PDFs and photos go to the vision model.
- The model is told never to invent a price or a quantity. If a figure is unreadable it returns `null`, and the line is handled honestly.

In test mode the extractor returns the matching fixture for Kenya, Nigeria or Ghana, so the full flow can be reviewed without an API key.

### How matching works

`data/quote-check/synonyms.json` maps local terms to the item keys in `data/build-costs.json`. Add words your builders use under `global` or `countries.<id>`. The `exclude` list is for things SendFair does not price (architect, contractor's fee, land, survey).

A line is compared only when:

- the description matches one item with a clear score (a weak or ambiguous match is "not checked"), and
- the unit matches, or one of the safe conversions applies (tonne ↔ kg, ft ↔ m, ft² ↔ m², sheet ↔ m² for roofing at 2.7 m², bar ↔ kg for 12 mm steel at 10.65 kg, lorry load ↔ m³ for sand/ballast).

A price scaled from another country (for example Nigerian timber using a Kenya guide) is **never** used for a verdict; that line is listed as "no local price". A local guide price is shown with a "guide" label. Unit mismatches are "not checked", not guessed.

To change a match by hand, use `/admin/quote-checks/` → open an order → **Edit** on a line. Changing the description to the catalogue label re-runs the matcher; changing quantity, unit or price corrects what the extraction read. Then resend the report.

### The report

The private report is at `/quote-check/report/<unguessable-token>/`. Before payment it shows only the free preview counts. After verified payment it shows:

- quote total vs the SendFair estimate for the matched items, in money and percent;
- the verdict band;
- every matched line with the quoted unit price, our typical unit price and the "prices checked" date;
- every unmatched line separately as "not checked", with the reason;
- quantity checks phrased as "ask your builder";
- generated questions to ask the builder;
- the disclaimer and the list of what is not covered.

The same report is built as a PDF and emailed to the customer. The owner gets one email per paid order. The admin can resend the report, re-run extraction, edit a line or mark an order refunded.

### Privacy and deletion

Uploads and report PDFs go to private storage (R2 or KV). They are never served from a public URL. A daily 03:00 UTC cron runs `runPurge`: it deletes the uploaded files, extracted data, report and PDF `retentionDays` after the report (default 30). A minimal order record keeps the payment reference, amount, status and dates for accounting; the customer email, town, files and extraction are removed. The privacy page has a Quote Check section covering the Kenya Data Protection Act 2019 and GDPR/UK GDPR.

### Tests

```bash
npm test
```

Or, if your environment blocks the Node test runner's child processes, run each file directly:

```bash
node test/quote-check.test.mjs
node test/quote-check-api.test.mjs
```

The tests cover unit conversions, extraction arithmetic validation, synonym matching, the four verdict bands, the three country fixtures against their expected reports, quantity flags, PDF structure, XLSX parsing, and a full API flow with a mock KV, a test payment, the report page, the PDF route, both emails and the admin edit/resend/refund actions.

### Tuning the landing pages

The page copy, country links, sample report and FAQ are generated by `quoteCheckPage()` in `scripts/build.mjs`. The fee is never typed into the copy; it comes from `config/quote-check.json`. The sample report is labelled as an example and uses a Kenya fixture, not a real customer.

---

## Before launch checklist

- [ ] `siteUrl` and `contactEmail` set
- [ ] Reference-rate workflow has a green tick in Actions
- [ ] The 8 daily routes have today's quotes
- [ ] Rate Desk locked with Cloudflare Access
- [ ] Opened a route page on your phone and shared it to yourself on WhatsApp (check the preview image)
- [ ] Submitted `https://yourdomain/sitemap.xml` in Google Search Console

---

## Quote format (for reference)

```json
{ "provider": "worldremit", "variant": "Mobile money", "rate": 168.4, "feeFixed": 1.99, "feePct": 0,
  "payout": ["mobile"], "speed": "Minutes", "note": "", "refAmount": 250, "checkedAt": "2026-11-12T08:30:00Z" }
```

## Preview build

`node scripts/build.mjs --demo --preview --out preview` builds a copy filled with made-up example quotes, clearly bannered, for showing people how it works. Never deploy that version.
