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
| `seat-claimed`            | #49    | later  |
| `new-enrollment`          | #49    | later  |

## Environment default preference set

Added by ticket #50: every workflow on by default except `new-enrollment`.
Cadence code and database hold no defaults.

## Checking by hand

Sign in with the DevUI switcher as a Student, post a Discussion Question on a
lesson, then reply to it as another user. In the Knock dashboard (Messages
log) the reply shows up for the question's author, and the question for the
course's Instructor.
