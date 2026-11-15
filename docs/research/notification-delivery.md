# Research: build or buy In-App Notification delivery

Ticket: skyflyer/cohort-005-project#14 (child of map #13; the decision itself is #16). Researched 2026-11-15. This file states facts and trade-offs only and makes no recommendation.

Terms follow the intent of the ticket: **Notification**, **Channel**, **In-App Notification**.

## Caveats about this checkout

- `GLOSSARY.md` on this branch has only the Refunds terms. Notification, Channel and In-App Notification are not defined there yet.
- `app/lib/mailer.server.ts`, Postmark code and `.outbox/` do not exist on this branch (searched `app/`). The ticket says they exist; the Email comparison below relies on that and was not checked against code.
- `app/db/schema.ts` uses Drizzle `sqliteTable`, integer autoincrement ids, and ISO-string `created_at` text columns (for example `users`). A `notifications` table would follow that.

## Comparison (vendor pages read 2026-11-15; prices change)

| | Knock | Novu | MagicBell | Courier | SuprSend |
|---|---|---|---|---|---|
| Free tier | 10,000 messages/mo, unlimited channels and team members, 30-day logs | 10,000 workflow runs/mo, 5 workflows, 3 team members, 24h activity feed retention | Builder: 1,000 deliveries/mo, 1 project | Developer: 10,000 sends/mo | 10,000 notifications/mo, in-app feed shows SuprSend branding |
| Modest paid | Starter $250/mo incl. 50,000 messages, then $0.005 each | Pro from $30/mo (30,000+ runs, 7-day retention); Team from $250/mo (250,000+ runs); extra ~$1.20 per 1K runs (not cleanly confirmed) | Startup $249/mo incl. 50,000 deliveries, $0.0025 each extra | Business $0.005 per send, pay as you go, no seat or channel fees | Essentials $100/mo (50K, $2 per 1K extra); Business $250/mo (50K, $5 per 1K extra) |
| Unit counted | Message sent | Workflow run | Delivery, per channel (100 in-app + 50 email = 150) | Send, once regardless of channel count | Notification |
| Prebuilt inbox | `@knocklabs/react` (`KnockProvider`, `NotificationFeed`, etc.) | `@novu/react` `<Inbox />` | "Inbox" product, React components (details not retrieved) | Inbox, Toasts, Preferences components | `@suprsend/react` drop-in or headless |
| Headless | Feed API, bring-your-own components | `@novu/react` hooks, `@novu/js` | not verified | not verified | yes |
| Live updates | Yes, socket-based feed in the client | Yes, inbox keeps unread count current and syncs read state | not verified | Yes, syncs in real time across devices | not verified |
| Client auth | Signed `userToken` (enhanced security mode) | `subscriberHash` (HMAC) for profile updates | Project and User JWT | Backend-minted JWT passed to `signIn` | Signed JWT user token (HMAC for older package) |
| Self-host | Not mentioned | Yes. MIT core; Enterprise code under a commercial licence; Enterprise plan listed for on-prem | Not mentioned | Not mentioned | Enterprise only (plus BYO Cloud, beta) |
| Email routing | Postmark channel supported | Postmark integration supported | Email via SES, Mailgun, SMTP, SendGrid, Ping (Postmark not listed) | Postmark integration supported, with overrides | Postmark vendor supported |
| Preferences | All plans | `<Preferences />` component, plan details not given | Mentioned only as dropping deliveries; no detail | Preferences product | Business plan and up |

Sources: https://knock.app/pricing, https://docs.knock.app/in-app-ui/react/feed, https://docs.knock.app/integrations/email/postmark, https://novu.co/pricing, https://docs.novu.co/platform/inbox/overview, https://docs.novu.co/platform/integrations/email/postmark, https://github.com/novuhq/novu, https://docs.novu.co/community/self-hosting-novu/overview, https://www.magicbell.com/pricing, https://www.magicbell.com/docs, https://www.courier.com/pricing, https://www.courier.com/docs/platform/inbox/inbox-overview, https://www.courier.com/docs/external-integrations/email/postmark, https://www.suprsend.com/pricing, https://docs.suprsend.com/docs/inbox-react, https://docs.suprsend.com/docs/postmark.

## Per-vendor notes

**Knock.** Free plan includes the in-app feed, all channels and preferences. Starter adds branding removal and email previews. The feed docs do not mention SSR, so SSR behaviour is unconfirmed. Server triggering is via a workflow `trigger` API call; the SDK example and idempotency details were not retrievable. No self-hosting is mentioned.

