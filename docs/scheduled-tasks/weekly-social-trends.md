# Scheduled task: SendFair weekly social trends

- Schedule: Mondays 09:13 Nairobi (`CRON_TZ=Africa/Nairobi 13 9 * * 1`)
- Model: claude-opus-5-5 · approval: automatic · notifications: push
- Connectors used: vidIQ, Claude Code Remote (add_repo)
- Each run starts a fresh session. To recreate on another account, create a scheduled task with this schedule and the prompt below, word for word.

## Prompt

You run the weekly "trending in your niche" scan for SendFair (https://sendfair.africa), a free site for the African diaspora (senders in the UK, US, Canada, Australia, Europe; families in Nigeria, Kenya, Ghana, Uganda, Zambia, Zimbabwe and other African countries). The owner is not technical. SendFair is NOT only money transfers: its content covers (a) comparing money-transfer services by what arrives, (b) building a house back home: whole-house costs, material prices (cement, iron sheets, blocks, tiles), bungalow vs maisonette, plots and builders, using its cost-to-build calculator, and (c) other diaspora life back home: flying home (flights, eSIMs), rate alerts. Building content performs at least as well as transfers, so give it equal weight.

1. Use the vidIQ tools (load them with ToolSearch, query "vidiq") to find short-form videos (YouTube Shorts, TikTok, Instagram Reels) from the last 14 days that are performing unusually well in these niches: building a house in Kenya/Nigeria/Ghana/Uganda (costs, materials, construction progress, diaspora building), sending money home / exchange rates (naira, shilling, cedi) / remittance tips, and diaspora travel home. Prefer outlier/trending tools (vidiq_outliers, vidiq_trending_videos, vidiq_instagram_tiktok_outlier_search, vidiq_youtube_search) over generic search. Do not invent numbers: only report views/dates the tools return.
2. Pick the 6 most useful examples: at least 3 about building/houses, at least 2 about money transfers, and 1 about another diaspora topic if a good one exists. For each: title, creator, platform, topic ("building", "transfers" or "other"), views (as returned), url, and one line "why it works" (the hook/format) plus one concrete idea for how SendFair could make a similar Reel with its own real data (never copy their content).
3. Setup: add_repo (owner malayic4-eng, repo sendfair, access push), git clone --depth 1 https://github.com/malayic4-eng/sendfair, git config user.name Claude, git config user.email noreply@anthropic.com. Write data/social/trends.json as {"updatedAt": ISO time, "items": [{"title","creator","platform","topic","views","url","why","idea"}]}. Commit with message "Weekly social trends [skip ci]" (end with the attribution lines from your session instructions), git pull --rebase, push to main. The Monday weekly social report (a GitHub Action at 07:00 UTC) includes this file when present.
4. If vidIQ is unavailable or returns nothing useful, change nothing and say so in one short message.
5. Final message (read on a phone): the 6 items in short form (topic, title, views, why, idea), no more than ~14 lines.
