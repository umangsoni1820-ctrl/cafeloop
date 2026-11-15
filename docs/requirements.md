# Requirements and workflows

This document separates CafeLoop product requirements from the wider business advice in the source blueprint. The product is the customer-retention web app. Pricing packages, cold outreach scripts, prospect lists and video-sales assets are business operations around the app, not app screens.

## Roles

| Role | Access |
| --- | --- |
| Guest / customer | No app account. Opens a cafe menu from its table QR code; a high-entropy device token keeps the customer's card and order view on that device. |
| Cafe owner | Email/password account scoped to one cafe. Manages settings, menu, orders, customers, rewards, QR cards and messages. |
| Counter staff | No separate login role in the blueprint. The owner workspace provides order-completion and reward-redemption actions for the cafe team. |

## Product requirements mapped to the build

| Blueprint requirement | Implementation |
| --- | --- |
| One mobile-first web app; guests need no install | React routes `/order`, `/card` and `/reward`; responsive customer screens. |
| Table QR includes cafe and table | Printable unique links in `/owner/qr`, with configurable table count and per-cafe public URL. |
| Menu categories, item notes, cart and first-visit details | Cafe menu editor and public order flow. The server verifies current item IDs and prices before inserting an order. |
| Optional marketing consent, unticked initially | Separate checkbox on first visit, timestamped on consent; returning guests can change consent. Phone numbers require E.164 format. |
| Recognize guests on the same device | Customer bearer token is stored locally and its SHA-256 hash is stored in the cafe's customer row. Token is sent in a header for card/order reads, not in the URL. |
| New / Preparing / Completed owner orders | Owner dashboard, cafe-scoped server-sent events and guarded status transitions. |
| Completion updates visits, last visit and favourite item | Transactional status transition; favourite item is calculated from the guest's completed order snapshots. Repeating completion is idempotent. |
| One stamp when any qualifying item is in a completed order | `earns_stamp` is checked server-side; `UNIQUE(cafe_id, order_id)` prevents double stamps. New, preparing and cancelled orders earn none. |
| Stamp target can be changed; reward code created at target | Owner settings allow targets from 3 through 20. The default is 5. One reward is tied to the reached stamp cycle. |
| Card resets on reward redemption | Stamp-cycle stamps stay attached to the reward while it is available. Redemption ends that cycle; later completed orders start a new one. |
| Reward and Google review are separate | Reward redemption only checks its code/status/expiry. Every card has the same separate review button when a cafe has configured a link. Taps are logged; posted reviews are not inferred. |
| Come-back list filters 21 / 30 / 60 days | `/owner/comeback` filters customers who opted in and have been inactive for the selected period. Message templates support name, favourite item, code and expiry. |
| 14-day come-back cooldown and win-back tracking | Server checks the most recent queued/opened/sent offer. An order within an opened/sent offer's seven-day expiry attributes a return. |
| Birthday treat: optional day/month and 7-day code | Birthday fields are offered after the first completed visit; daily timezone-aware job queues a code and message only for opted-in guests. |
| Review request 2 hours after visit two | Created on the second completed visit for opted-in guests; the timezone scheduler processes it after its due time and never attaches a reward. |
| Daily come-back job at 10am; birthday at 9am | Each cafe is checked in its configured timezone by the app's 60-second scheduler. Offer idempotency keys prevent duplicate daily jobs. |
| WhatsApp/SMS provider and STOP | Twilio is optional. Approved WhatsApp Content SIDs are required for scheduled WhatsApp. SMS uses the configured sender. Signed inbound `STOP` disables matching customer consent. Without credentials, messages are queued for an owner-reviewed WhatsApp/SMS handoff. |
| Dashboard: daily totals, average, monthly repeat share, top five, reward/review/win-back counts | Derived from persisted orders, customers, rewards, reviews and offers. Empty data returns zero/empty state; no demo metrics are fabricated. |
| Cafe settings and menu | Cafe name, logo URL, colour, currency, timezone, review URL, stamp target, comeback days, channel, sender, templates and menu items. |
| Delete customer and keep cafe data separate | Cafe-scoped delete cascades through that customer's orders, stamps, rewards, reviews and offers. All owner queries filter by cafe ID. |
| Seven data tables plus cafe settings | Customers, menu items, orders, stamps, rewards, reviews and offers are implemented, with cafe, owner and session tables for tenancy and authentication. |
| Load demo data | No persistent demo rows are seeded because the user explicitly requested no fake data. Automated tests use temporary in-memory records only. |

## Main workflows

### 1. Owner setup and cafe configuration

1. Create a cafe and owner login at `/owner/setup`.
2. Add real menu items and prices in **Settings**.
3. Set the cafe's review URL, currency, timezone, inactivity period and stamp target.
4. Set a production public menu URL before printing table QR codes.
5. If sending automated messages, configure Twilio environment credentials, sender and approved WhatsApp templates.

### 2. Customer order and card

1. A guest scans `/order?cafe=SLUG&table=N`.
2. The guest adds items, quantities and optional item/order notes.
3. First visit collects a name and international phone number. Offer consent is optional and initially off.
4. The server recalculates the total from the current menu, saves an order as `new` and returns a device token.
5. The owner sees the order immediately. The guest can see its status from their card.
6. When the owner marks it completed, the app updates visit data and awards at most one stamp.
7. At the stamp target, one reward code appears. The counter marks it redeemed to begin the next cycle.

### 3. Come-back offer

1. `/owner/comeback` filters consented guests by 21, 30 or 60 days away.
2. Owner can prepare a single offer or a batch. Automated providers send when configured; otherwise each message stays queued until the owner opens the messaging app.
3. Every offer has a 7-day code. The list excludes guests with an offer in the last 14 days.
4. An order before expiry is attributed to an opened/sent offer and counted as a win-back.

### 4. Birthday and review automations

- Birthday: optional birthday day/month, consent required, local cafe time 9am, free-drink reward expires in 7 days.
- Come-back: inactivity and consent checks, local cafe time 10am, 20% offer expires in 7 days.
- Review: scheduled two hours after the second completed visit, consent required, no reward, honest-review wording.
- `STOP` is validated against Twilio's request signature and disables further marketing messages.

## Scope decisions

- The blueprint names Supabase as its primary tool but also permits alternatives. The app uses SQLite because no Supabase project/credentials were available and a working local database was required. The API and schema enforce per-cafe isolation, but do not claim to provide PostgreSQL row-level security.
- The PDF's demo customers/orders are not inserted. Dashboard values reflect actual user activity only.
- Agency pricing, cafe prospecting, cold-email/DM scripts and sales assets remain guide material, not CafeLoop product screens.
