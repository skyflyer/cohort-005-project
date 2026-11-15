# Knock setup

Cadence sends Notifications through [Knock](https://knock.app). Every Knock
environment (Development, Production) needs the steps below. Spec: issue #45.

## Environment variables

| Variable                 | Used for                                         |
| ------------------------ | ------------------------------------------------ |
| `KNOCK_SECRET_API_KEY`   | Server: triggering workflows, preferences        |
| `KNOCK_PUBLIC_API_KEY`   | Browser: the headless Feed client                |
| `KNOCK_SIGNING_KEY`      | Server: signing per-user feed tokens (base-64 PEM, RS256) |
| `KNOCK_FEED_CHANNEL_ID`  | Browser: the In-app feed channel                 |

Put them in `.env` (loaded explicitly by `app/lib/notifications.server.ts`,
because `react-router dev` does not load it). Without `KNOCK_SECRET_API_KEY`
every trigger is logged with `console.info` and nothing is sent.

Enhanced security mode must be on in the environment.

## Workflows

One workflow per Notification. The workflow key is the glossary term in
kebab-case and equals `data.kind`. Each workflow has exactly one **In-app
feed** step (pointing at the Feed channel) and must be **committed**: Knock
does not run uncommitted workflows.

To create one: Workflows > Create workflow > set the key > add an In-app feed
step (any template; the Feed renders from `data`, not the template) > Commit
changes.

| Workflow key              | Ticket | Status |
| ------------------------- | ------ | ------ |
| `discussion-question`     | #46    | create + commit |
| `discussion-reply`        | #46    | create + commit (replaces the prototype's `discussions-reply`) |
| `refund-request-approved` | #48    | create + commit (to the buyer; `data.url` is `/settings` or `/team`) |
| `refund-request-declined` | #48    | create + commit (same as approved) |
| `refund-request-opened`   | #48    | create + commit (to every Platform Admin except the buyer; `data.url` is `/admin/refunds`) |
| `seat-claimed`            | #49    | create + commit |
| `new-enrollment`          | #49    | create + commit, only AFTER the default preference set below is configured |

## Environment default preference set

Every workflow is on by default except `new-enrollment`. Cadence code and
database hold no defaults.

Per environment: Knock dashboard > Developers > Preference sets (Settings >
Preferences) > edit the **default** preference set, and set:

```json
{ "workflows": { "new-enrollment": false } }
```

Leave every other workflow (`refund-request-approved`, `refund-request-declined`,
`refund-request-opened`, `seat-claimed`, `discussion-question`,
`discussion-reply`) on (Knock's default). Do this **before** committing
the `new-enrollment` workflow, otherwise Instructors without saved preferences
would receive it. Instructors opt in from the Settings Notifications card.

The Settings Notifications card reads and writes the person's `default`
preference set on the server only (`app/lib/notification-preferences.server.ts`).
A switch with no value from Knock is shown as an error, never as a default.

## Checking by hand

Sign in with the DevUI switcher as a Student, post a Discussion Question on a
lesson, then reply to it as another user. In the Knock dashboard (Messages
log) the reply shows up for the question's author, and the question for the
course's Instructor.

## Checking Seats and Enrollments by hand

1. As a Student, buy a Team Licence of 2 Seats, then claim one Seat from a
   second user via `/redeem/<code>`. The Team Admin gets `seat-claimed`
   ("1 seat left"), linking to `/team`.
2. As an Instructor with no saved preferences, the claim and any Individual
   Purchase send **no** `new-enrollment` (default is off). Opt in through
   preferences (or the Knock dashboard) and enroll again: the Instructor gets
   `new-enrollment` linking to `/instructor/<courseId>/students`.
3. Buying a Team Licence sends nothing.
