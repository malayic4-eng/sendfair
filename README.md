# SendFair

Money transfer comparison for the African diaspora: 10 sending countries (US, UK, Canada, Australia, plus the Gulf: UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, Oman) × 6 receiving countries (Nigeria, Ghana, Kenya, Uganda, Zambia, Zimbabwe) = 60 routes. Services are ranked by how much the family actually receives.

The Gulf guide at `/send-money-from-the-gulf/` compares the ways of sending from the Gulf (exchange houses, bank remittance services, mobile wallets, apps, cash networks) using the quotes you enter on Gulf routes.

Hosting is free (Cloudflare Pages). The only running cost is the domain, about $10–15 a year.

---

## What's in this folder

| Path | What it is |
|---|---|
| `config.json` | Site name, domain, email, daily routes, and switches for ads, alerts, click tracking and delivery reports |
| `data/providers.json` | The 24 transfer services. **Paste affiliate links here** once approved. `sendsFrom` = countries each one sends from; `type` = app, exchange, bank, wallet or network (used on the Gulf guide) |
| `data/quotes.json` | Daily quotes. Written by the Rate Desk, don't edit by hand |
| `data/midmarket.json` | Market reference rates, updated automatically |
| `data/corridors.json` | Countries, currencies and ways to receive |
| `src/` | Styles, fonts, the ranking engine (`rank.js`), page script, Rate Desk (`admin.html`), share images (`og/`) |
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

Do the 8 daily routes every day (set in `config.json` → `priorityRoutes`) and the other 16 every second day.

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

### Wise comparison feed (saves typing)
If you get a Wise API token (Wise account → Settings → API tokens), add it in GitHub → **Settings → Secrets and variables → Actions → New repository secret** named `WISE_API_TOKEN`. Every 6 hours the workflow saves Wise's collected quotes for many providers, and the Rate Desk shows them as **Feed** suggestions with a **Use** button. Always compare with the provider's own calculator before accepting. This part could only be tested once a token exists; if the first run shows errors in the Actions log, send them to me.

### Analytics
Cloudflare → **Web Analytics** → add site → copy the token into `cfAnalyticsToken`. It uses no cookies.

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
