# Run protocol

This project runs Claude Code against a fixed checkout of
`lemmascript-dafny-benchmark`. The benchmark remains the authority for task
contents, per-task Dafny options, and the final verdict.

## Unit of evaluation

One trial is one fresh Claude Code session in one fresh attempt directory. It
has no conversation history and is never resumed. A trial ends when Claude Code
exits or when the external wall-clock limit expires.

Task 8 is excluded by default. It can only be selected with the explicit
`--include-excluded` flag.

## Time

`agentWallMilliseconds` is measured by this runner with a monotonic clock, from
immediately before spawning Claude Code until its process closes. It includes
startup, model requests, retries, tool calls, and cleanup performed before
Claude exits. Independent post-run validation is measured separately and is not
included in agent time.

At the time limit the runner sends `SIGTERM`, waits the configured grace period,
and then sends `SIGKILL` if necessary. The candidate present at the deadline is
still frozen and scored.

## Isolation

Attempts are created below the operating system's temporary directory, not
inside either repository. Claude Code receives no additional directories. Its
Bash sandbox:

- cannot read the user's home directory;
- cannot write `.bench/`;
- cannot make network requests;
- cannot opt out of the sandbox; and
- does not expose Anthropic or Synthetic credential variables to Bash, hooks,
  or stdio MCP servers. Claude Code's supported subprocess scrub preserves the
  credential only in the parent process that calls the model provider.

Subprocess scrubbing makes Claude Code require an explicit noninteractive tool
allowlist. The runner permits `Read`, `Edit`, `Write`, `Bash`, and `Task`; the
filesystem and network sandbox still bounds what those tools can access.

Web tools, Chrome, custom slash commands, user settings, and user MCP servers
are disabled. The main Claude Code process can still contact its configured
model provider.

The runner points the agent at tsx's loader form (`node --import ...`) because
the `npx tsx` CLI opens an IPC socket that strict Claude Code sandboxing blocks.
Git is given null global/system configuration inside the attempt so the copied
validator can diff the candidate without reading the user's home directory.

## Verdicts

Claude Code's exit code and final prose are not proof results. After the agent
stops, the runner copies `solution.dfy` into the result directory and invokes
the benchmark checkout's own `npm run check -- ... --json` command.

The automated outcomes are:

- `auto-pass`: the independent benchmark checker passed;
- `failed`: the independent checker ran and rejected the candidate;
- `agent-timeout`: the time budget expired and the frozen candidate did not
  pass;
- `infrastructure-error`: the attempt, agent, or authoritative checker could
  not run reliably.

An `auto-pass` is not yet a publishable success. The benchmark's proof-only rule
is intentionally stronger than its automatic approximation. Every passing diff
must receive a human review; until then, `manualProofOnlyReview` is `pending`.

Claude Code normally retries API failures with exponential backoff. A 401 or 403
cannot be repaired by retrying the same credentials, so the runner records the
first response, terminates that agent process, and aborts the remaining batch.
This prevents one invalid provider credential from consuming several minutes
for every selected task.

When validation reports only a Dafny timeout, the unchanged frozen candidate is
checked again up to the configured retry count. Every attempt is retained.

## Comparability

Runs are sequential. Each result records the benchmark commit and dirty state,
task and prompt hashes, tool versions, profile, non-secret provider settings,
requested and reported model, effort, usage metadata, and both agent and
validation time.

After a trial manifest is finalized, the runner appends an immutable summary row
to `records/trials.csv`. The manifest is authoritative; reconciliation can
recover a missing row but never changes an existing one. Human proof-only review
decisions are separate append-only events in `records/reviews.csv`.

The `opus` model name is intentionally an alias for the current Opus. The
reported concrete model and Claude Code version therefore matter when comparing
runs made at different times.
