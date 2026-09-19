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

## Skill records

`skills.csv` is appended automatically alongside finalized trials that were
given `--skill`, under the same ledger lock. It records explicit main-agent
events for only those configured skills. Runs without skills leave this file
untouched, including any baseline rows recorded previously. Finalized rows are
unique by `(record_id, skill)` and bound to the immutable result hash. Join
trials by `record_id`. Existing rows are never rewritten or removed, even when
their source files are absent from the current machine.

Backfill historical local trials or recover a missing skill row with:

```sh
npm run reconcile
```

`skill_configured` comes from `run.json`; `skill_available`, `skill_invoked`,
`skill_invocation_succeeded`, and `skill_instructions_injected` describe
the startup list, tool call, matching successful response, and synthetic skill
instructions respectively. No `skill_used` or advice-following judgment is made.
Event states are `yes`, `no`, or `unknown`; missing or incomplete logs never
turn an unobserved event into `no`. Source paths, evidence line numbers, and
file hashes make the observations inspectable. `npm run skills -- RUN_ID`
remains an inspection command; it never updates this ledger.

Rows from the initial snapshot are retained, including unfinished attempts
with an empty `result_sha256`. If one of those attempts later finalizes, its
finalized row is appended. Use the row with a nonempty `result_sha256` when
joining finalized trials.
