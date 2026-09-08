# Append-only records

`trials.csv` is the repository-wide index of finalized trials. Its rows are
append-only and bind each trial identity to the SHA-256 of its immutable
`result.json`. Do not reorder, edit, or delete existing rows. Run
`npm run reconcile` to append finalized local results that are not yet present.

`reviews.csv` is a separate append-only event log for human proof-only review.
A later correction is another review event; it does not mutate the trial row or
an earlier review event.

`usage.csv` is the append-only accounting index for trials with
`agent.accounting` in their result. It includes recovered stream usage and cost
estimates even after a timeout, alongside `usage_coverage`, `usage_scope`, and
`cost_status`. A `partial-estimate` prices only the usage observed so far; blank
token counts mean unknown. Dollar amounts are estimates, including Claude's
reported amounts, and do not represent confirmed subscription charges.

The original `trials.csv` columns retain their meaning: its token and cost
fields come from Claude's final result event. Use `usage.csv` for timeout
accounting. Reconciliation can append missing usage rows from immutable result
manifests. Historical trials lacking accounting can be inspected with
`npm run usage -- TRIAL_DIRECTORY`; that command creates no ledger rows and
never modifies historical manifests.
