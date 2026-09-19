# Synthetic Qwen mid-conversation system message issue

Status: **still reproducible on September 19, 2026**. Keep the compatibility
proxy enabled for `synthetic-qwen` until direct support is verified.

Original report: [Synthetic Discord thread](https://discord.com/channels/1315627714056687706/1344871767000223804/threads/1545287581124530268).
The report used Claude Code 2.1.258, Synthetic's Anthropic endpoint, and
`syn:small:vision` (resolved model `hf:Qwen/Qwen3.8-27B`). Claude Code received
empty HTTP 500 responses before its first tool call when it sent a
mid-conversation system message.

## Retest periodically

Run this check weekly, after a relevant Synthetic fix is announced, and before
changing the proxy default:

```sh
./check-synthetic-qwen-issue.mjs
```

Requires `SYNTHETIC_API_KEY` in the environment and Node.js, like the runner.
The script sends two tiny requests directly to Synthetic, bypassing the local
proxy, with `max_tokens: 1`, a 30-second timeout per request, and no retries.
It does not start Claude Code, edit profiles, or create benchmark records.
No automatic schedule is installed; update the latest result below after retesting.

| Exit code | Meaning | Next step |
| --- | --- | --- |
| `0` | Both requests returned HTTP 200 and complete SSE messages without error events. | Smoke-test Claude Code directly before making the proxy optional. |
| `1` | The original request returned an empty HTTP 500 while the control succeeded. | Keep the proxy enabled. |
| `2` | Inconclusive: missing credentials, network failure, rate limit, failed control, or changed response. | Inspect the output and retest or investigate the changed behavior. |

A descriptive 4xx response is a change worth investigating, but does not itself
prove native support. If it reports `capability_rejected: mid_conv_system`,
check whether Claude Code can now fall back successfully without the local proxy.

## Exact reproducer

Both requests use:

- `POST https://api.synthetic.new/anthropic/v1/messages?beta=true`
- `Authorization: Bearer $SYNTHETIC_API_KEY`
- `anthropic-version: 2023-06-01`
- `anthropic-beta: mid-conversation-system-2026-04-07`
- `content-type: application/json`

```json
{
  "model": "syn:small:vision",
  "max_tokens": 1,
  "stream": true,
  "messages": [
    { "role": "user", "content": "Reply OK" },
    { "role": "system", "content": "Continue." }
  ]
}
```

The control removes only the second message. A successful check validates the
stream through `message_stop`, rather than relying on HTTP 200 alone.

## Latest result

Checked with `./check-synthetic-qwen-issue.mjs` on **2026-09-19 at 16:57 UTC**
(exit code `1`):

| Request | HTTP status | Response |
| --- | --- | --- |
| Original, with the system message | `500` | Empty body (0 bytes). |
| Control, without the system message | `200` | Complete SSE stream (965 bytes), model `hf:Qwen/Qwen3.8-27B`. |

## Current workaround and removal criteria

The `synthetic-qwen` compatibility block in [profiles.json](profiles.json)
starts [anthropic-proxy.mjs](anthropic-proxy.mjs). It returns HTTP 400 with
`capability_rejected: mid_conv_system` for affected requests, so Claude Code
regenerates them using its older reminder format. Other accepted bodies and
streaming responses pass through unchanged.

Once the check succeeds, run a short Claude Code diagnostic directly against
Synthetic that reaches a tool call and its follow-up response. Confirm the
reported model and absence of the repeated HTTP 500 failure. Then add an explicit
proxy opt-out for `synthetic-qwen`, record the choice in run configurations, and
retain the workaround for regressions. Update this note and the README with the
verified date and Claude Code version.
