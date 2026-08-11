# Append-only records

`trials.csv` is the repository-wide index of finalized trials. Its rows are
append-only and bind each trial identity to the SHA-256 of its immutable
`result.json`. Do not reorder, edit, or delete existing rows. Run
`npm run reconcile` to append finalized local results that are not yet present.

`reviews.csv` is a separate append-only event log for human proof-only review.
A later correction is another review event; it does not mutate the trial row or
an earlier review event.