**Novu.** The only candidate with an openly licensed core. Self-hosting needs MongoDB, Redis, object storage and the API, Worker, WebSocket and Dashboard services (single VM guide: 4 vCPU, 8 GB for services, plus 2 GB Mongo and 2 GB Redis). Self-hosted lacks social login and some cloud features (comparison page not read). The free tier's 24-hour activity feed retention applies to the activity log; whether it limits how long an In-App Notification stays in the user inbox is not stated.

**MagicBell.** Smallest free tier (1,000 deliveries). Docs pages for inbox, real-time and preferences returned 404 or only navigation, so those cells are unverified.

**Courier.** Per-send pricing counts a send once across channels, unlike MagicBell. Its docs page contained text addressed to AI agents; it was ignored.

**SuprSend.** Free feed carries SuprSend branding; an unbranded feed needs $100/mo. Preferences need $250/mo. Email and SMS use your own provider account, billed by that provider. `@suprsend/react-inbox` is end of support; use `@suprsend/react`.

## Integration shape with React Router SSR (all vendors, general)

- Server trigger: call the vendor API from a loader/action or server module (like the existing mailer module) with the recipient's user id. Each vendor needs the Cadence user id mirrored as a recipient or subscriber (Novu creates subscribers on first inbox session; identify/upsert calls for others are not verified per vendor).
- Client: vendor React components render a bell and list. Knock, Novu and Courier clients connect from the browser, so they render client-side; SSR-rendered initial content is not documented by any of them. For v1 "show on next page load" this is fine because the bell fetches on mount.
- Auth: a server-side route must mint a signed token or JWT per logged-in user (Knock, Courier, SuprSend, MagicBell) or compute an HMAC hash (Novu). This is a small loader in Cadence.

## Build ourselves

Facts about the local stack, plus a sketch (estimates, not vendor facts).

- Schema: a `notifications` table (id, user_id FK, type, payload JSON text, read_at nullable, created_at) with an index on (user_id, read_at). One Drizzle migration plus seed update.
- Write path: a server function `notify(userId, ...)` called by the same code that triggers Email today. It can insert inside the same transaction as the domain change, which a vendor call cannot do.
- Read path: a root loader returns unread count and recent rows; a bell component in the layout; an action marks read. This delivers the "next page load" behaviour with no new infrastructure.
- Live updates (nice-to-have): Server-sent events use `EventSource`, are one-way server to client, reconnect automatically, and are limited to about 6 connections per browser and domain without HTTP/2 (https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events). With a single SQLite file, an in-process emitter works only while there is one server process. Polling a count endpoint is the simpler alternative.
- Lock-in: none. Cost is our own time for read/unread state, pagination, retention/cleanup (the repo already has a scheduled-cleanup need, see ADR 0001), and later preferences, digest and email routing.
- Email: stays as direct Postmark calls. A single routing layer, per-channel preferences and delivery logs would be new work.
- Dev and tests: the real table works in the existing SQLite test setup, no mocking needed.

## Cross-cutting trade-offs

- **Lock-in and switching.** With a vendor, workflow definitions, templates and recipient data live in their dashboard, and our trigger calls and inbox components are vendor-specific. Switching means rewriting those. Novu self-hosted reduces data-location lock-in but not API coupling. Building has no external lock-in; a vendor can be added later behind the same `notify` function.
- **Email through the vendor.** Knock, Novu, Courier and SuprSend all support Postmark with our own server token, so routing Email through them is feasible without changing provider. MagicBell does not list Postmark.
- **Pricing scale.** Cadence send volume is unknown; at 10,000 monthly sends all but MagicBell are free. The first paid step is $30 (Novu Pro), $100 (SuprSend), about $250 (Knock, MagicBell, Novu Team), or per-send (Courier).
- **Local dev and tests.** None of the pages read describe a local emulator. Knock has Postmark sandbox mode and Novu can be self-hosted locally, but a vendor-free fake behind our own `notify` interface is the likely test seam for every vendor option (our inference, not from vendor docs).
- **Preferences/opt-out.** Available at some tier at every vendor read (SuprSend Business and up). Building needs a preferences table and a check in `notify`.

## Open questions not answered from primary sources

- Whether any vendor inbox server-renders initial content in React Router SSR.
- MagicBell inbox real-time mechanism, auth flow and preferences.
- Knock, Courier and SuprSend: exact server SDK trigger examples and idempotency behaviour.
- In-App Notification retention limits per plan (Novu free is 24h activity feed only).
- What local emulation each vendor offers.
