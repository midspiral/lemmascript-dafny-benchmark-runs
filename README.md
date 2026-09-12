# LemmaScript Dafny benchmark runs

A small, dependency-free runner for Claude Code trials against the sibling
[`lemmascript-dafny-benchmark`](https://github.com/midspiral/lemmascript-dafny-benchmark) checkout. It creates isolated attempts, records
external wall-clock time and Claude's event stream, freezes each candidate, and
scores it with the benchmark's authoritative checker.

The project does not contain credentials.

## Available profiles

| Profile | Provider and model | Required credentials |
| --- | --- | --- |
| `anthropic-opus` | Anthropic, current Claude Opus alias | Claude subscription OAuth |
| `synthetic-kimi` | Synthetic, `syn:large:vision` | `SYNTHETIC_API_KEY` |
| `synthetic-qwen` | Synthetic, `syn:small:vision` | `SYNTHETIC_API_KEY` |
| `qwen` | Alibaba Cloud Model Studio, `qwen3.8-27b` | `QWEN_WORKSPACE_ID` and `QWEN_API_KEY` |
| `ollama-qwen` | Local Ollama, `qwen3.8:latest` | None; Ollama must be running locally |

The `anthropic-opus` profile uses the current Claude Code subscription session.
It removes custom Anthropic and Synthetic provider credentials before launching
Claude Code.

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

The `synthetic-qwen` profile uses the same Synthetic endpoint and API key,
but maps the main model and subagents to Synthetic's `syn:small:vision` alias,
which currently resolves to `hf:Qwen/Qwen3.8-27B`:

```text
ANTHROPIC_BASE_URL=https://api.synthetic.new/anthropic
ANTHROPIC_AUTH_TOKEN=$SYNTHETIC_API_KEY
ANTHROPIC_DEFAULT_OPUS_MODEL=syn:small:vision
ANTHROPIC_DEFAULT_SONNET_MODEL=syn:small:vision
ANTHROPIC_DEFAULT_HAIKU_MODEL=syn:small:text
CLAUDE_CODE_SUBAGENT_MODEL=syn:small:vision
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

These variables configure the upstream connection. The runner automatically
starts a local compatibility proxy for `synthetic-qwen`.
Synthetic's Qwen backend currently rejects mid-conversation system messages and
hides the error behind an empty HTTP 500 when streaming. The proxy responds to
those requests with HTTP 400 and `capability_rejected: mid_conv_system`, which
makes Claude Code regenerate the request using its own older reminder format.
Accepted request bodies and streaming responses pass through unchanged. This
uses Claude Code's [capability-error fallback](https://code.claude.com/docs/en/llm-gateway-protocol#automatic-retry-and-error-forwarding),
verified with Claude Code 2.1.261 on September 11, 2026.

The proxy binds to `127.0.0.1` on a temporary port and stops when the trial ends.
It keeps the Synthetic key in the runner and gives Claude a temporary proxy
token, which the subprocess scrub also hides from tools. The run configuration
records the compatibility setting; each trial records how many requests were
rejected locally or forwarded. The existing `--profile synthetic-qwen` command
needs no additional setup. To retest native provider support after a fix, remove
that profile's `compatibility` block in `profiles.json`.

For [Alibaba Cloud](https://www.alibabacloud.com/campaign/benefits?referral_code=A9274E)
(referral link), the `qwen` profile expects `QWEN_WORKSPACE_ID` and
`QWEN_API_KEY` in the launching environment and implements this mapping:

```text
ANTHROPIC_BASE_URL=https://${QWEN_WORKSPACE_ID}.ap-southeast-1.maas.aliyuncs.com/apps/anthropic
ANTHROPIC_AUTH_TOKEN=$QWEN_API_KEY
ANTHROPIC_MODEL=qwen3.8-27b
ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3.8-27b
ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3.8-27b
ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3.6-flash
CLAUDE_CODE_SUBAGENT_MODEL=qwen3.8-27b
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

`QWEN_API_KEY` is removed from the environment passed to Claude after it is
copied to `ANTHROPIC_AUTH_TOKEN`.

The `ollama-qwen` profile connects Claude Code to Ollama's local
Anthropic-compatible endpoint. It expects Ollama at `http://localhost:11434`
and the model tag `qwen3.8:latest`; no user credential is required. The profile
implements this mapping:

```text
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=http://localhost:11434
ANTHROPIC_MODEL=qwen3.8:latest
ANTHROPIC_SMALL_FAST_MODEL=qwen3.8:latest
ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3.8:latest
ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3.8:latest
ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3.8:latest
CLAUDE_CODE_SUBAGENT_MODEL=qwen3.8:latest
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

The `ollama` auth token is required by the Anthropic client but ignored by the
local Ollama server.

## Inspect and plan

No installation is needed beyond the benchmark's own prerequisites.

```sh
npm run list

npm run plan -- \
  --profile anthropic-opus \
  --tasks 32,19,6,24

npm run plan -- \
  --profile synthetic-kimi \
  --tasks 32,19,6,24

npm run plan -- \
  --profile synthetic-qwen \
  --tasks 32,19,6,24

npm run plan -- \
  --profile qwen \
  --tasks 32,19,6,24

npm run plan -- \
  --profile ollama-qwen \
  --tasks 32,19,6,24
```

Planning is read-only: it validates task IDs and prints the exact non-secret
configuration without creating attempts or contacting a model.

## Run

Run a selected pilot:

```sh
npm run run -- \
  --profile anthropic-opus \
  --tasks 32,19,6,24
```

Run Kimi through Synthetic:

```sh
npm run run -- \
  --profile synthetic-kimi \
  --tasks 32,19,6,24
```

Run Qwen through Synthetic:

```sh
npm run run -- \
  --profile synthetic-qwen \
  --tasks 32,19,6,24
```

Run the Qwen profile:

```sh
npm run run -- \
  --profile qwen \
  --tasks 32,19,6,24
```

Run the local Ollama Qwen profile:

```sh
npm run run -- \
  --profile ollama-qwen \
  --tasks 32,19,6,24
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
- a continuously updated `usage.json`, including partial accounting on timeout;
- parsed independent check result(s);
- a full-context `diff.patch`;
- `result.json`, the immutable trial manifest.

The runner regenerates `summary.json` and `summary.csv` after every completed
trial. `results/` is ignored because raw transcripts can be large; copy a
reviewed result set elsewhere before publishing it.

## Usage and cost after timeouts

The runner captures detailed Claude stream events and checkpoints `usage.json`
as usage arrives. At exit, including a timeout, that accounting is also embedded
in `result.json` as `agent.accounting` and indexed in `summary.csv` and
[`records/usage.csv`](records/usage.csv).

Repeated message IDs are counted once. Input and cache counts come from message
usage; output counts come from cumulative `message_delta` events. Ordinary
assistant-message output counts are placeholders and are discarded. When a
final result is available, its `modelUsage` totals cover all models, including
auxiliary calls. See [Claude's cost-tracking documentation](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

Every report distinguishes `final` from `partial` usage. An interrupted request
may not have emitted its output count, and internal or unforwarded subagent
requests may be absent. Unknown counts are `null`, not zero. Cost status is
`reported-estimate`, `estimated`, `partial-estimate`, or `unavailable`.
`unpriced` lists any missing counts or prices; a partial estimate covers only
the components that could be priced.

[`pricing.json`](pricing.json) contains dated, provider-specific USD rates per
million tokens for concrete model IDs. Each run snapshots its selected rates.
The initial catalog covers Opus 5 and Synthetic's Kimi K3; add rates when a
provider changes its models. Unknown models never inherit a moving alias's
price. Claude's reported cost is also a client estimate; these amounts do not
represent confirmed subscription charges. Rates come from
[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) and
[Synthetic](https://synthetic.new/pricing?initial=usage).

Inspect saved usage without contacting a model, including older timed-out runs:

```sh
npm run usage -- results/RUN_ID/tasks/0008/trial-01
```

To save a separate report, add `--out NEW_FILE`. Existing files are never
overwritten. Reports bind the source stream and any finalized result by SHA-256.
They use the run's saved rates when available; older runs use the current
catalog and record `pricingSource: "current-catalog"`. An explicit
`--pricing-file FILE` overrides the rate catalog, using the same schema as
`pricing.json`. Old streams without detailed usage events can recover input
tokens, but cannot recover final output tokens or a complete cost total.

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
