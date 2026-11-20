# TikTok app review: explanation text

Paste into Production → App review → "Explain how each product and scope works" (under 1,000 characters):

SendFair (sendfair.africa) is a free comparison site for Africans abroad: it compares money transfer services and prices building a house back home. Every evening our server makes one short vertical video with that day's best transfer rate or a building-cost tip, using our own data.

Login Kit (user.info.basic): the site owner (only our own SendFair TikTok account) signs in once on our private admin page, sendfair.africa/admin/social, by clicking Connect TikTok. We store the access token on our server and show the connected account name on that page so the owner can confirm the right account is linked.

Content Posting API, Direct Post (video.publish): once a day our server posts that day's video to the connected SendFair account with its caption. The owner can switch daily posting off, post the day's video by hand, or disconnect at any time on the same admin page. We do not post for any other TikTok users and do not read or store anyone else's data.

## Production fields
- App icon: `brand/app-icon-1024.png` · Name: SendFair · Category: Finance
- Description: Compares money transfers to Africa and prices building a house back home. Posts our daily rate video to TikTok.
- Terms: https://sendfair.africa/terms/ · Privacy: https://sendfair.africa/privacy/ · Platform: Web, https://sendfair.africa/
- Products: Login Kit (redirect https://sendfair.africa/admin/social/callback/tiktok), Content Posting API with Direct Post
- Scopes: user.info.basic, video.upload, video.publish

## Demo video (what to record)
1. Open https://sendfair.africa/admin/social (show the address bar).
2. In the TikTok box, click Connect TikTok, log in with @sendfair, press Authorize, show "connected ✓".
3. Click "Post today's Reel now", show the result row, then show the video on the TikTok profile.
4. Show the Turn auto-post OFF / Disconnect buttons.
