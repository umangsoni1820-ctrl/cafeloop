# CafeLoop

CafeLoop is a responsive ordering and customer-retention app for independent cafes. Guests order from a table QR code without installing an app. Cafe owners manage live orders, loyalty stamps, rewards, customer consent, come-back offers and cafe settings from a private workspace.

The product requirements and visual direction come from the 18-page *Cafe App Blueprint*. Product-specific details are mapped in [requirements and workflows](docs/requirements.md); the architecture is described in [architecture and data model](docs/architecture.md).

## Run it locally

Requirements: Node.js 22.5 through 24.x and npm. Local development uses Node's built-in SQLite driver. Set `DATABASE_URL` to use Supabase PostgreSQL.

```powershell
npm install
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm run dev
```

The local `.env` defaults to SQLite so the app runs without cloud credentials. To connect Supabase, copy the CafeLoop Session Pooler URI from the comment in `.env.example` into `DATABASE_URL` in `.env`, replace `YOUR_DATABASE_PASSWORD`, and percent-encode reserved characters. Keep the completed URI in this git-ignored file; do not paste it into chat or commit it. The first successful Supabase-backed server start initializes the schema idempotently.

Open [http://localhost:5173/owner/setup](http://localhost:5173/owner/setup) to create the first cafe and owner login. Add the cafe's real menu in **Settings**, then set its review link and public menu URL before printing QR codes. New cafes start with an empty menu and empty customer history.

New cafe setup defaults to INR and `Asia/Kolkata`. The current local The Leela menu is based on the supplied menu image; the app supports one price per menu item, so separate size prices need separate item entries until size options are added.

In development, Vite serves the app on port `5173` and the Express API listens on port `3001`. Without `DATABASE_URL`, the SQLite file is created at `.data/cafeloop.sqlite` and persists between restarts. With `DATABASE_URL`, the server initializes the PostgreSQL schema in Supabase on startup.

The Supabase project has the CafeLoop schema but no cafe, owner, customer, menu, or order records. The local SQLite database contains the `The Leela` cafe, its owner login, and one menu item; it has no customer or order records. Those local records have not been copied into Supabase.

## Deploy to Render

`render.yaml` defines a Node web service in Singapore. Render builds the Vite app and runs the Express server as a long-lived process. The production server requires Supabase PostgreSQL; it refuses to start with local SQLite because Render's free web service filesystem is ephemeral.

1. Put this project in a private Git repository and connect that Git provider to Render. Render deploys services from a connected Git repository.
2. Create a Blueprint from the repository's `render.yaml`. The service uses the free plan initially; Render asks for `DATABASE_URL` during setup. Use the Supabase session-pooler URI and enter the password in Render, not in chat or source control.
3. After Render assigns the `onrender.com` URL, set `APP_PUBLIC_URL` to that HTTPS origin in the service's environment, then redeploy.
4. Open `/api/health`, create the first owner at `/owner/setup`, add the cafe's real menu and settings, and test a guest table order.
5. Set the cafe's Public menu URL to the live origin and print new table QR cards.

The free web service spins down after 15 minutes without traffic and can take about a minute to start when the next request arrives. The app and API remain publicly available at its HTTPS URL; upgrading the service removes spin-down. No paid plan is selected by this project configuration.

Keep `TWILIO_AUTOMATIONS_ENABLED=false` until the Twilio token, sender, WhatsApp templates or India DLT registration, and scheduling path are configured. Scheduled birthday, come-back, and review messages need an always-on worker or a separate cron service before they can run reliably.

## Main features

- Table-specific QR ordering with server-priced menu items, order notes and customer recognition on the same device.
- Owner email/password login, private cafe workspace, live New / Preparing / Completed order columns and order completion controls.
- One loyalty stamp per completed order when at least one ordered item earns a stamp. The cafe controls the target. A reward is created once per stamp cycle and redemption starts the next cycle.
- Customer card, free-coffee or offer code, and a separate Google review link. Review activity records a click; the app does not claim to know whether a review was posted.
- Consent-filtered 21 / 30 / 60-day come-back list, a 14-day offer cooldown, individual and bulk offer preparation, reward expiry and win-back attribution.
- Cafe-timezone birthday and come-back schedules, plus a review request two hours after the second completed visit.
- Cafe profile, currency, timezone, brand colour, logo URL, Google review URL, stamp target, menu editor, message wording, sender override and WhatsApp template IDs.
- Printable table QR cards, customer CSV export, customer deletion with dependent records, and inbound Twilio `STOP` opt-out handling.
- Responsive layouts for customer and owner screens, including 375px mobile-width checks.

## Messaging

The app works without an outbound messaging account. In that mode, scheduled messages appear in the owner outbox; an owner can review and open a WhatsApp or SMS composer. The status is recorded as queued or opened, never falsely reported as delivered.

To enable Twilio delivery, add account credentials to `.env` and configure a sender in CafeLoop settings. The sender override selects the Twilio sender; it does not create or purchase one. WhatsApp automation also needs approved Content SIDs. Scheduled automation stays paused until `TWILIO_AUTOMATIONS_ENABLED=true`. Point the Twilio inbound message webhook at `/api/webhooks/twilio/inbound` so signed `STOP` replies can disable consent. See [environment settings](#environment-variables) and the Twilio notes in [architecture.md](docs/architecture.md).

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | Express port; defaults to `3001`. |
| `DATABASE_URL` | Required in production; optional locally | Supabase PostgreSQL session-pooler connection string. Keep it server-side. When set, it takes precedence over SQLite. |
| `DATABASE_PATH` | Local development only | SQLite file path; defaults to `./.data/cafeloop.sqlite` when `DATABASE_URL` is empty. Production requires `DATABASE_URL`. |
| `APP_PUBLIC_URL` | No | Public app origin for Twilio webhook signature verification; set this to the externally reachable HTTPS origin in production. |
| `NODE_ENV` | No | Set to `production` behind HTTPS to enable the secure session-cookie flag. |
| `TWILIO_AUTOMATIONS_ENABLED` | No | Set to `true` only after reviewing the live sender, templates, message consent, and test plan. Defaults to paused. |
| `TWILIO_ACCOUNT_SID` | For automatic delivery | Twilio account SID. |
| `TWILIO_AUTH_TOKEN` | For automatic delivery and inbound STOP | Twilio auth token; keep it on the server. |
| `TWILIO_FROM` | For automatic delivery | Default E.164 SMS sender or `whatsapp:+...` sender. A cafe can override it in its settings. |
| `CHROME_PATH` | Browser test only | Optional path to Chrome or Edge if it is not installed in a standard Windows location. |

India SMS settings (PE ID and one approved DLT template ID per message type) are saved under Owner Settings > Messages & automations. Messages to Indian `+91` numbers remain queued until both the entity ID and the relevant template ID are present. Register sender IDs and the exact message templates with the DLT portal and Twilio before enabling delivery.

Never commit `.env`, a Supabase connection string, or the SQLite database. For production, terminate HTTPS at the host or reverse proxy, set `APP_PUBLIC_URL`, and run one scheduler process. Supabase Free projects may pause after a week with too little database activity; choose a paid plan if the service must remain continuously available. The printed QR code should use the cafe's real public URL; `localhost` QR codes only work on the machine running the app.

## Production start

```powershell
npm run build
npm start
```

When `dist/` exists, Express serves the built React app and the API from the same origin. Production requires `DATABASE_URL` for Supabase; local development can use SQLite. Daily automations run while this Node process is online.

## Verification

```powershell
npm test
npm run test:browser
npm audit
```

The API tests use an in-memory database. The browser test builds the app and exercises setup, menu entry, QR order, live status, card stamps and generated table QR codes at 375px. Detailed results are in [verification results](docs/verification.md).

## Stack and deployment note

React 19, Vite 6, Express 5, Node's `node:sqlite` for local development, PostgreSQL.js for Supabase PostgreSQL, Zod 4 and Playwright. `server/postgres-schema.sql` provisions the same tenant-aware schema in Supabase without deleting existing records. Owner queries always scope on `cafe_id`, and composite foreign keys prevent cross-cafe relationships. The API connects server-side using `DATABASE_URL`; it does not expose database credentials in the browser. The CafeLoop Supabase schema has RLS enabled on all 11 tables and no browser/Data API policies; the API uses its privileged server connection and app-level tenant checks.

No fictional menu items, customers or order history are seeded. The blueprint suggests demo rows, but this implementation follows the request for no fake data. Empty states and metrics are based on the cafe's actual database records.
