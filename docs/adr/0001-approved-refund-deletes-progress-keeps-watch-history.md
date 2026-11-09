# An approved refund deletes the learner's progress but keeps their watch history

When a refund request is approved, the learner's enrollment, lesson progress, quiz attempts and answers, and course rating for that course are deleted at once. Their video watch history is kept for 18 months after approval and then deleted. Progress has no purpose once the learner has given the course back. Watch history is our evidence that the refund met the "under 2 hours watched" rule if the refund is later disputed, for example through a chargeback, and GDPR allows keeping data to defend a legal claim for a bounded period.

## Considered options

- **Keep progress, hidden, and restore it if they buy again (with or without an end date).** This would make a returning learner more likely to buy again. We rejected it: a learner gets only one refund per course, so a returning learner is already committed, and keeping personal data on the chance they come back is a weak purpose under GDPR.
- **Mark the enrollment as refunded instead of deleting it.** We rejected this because every enrollment check (access, dashboard, instructor pages, purchase) would have to remember to filter refunded rows, and one missed check gives away free access. The purchase and refund rows already record the history.

## Consequences

- Deletion can't be undone, so the admin confirms before approving and the learner is warned when submitting the request.
- A learner who buys again starts from zero.
- The 18-month cleanup of watch history needs something to run it on a schedule.
