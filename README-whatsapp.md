# WhatsApp rate bot

SendFair answers a WhatsApp message such as **UK Nigeria 300** with today's top three services, the
best fee and rate, the time the prices were checked, and a link to the amount page (`?ref=wa`).
It also takes **alert UK Nigeria 250 470000** and **stop**.

The webhook is `/api/whatsapp` on the same Cloudflare Worker as the site. All secrets live in
Cloudflare environment variables. Nothing here goes in the repository.

## What the bot does

| Message | Reply |
|---|---|
| `UK Nigeria 300` | Top 3 by amount received for £300, the best fee and rate, checked time, link |
| `Naija 300 from UK` | Same, with the aliases understood |
| `alert UK Nigeria 250 470000` | Creates a one-shot alert: message me when £250 delivers at least NGN 470,000 |
| `stop` | Deletes that phone's alerts and the number held for them |
| `UK` | Asks one short question: which country are you sending to? |
| `300` | Asks which country you are sending from |

The parser understands UK/GBP/£, US/USD/$, Canada/CAD/C$, Australia/AUD/A$, Europe/EUR/€ and the
francophone and African country names and aliases (Naija, Côte d'Ivoire, DR Congo, CDF, FCFA…).
Replies are kept under 1,000 characters.

## The one-time Meta setup (you do this yourself)

1. **Business account and verification.** Create or use a Meta Business account at
   <https://business.facebook.com>. Complete Business Verification (company documents). A verified
   business is needed for a live WhatsApp number and for template messages.
2. **Create the app.** At <https://developers.facebook.com/apps> create an app of type **Business**,
   then add the **WhatsApp** product.
3. **Add the phone number.** In WhatsApp → API Setup, add the business number, verify it by SMS or
   voice, and set the display name. Note the **Phone Number ID** (not the phone number itself).
4. **Permanent access token.** In Business Settings → Users → System Users, create a system user,
   assign the app, and generate a token with `whatsapp_business_messaging` and
   `whatsapp_business_management`. Use a long-lived token.
5. **App secret.** App Settings → Basic → App Secret. This is what signs every webhook call.
6. **Webhook.** WhatsApp → Configuration → Webhook:
   - Callback URL: `https://sendfair.africa/api/whatsapp`
   - Verify token: the same string you put in `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the **messages** field.
   Meta calls `GET /api/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`; the Worker
   echoes the challenge only when the token matches.
7. **Alert template (optional but needed for alerts).** Create a **Utility** template whose body has
   six variables, in this order:
   `{{1}}` amount sent, `{{2}}` source, `{{3}}` destination, `{{4}}` amount received,
   `{{5}}` target, `{{6}}` link. Submit it for approval and note its name.
   Business-initiated messages outside the 24-hour window must use an approved template; the bot
   never sends marketing.

## Cloudflare secrets

```sh
npx wrangler secret put WHATSAPP_TOKEN             # system-user access token
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID   # Phone Number ID from Meta
npx wrangler secret put WHATSAPP_APP_SECRET        # App Secret, for X-Hub-Signature-256
npx wrangler secret put WHATSAPP_VERIFY_TOKEN      # any long random string, also in Meta
npx wrangler secret put WHATSAPP_HASH_SALT         # random string used to hash phone numbers
# optional, for alerts:
npx wrangler secret put WHATSAPP_ALERT_TEMPLATE
npx wrangler secret put WHATSAPP_TEMPLATE_LANG     # e.g. en
```

`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_APP_SECRET` are required. Without the
verify token the GET handshake fails closed (403). Without the app secret every POST is rejected.

## Turn on the route-page button

Set the business number (international format, digits only) in `config.json`:

```json
"whatsappNumber": "254712345678"
```

The build then adds an **Ask us on WhatsApp** button to every route page (and
**Écrivez-nous sur WhatsApp** on the French pages), linking to
`https://wa.me/<number>?text=…` with the route pre-filled. Leave it empty and no button is shown.

## Data and privacy

- The user is identified by **SHA-256 of `wa:<salt>:<phone>`**, truncated to 32 hex characters.
- Only an **active alert** stores the phone number itself, because Meta needs it to deliver the
  message. `stop` deletes the alerts and the number; a fired alert is deleted too.
- No message history, no profile, no marketing list. The bot only replies to messages you send,
  inside WhatsApp's 24-hour customer-service window.

The same text appears on `/privacy/`.

## Test without Meta

```sh
node scripts/test-whatsapp.mjs
```

It checks the parser (15 cases), the reply length and fields, the `?ref=wa` link, the raw-body HMAC
signature and the salted phone hash. The webhook itself needs the Meta secrets to send a real reply.
