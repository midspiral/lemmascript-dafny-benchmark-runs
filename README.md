# LemmaScript Dafny benchmark runs

A small, dependency-free runner for Claude Code trials against the sibling
[`lemmascript-dafny-benchmark`](https://github.com/midspiral/lemmascript-dafny-benchmark) checkout. It creates isolated attempts, records
external wall-clock time and Claude's event stream, freezes each candidate, and
scores it with the benchmark's authoritative checker.

The project does not contain credentials.

For [synthetic.new](https://synthetic.new/?referral=Qi8g7zPU) (referral link), the `synthetic-kimi` profile expects `SYNTHETIC_API_KEY` in the launching environment and implements this mapping:

```text
ANTHROPIC_BASE_URL=https://api.synthetic.new/anthropic
ANTHROPIC_AUTH_TOKEN=$SYNTHETIC_API_KEY
ANTHROPIC_DEFAULT_OPUS_MODEL=syn:large:vision
ANTHROPIC_DEFAULT_SONNET_MODEL=syn:large:vision
ANTHROPIC_DEFAULT_HAIKU_MODEL=syn:small:text
CLAUDE_CODE_SUBAGENT_MODEL=syn:large:vision
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

The source key is removed from the environment passed to Claude, and both it
and `ANTHROPIC_AUTH_TOKEN` are hidden from Bash subprocesses.

## Inspect and plan

No installation is needed beyond the benchmark's own prerequisites.

```sh
npm run list

npm run plan -- \
  --profile anthropic-opus \
  --tasks 31,19,6,24

npm run plan -- \
  --profile synthetic-kimi \
  --tasks 31,19,6,24
```

Planning is read-only: it validates task IDs and prints the exact non-secret
configuration without creating attempts or contacting a model.

## Run

Run a selected pilot:

```sh
npm run run -- \
  --profile anthropic-opus \
  --tasks 31,19,6,24
```

Run the Synthetic profile:

```sh
npm run run -- \
  --profile synthetic-kimi \
  --tasks 31,19,6,24
```

Run every admitted task except the protocol's exclusions (currently task 8):

```sh
npm run run -- --profile anthropic-opus --all
```

Useful options:

```text
--benchmark-root PATH          benchmark checkout (default: sibling checkout)
--results-root PATH            result storage (default: ./results)
--run-id NAME                  stable name; reuse it to resume completed trials
--repeat N                     fresh trials per task (default: 1)
--timeout-minutes N            Claude wall-clock limit (default: 60)
--validation-timeout-minutes N outer limit for each final check (default: 45)
--validation-timeout-retries N retry final checks that hit Dafny timeouts
--effort LEVEL                 low, medium, high, xhigh, or max
--run-kind KIND               benchmark, smoke, or diagnostic
--keep-attempts                retain temporary attempt directories
--include-excluded             permit an explicitly named excluded task
--no-ledger                    skip the repository-wide trial ledger
```

`--all` never implies `--include-excluded`; an excluded task must be named with
`--tasks` as well as explicitly enabled.

## Results

Each run is stored as `results/<run-id>/`. Every task/trial directory contains:

- the frozen `candidate.dfy` and rendered `PROMPT.md`;
- raw `claude.stream.jsonl` and `claude.stderr.log`;
- parsed independent check result(s);
- a full-context `diff.patch`;
- `result.json`, the immutable trial manifest.

The runner regenerates `summary.json` and `summary.csv` after every completed
trial. `results/` is ignored because raw transcripts can be large; copy a
reviewed result set elsewhere before publishing it.

## Append-only records

Every finalized trial is appended to the tracked [`records/trials.csv`](records/trials.csv),
including failures and infrastructure errors. A row records the exact historical
profile name, task and trial identity, reported model, outcome, agent and
validation wall time, token and cost metadata, benchmark commit, candidate hash,
and the hash and relative path of its immutable `result.json`.

Use `--run-kind=benchmark`, `smoke`, or `diagnostic` to keep exploratory runs
transparent without mixing them into benchmark comparisons. The default is
`benchmark`.

The result manifest remains the source of truth. If a process is interrupted
after writing a result but before appending its row, reconcile all finalized
local results with:

```sh
npm run reconcile
```

Reconciliation only appends missing rows. It never rewrites existing ones, and
it fails if a result already bound into the ledger has changed. Human proof-only
decisions belong in the separate append-only [`records/reviews.csv`](records/reviews.csv)
rather than mutating trial facts.

See [PROTOCOL.md](PROTOCOL.md) for timing, isolation, outcome, and review rules.
