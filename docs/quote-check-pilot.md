# Quote Check pilot plan

Goal: 10–20 real builders' quotes checked for free, to prove the report is useful and accurate before charging.

## Before the pilot
1. Verify the top Nairobi lines (docs/build-price-verification.md), at least #1 roof timber, #3 boundary wall, #5 kitchen and #7 masons.
2. Keep Quote Check closed to the public (`config/quote-check.json` → `enabled: false`). The pilot runs by hand.

## How the pilot runs (no payment, no public upload)
1. Invite people from the waiting list (Buttondown tag `quote-check`) and your own network who already have a builder's quote for a house in Kenya.
2. They email the quote (photo or PDF) to hello@sendfair.africa.
3. You forward it to Claude in a chat. Claude types the lines into the Quote Check engine (the same `analyse` code the site will use) and sends back the report: matched lines, verdict, arithmetic errors, quantity questions, and "no benchmark" for lines we can't compare.
4. You send the report to the person with three questions (below).

## Three feedback questions
1. Did the report change anything you'll say to or ask your builder? What?
2. Was any line wrong or unfair? Which?
3. Would you have paid KES 1,500 (or GBP 9) for this? Why or why not?

## Success = open paid Quote Check when
- At least 10 reports done, at least 7 people say it changed what they'll ask the builder, and no line was flagged wrong without us fixing the price.
- A payment provider is set up (owner: merchant account, e.g. Paystack or M-Pesa; Claude wires it in), and the line-extraction service is connected.
- Then set `enabled: true` and turn on test mode for one paid run before going live.

## Invite message (WhatsApp or email)
Hi [name], I'm testing a new free service on SendFair: if you have a builder's quote for a house in Kenya, send me a photo or PDF and I'll send back a line-by-line check against today's Nairobi prices: which lines look high, any adding-up mistakes, and questions to ask your builder. It's free for the first 20 people; I only ask for 3 quick answers afterwards. Send it to hello@sendfair.africa.
