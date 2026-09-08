import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createUsageTracker, readUsageStream } from "../usage.mjs";
import { spawnClaude } from "../run.mjs";
import { appendFinalizedTrial, reconcileTrialLedger, trialLedgerHeaders, usageLedgerHeaders } from "../ledger.mjs";

const pricing = {
  source: "test rate card", checkedAt: "2026-09-08",
  models: {
    model: { input: 2, output: 8, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  },
};
const assistant = (id, usage, extra = {}) => ({
  type: "assistant", session_id: "session", parent_tool_use_id: null,
  message: { id, model: "model", usage, content: [] }, ...extra,
});
const stream = (event, extra = {}) => ({
  type: "stream_event", session_id: "session", parent_tool_use_id: null, event, ...extra,
});
const start = (id, usage, extra) => stream({ type: "message_start", message: { id, model: "model", usage } }, extra);
const delta = (usage, extra) => stream({ type: "message_delta", usage }, extra);
const stop = extra => stream({ type: "message_stop" }, extra);

test("legacy assistant events recover input once per response and exclude output placeholders", () => {
  const tracker = createUsageTracker({ pricing });
  for (let i = 0; i < 3; i++) tracker.observe(assistant("a", { input_tokens: 100, output_tokens: 999 }));
  tracker.observe(assistant("b", { input_tokens: 50, output_tokens: 0 }));
  const report = tracker.snapshot();
  assert.equal(report.observedMessages, 2);
  assert.equal(report.usage.input_tokens, 150);
  assert.equal(report.usage.output_tokens, null);
  assert.equal(report.missingOutputMessages, 2);
  assert.equal(report.costUsd, 0.0003);
  assert.equal(report.costStatus, "partial-estimate");
  assert.equal(report.coverage, "partial");
});

test("stream usage is cumulative within each message and survives a timeout mid-response", () => {
  const tracker = createUsageTracker({ pricing });
  tracker.observe(start("a", { input_tokens: 100, output_tokens: 1 }));
  tracker.observe(delta({ output_tokens: 7 }));
  tracker.observe(delta({ output_tokens: 17 }));
  tracker.observe(delta({ output_tokens: 17 }));
  tracker.observe(stop());
  tracker.observe(assistant("a", { input_tokens: 100, output_tokens: 1 }));
  tracker.observe(start("b", { input_tokens: 150, output_tokens: 0 }));
  tracker.observe(delta({ output_tokens: 3 }));
  const report = tracker.snapshot();
  assert.equal(report.usage.input_tokens, 250);
  assert.equal(report.usage.output_tokens, 20);
  assert.equal(report.stoppedMessages, 1);
  assert.equal(report.observedMessages, 2);
  assert.equal(report.costUsd, 0.00066);
  assert.equal(report.costStatus, "partial-estimate");
});

test("interleaved subagent lanes and sessions do not mix or deduplicate unrelated responses", () => {
  const tracker = createUsageTracker();
  const child = { parent_tool_use_id: "child" };
  const session = { session_id: "different" };
  tracker.observe(start("same-id", { input_tokens: 10 }));
  tracker.observe(start("same-id", { input_tokens: 20 }, child));
  tracker.observe(start("same-id", { input_tokens: 30 }, session));
  tracker.observe(delta({ output_tokens: 1 }));
  tracker.observe(delta({ output_tokens: 2 }, child));
  tracker.observe(delta({ output_tokens: 3 }, session));
  tracker.observe(stop(child));
  tracker.observe(stop());
  tracker.observe(stop(session));
  assert.equal(tracker.snapshot().usage.input_tokens, 60);
  assert.equal(tracker.snapshot().usage.output_tokens, 6);
  assert.equal(tracker.snapshot().observedMessages, 3);
});

test("final all-model totals supersede the stream and include auxiliary models", () => {
  const tracker = createUsageTracker({ pricing });
  tracker.observe(assistant("a", { input_tokens: 100, output_tokens: 1 }));
  tracker.observe({
    type: "result", subtype: "success", total_cost_usd: 0.12,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: {
      model: { inputTokens: 100, outputTokens: 50, costBasis: "list" },
      helper: { inputTokens: 20, outputTokens: 5, costBasis: "list" },
    },
  });
  const report = tracker.snapshot();
  assert.equal(report.usage.input_tokens, 120);
  assert.equal(report.usage.output_tokens, 55);
  assert.equal(report.source, "result");
  assert.equal(report.scope, "all-models");
  assert.equal(report.costUsd, 0.12);
  assert.equal(report.costStatus, "reported-estimate");
});

test("a zeroed crash result cannot erase usage already received", () => {
  const tracker = createUsageTracker({ pricing });
  tracker.observe(start("a", { input_tokens: 100 }));
  tracker.observe(delta({ output_tokens: 20 }));
  tracker.observe({ type: "result", subtype: "error_during_execution", total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} });
  assert.equal(tracker.snapshot().usage.output_tokens, 20);
  assert.equal(tracker.snapshot().reportedCostUsd, null);
  assert.equal(tracker.snapshot().costUsd, 0.00036);
  assert.equal(tracker.snapshot().source, "stream");
  const noObservations = createUsageTracker();
  noObservations.observe({ type: "result", subtype: "error_during_execution", total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} });
  assert.equal(noObservations.snapshot().costUsd, null);
  assert.equal(noObservations.snapshot().source, "unavailable");
});

