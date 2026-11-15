# Verification results

**Run date:** November 15, 2026 (Asia/Calcutta)

## Commands and backend status

| Check | Result |
| --- | --- |
| `npm test` | Passed: 8 API/integration tests, 0 failures, including INR and Indian timezone defaults. |
| `npm run test:browser` | Passed: production build plus 1 real-browser flow at 375px, 0 failures. Vite reports a large JavaScript chunk advisory. |
| Production startup guard | Passed: production mode refuses to start when `DATABASE_URL` is empty, rather than falling back to ephemeral SQLite. |
| Indian currency handling | Passed: default cafe setup uses INR and Asia/Kolkata; INR formatter displays ₹20 and fractional paise cleanly. |
| Local cafe menu | Corrected local The Leela profile to INR / Asia/Kolkata and the supplied Adrak Chai price to ₹20; customers=0 and orders=0. Supabase remains empty. |
| `npm audit --omit=dev` | Passed: 0 production dependency vulnerabilities. |
| Supabase SQL Editor | Passed: schema query returned success; all 11 CafeLoop tables reported RLS enabled. |
| Supabase fresh-state check | Passed: cafes=0, owners=0, menu_items=0, customers=0, orders=0; schema version 4. Currency default `INR` and timezone default `Asia/Kolkata` verified. |
| Supabase app connection | Pending: local `.env` has `DATABASE_URL` blank for SQLite mode. The Session Pooler URI was confirmed in the Supabase dashboard; no password was read, reset, or entered. |
| Twilio project | Created as `CafeLoop` on the no-card Limited Trial; no paid upgrade. |
| Twilio trial test | One free SMS sent from Twilio Console to the account's prefilled phone; console showed `Message sent`. |
| CafeLoop Twilio integration | Pending: auth token needs local entry; sender is set to the trial number; scheduled sends remain disabled. |

## Covered flows

- Owner setup creates a workspace and session; an empty cafe starts with no invented customers.
- Menu CRUD and public menu reads; invalid menu item IDs are rejected before a customer record is created.
- QR order validates item pricing server-side, remembers the customer by device token, and exposes order status only to that customer token.
- Live owner order transitions, completed-order visit updates, one stamp per order, fifth-stamp reward creation and idempotent completion.
- Public card and private order status, reward redemption and stamp-cycle reset.
- Delayed review queue, review composer handoff and separate review-click logging.
- Tenant isolation across two cafes, including rejected cross-cafe menu mutation.
- Consent-filtered come-back batch, queued manual handoff, 14-day cooldown, offer return attribution and dashboard win-back metric.
- Birthday/come-back daily jobs are consent-based and idempotent; valid Twilio `STOP` webhook opts out and blocks further manual offers.
- Mocked Twilio WhatsApp delivery uses the cafe sender override, approved template SID and all five birthday template variables.
- India SMS checks DLT PE/template IDs and includes both in the Twilio payload.
- Customer deletion cascades through orders and loyalty history.
- 375px browser route through setup, menu item creation, QR ordering, order completion, customer card update and generated printable table QR codes.

The API and automated browser tests use temporary in-memory data; they do not seed Supabase. The persistent local `.data` database contains the actual The Leela cafe and one menu item; its currency and price now match the supplied menu image. The Supabase schema/defaults are applied and the cloud database remains empty, but its app connection still needs the actual database password entered locally in `.env`; then the API and owner setup need a Supabase-backed run. Twilio API delivery and actual carrier/WhatsApp delivery remain unverified until provider credentials and approved templates are configured. No hosting project has been created and nothing has been published.