test("error results with real usage retain their reported cost", () => {
  const tracker = createUsageTracker();
  tracker.observe({ type: "result", subtype: "error_max_turns", total_cost_usd: 0.2,
    usage: { input_tokens: 100, output_tokens: 20 } });
  assert.equal(tracker.snapshot().usage.output_tokens, 20);
  assert.equal(tracker.snapshot().costUsd, 0.2);
});

test("unknown SDK model pricing falls back to the provider rate card", () => {
  const tracker = createUsageTracker({ pricing });
  tracker.observe({ type: "result", subtype: "success", total_cost_usd: 0,
    modelUsage: { model: { inputTokens: 100, outputTokens: 20, costBasis: "unknown" } } });
  const report = tracker.snapshot();
  assert.equal(report.reportedCostUsd, 0);
  assert.equal(report.costUsd, 0.00036);
  assert.equal(report.costStatus, "estimated");
});

test("unknown models are never assigned a known alias's price", () => {
  const tracker = createUsageTracker({ pricing });
  tracker.observe({ ...assistant("a", {}), message: { id: "a", model: "new-model", usage: { input_tokens: 200 } } });
  assert.equal(tracker.snapshot().costUsd, null);
  assert.equal(tracker.snapshot().costStatus, "unavailable");
});

test("cache TTLs are priced separately and absent output is distinct from a reported zero", () => {
  const tracker = createUsageTracker({ pricing });
  tracker.observe(start("a", { input_tokens: 100, cache_read_input_tokens: 50,
    cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } }));
  tracker.observe(delta({ output_tokens: 0 }));
  tracker.observe(stop());
  const report = tracker.snapshot();
  assert.equal(report.usage.output_tokens, 0);
  assert.equal(report.missingOutputMessages, 0);
  assert.equal(report.costUsd, 0.000315);
  const missingTtl = createUsageTracker({ pricing });
  missingTtl.observe(assistant("a", { input_tokens: 100, cache_creation_input_tokens: 30 }));
  assert.equal(missingTtl.snapshot().costUsd, 0.0002);
  assert.ok(missingTtl.snapshot().unpriced.some(message => message.includes("TTL")));
});

test("unknown usage, invalid counters, and unpriced billing modes cannot look free", () => {
  const tracker = createUsageTracker({ pricing });
  assert.equal(tracker.snapshot().usage.input_tokens, null);
  assert.equal(tracker.snapshot().costUsd, null);
  tracker.observe(start("a", { input_tokens: -1, output_tokens: NaN }));
  assert.equal(tracker.snapshot().usage.input_tokens, null);
  tracker.observe(delta({ input_tokens: 100, output_tokens: 20, speed: "fast" }));
  assert.equal(tracker.snapshot().costUsd, null);
});

test("orphan usage deltas are reported and not attributed to another message", () => {
  const tracker = createUsageTracker();
  tracker.observe(delta({ output_tokens: 500 }));
  assert.equal(tracker.snapshot().usage.output_tokens, null);
  assert.ok(tracker.snapshot().notes.some(note => note.includes("no matching message_start")));
});

test("saved stream replay preserves hashes and tolerates a truncated last event", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "lsdb-usage-replay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "events.jsonl");
  const raw = [start("a", { input_tokens: 100 }), delta({ output_tokens: 20 }), stop(),
    { type: "assistant", message: "Unicode: λ 🦊" }, null].map(e => JSON.stringify(e)).join("\n") + '\n{"type":';
  await writeFile(file, raw);
  const report = await readUsageStream(file, { pricing });
  assert.equal(report.streamSha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(report.accounting.usage.output_tokens, 20);
  assert.ok(report.accounting.notes.some(note => note.includes("1 malformed")));
});

test("a real child-process timeout saves usage before and after termination", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "lsdb-usage-timeout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "fake-claude.mjs");
  const events = [start("a", { input_tokens: 100 }), delta({ output_tokens: 17 }), stop()];
  await writeFile(fake, `#!/usr/bin/env node
if (!process.argv.includes('--include-partial-messages')) process.exit(19);
for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + '\\n');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const running = spawnClaude({
    profile: { command: fake, model: "model", environment: {} }, effort: "high", prompt: "fixture",
    attemptDir: dir, timeoutMilliseconds: 1200, graceSeconds: 0.1,
    stdoutPath: path.join(dir, "claude.stream.jsonl"), stderrPath: path.join(dir, "claude.stderr.log"), pricing,
  });
  let checkpoint;
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      checkpoint = JSON.parse(await readFile(path.join(dir, "usage.json"), "utf8"));
      if (checkpoint.usage.output_tokens === 17) break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const agent = await running;
  assert.equal(checkpoint?.usage.output_tokens, 17);
  assert.equal(agent.timedOut, true);
  assert.equal(agent.resultEvent, undefined);
  assert.equal(agent.usageWriteError, undefined);
  assert.equal(agent.accounting.usage.output_tokens, 17);
  assert.equal(agent.accounting.costUsd, 0.000336);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "usage.json"), "utf8")), agent.accounting);
  const replay = await readUsageStream(path.join(dir, "claude.stream.jsonl"), { pricing });
  assert.deepEqual(replay.accounting, agent.accounting);
});

test("recovery CLI uses pinned prices and refuses to overwrite an existing artifact", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "lsdb-usage-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const trial = path.join(dir, "tasks", "0008", "trial-01");
  await mkdir(trial, { recursive: true });
  await writeFile(path.join(dir, "run.json"), JSON.stringify({ configuration: { profile: "test", usagePricing: pricing } }));
  const original = JSON.stringify({ outcome: "agent-timeout" }) + "\n";
  await writeFile(path.join(trial, "result.json"), original);
  await writeFile(path.join(trial, "claude.stream.jsonl"), JSON.stringify(assistant("a", { input_tokens: 100, output_tokens: 0 })) + "\n");
  const output = path.join(trial, "usage-recovered.json");
  const exec = promisify(execFile);
  const args = [path.resolve("usage-report.mjs"), trial, "--out", output];
  await exec(process.execPath, args);
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(report.pricingSource, "run-snapshot");
  assert.equal(report.accounting.costUsd, 0.0002);
  assert.equal(report.accounting.usage.output_tokens, null);
  assert.equal(report.resultSha256, createHash("sha256").update(original).digest("hex"));
  await assert.rejects(exec(process.execPath, args), error => error.stderr.includes("EEXIST"));
  assert.equal(await readFile(path.join(trial, "result.json"), "utf8"), original);
});

test("usage ledger records partial cost separately and reconciles without changing trial history", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "lsdb-usage-ledger-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = path.join(dir, "results", "test-run");
  const trial = path.join(run, "tasks", "0008", "trial-01");
  await mkdir(trial, { recursive: true });
  const runManifestPath = path.join(run, "run.json");
  const resultPath = path.join(trial, "result.json");
  await writeFile(runManifestPath, JSON.stringify({ configuration: { runKind: "smoke" } }));
  const tracker = createUsageTracker({ pricing });
  tracker.observe(assistant("a", { input_tokens: 100, output_tokens: 0 }));
  await writeFile(resultPath, JSON.stringify({
    runId: "test-run", task: { id: 8 }, trial: 1, profile: "test", outcome: "agent-timeout",
    agent: { timedOut: true, accounting: tracker.snapshot() },
  }));
  const args = { projectRoot: dir, resultPath, runManifestPath };
  assert.equal((await appendFinalizedTrial(args)).usageAppended, 1);
  const trialsPath = path.join(dir, "records", "trials.csv");
  const usagePath = path.join(dir, "records", "usage.csv");
  const originalTrials = await readFile(trialsPath, "utf8");
  assert.equal(originalTrials.split("\n")[0], trialLedgerHeaders.join(","));
  const originalUsage = await readFile(usagePath, "utf8");
  const fields = originalUsage.split("\n")[1].split(",");
  const record = Object.fromEntries(usageLedgerHeaders.map((name, i) => [name, fields[i]]));
  assert.equal(record.usage_coverage, "partial");
  assert.equal(record.input_tokens, "100");
  assert.equal(record.output_tokens, "");
  assert.equal(record.cost_status, "partial-estimate");
  assert.equal(record.cost_usd, "0.0002");
  assert.equal((await appendFinalizedTrial(args)).usageAppended, 0);
  assert.equal(await readFile(usagePath, "utf8"), originalUsage);
  // Simulate interruption after trials.csv was appended but before usage.csv.
  await writeFile(usagePath, usageLedgerHeaders.join(",") + "\n");
  const reconciled = await reconcileTrialLedger({ projectRoot: dir, resultsRoot: path.join(dir, "results") });
  assert.equal(reconciled.appended, 0);
  assert.equal(reconciled.usageAppended, 1);
  assert.equal(await readFile(trialsPath, "utf8"), originalTrials);
  assert.equal((await readFile(usagePath, "utf8")).split("\n").filter(Boolean).length, 2);
  await writeFile(resultPath, JSON.stringify({ runId: "test-run", task: { id: 8 }, trial: 1, outcome: "changed" }));
  await assert.rejects(appendFinalizedTrial(args), /Immutable result changed/);
  assert.equal(await readFile(trialsPath, "utf8"), originalTrials);
});
