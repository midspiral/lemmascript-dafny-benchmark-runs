import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendFinalizedTrial, backfillLocs, reconcileTrialLedger } from "../ledger.mjs";
import { baselineFromDiff, countAddedDafnyLines, dafnySourceLines, locHeaders, parseCsv, readLocIndex } from "../locs.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const baseline = "lemma L()\n{\n}\n";
const candidate = "lemma L()\n{\n  assert true; // explanation\n}\n";
async function fixture(t, runId = "run", outcome = "auto-pass", projectRoot, trial = 1) {
  const root = projectRoot ?? await mkdtemp(path.join(tmpdir(), "lsdb-loc-test-"));
  if (!projectRoot) t.after(() => rm(root, { recursive: true, force: true }));
  const run = path.join(root, "results", runId), directory = path.join(run, "tasks", "0006", `trial-${String(trial).padStart(2, "0")}`);
  await mkdir(directory, { recursive: true });
  const before = path.join(directory, "task.dfy"), after = path.join(directory, "candidate.dfy");
  await writeFile(before, baseline); await writeFile(after, candidate);
  let diff;
  try { diff = execFileSync("git", ["diff", "--no-index", "--no-color", "-U1000000", "--", before, after], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { if (error.status !== 1) throw error; diff = error.stdout; }
  await writeFile(path.join(directory, "diff.patch"), diff);
  await rm(before); // Neither a benchmark checkout nor an attempt directory is needed.
  const runManifestPath = path.join(run, "run.json"), resultPath = path.join(directory, "result.json");
  await writeFile(runManifestPath, JSON.stringify({ configuration: { runId, runKind: "smoke", skills: [] } }));
  await writeFile(resultPath, JSON.stringify({ runId, task: { id: 6, file: "tasks/0006.dfy", taskSha256: hash(baseline), candidateSha256: hash(candidate) },
    trial, outcome, endedAt: "2026-09-01T00:01:00Z", agent: {} }));
  return { projectRoot: root, runManifestPath, resultPath, directory, run };
}
const locs = async root => parseCsv(await readFile(path.join(root, "records/locs.csv"), "utf8"), locHeaders);

test("LOC excludes nested comments, respects strings and primes, and counts final additions including braces", () => {
  const source = `lemma L(x': int)
{
  /* outer
     /* nested */
  */
  assert true; // explanation
  var s := "// /* literal */";
  var v := @"a ""quoted"" // value";
}
`;
  assert.deepEqual([...dafnySourceLines(source)], [1, 2, 6, 7, 8, 9]);
  assert.equal(countAddedDafnyLines("lemma L(x': int)\n{\n}\n", source), 3);
  assert.equal(countAddedDafnyLines(baseline, baseline + "lemma Helper()\n{\n}\n"), 3);
  assert.equal(countAddedDafnyLines(baseline, baseline.replace("L()", "Changed()")), 1);
  assert.equal(countAddedDafnyLines(baseline, baseline), 0);
  assert.throws(() => dafnySourceLines("/* missing end"), /unterminated-block/);
  assert.throws(() => dafnySourceLines('var x := "unfinished'), /unterminated-string/);
});

test("full-context baseline recovery preserves CRLF, deletions, and a missing final newline", () => {
  assert.equal(baselineFromDiff("--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\r\n-old\r\n+new\r\n end\n\\ No newline at end of file\n"), "a\r\nold\r\nend");
  assert.equal(baselineFromDiff("@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n"), "old");
  assert.equal(baselineFromDiff("@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n"), "old\n");
});

test("every finalized outcome and repeated trial records LOC automatically without duplicate rows", async t => {
  const first = await fixture(t);
  const writes = await Promise.all([appendFinalizedTrial(first), appendFinalizedTrial(first)]);
  assert.equal(writes.reduce((n, r) => n + r.locsAppended, 0), 1);
  const failed = await fixture(t, "failed", "failed", first.projectRoot);
  const timeout = await fixture(t, "timeout", "agent-timeout", first.projectRoot);
  const repeated = await fixture(t, "run", "auto-pass", first.projectRoot, 2);
  for (const f of [failed, timeout, repeated]) assert.equal((await appendFinalizedTrial(f)).locsAppended, 1);
  const rows = await locs(first.projectRoot);
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => r.status === "measured" && r.added_dafny_lines === "1"));
  assert.ok(rows.some(r => r.record_id === "run/0006/02"));
  assert.ok(rows.every(r => r.task_sha256 === hash(baseline) && r.candidate_sha256 === hash(candidate)));
  assert.ok(rows.every(r => !Object.values(r).some(value => value.includes("assert true"))));
  await writeFile(path.join(first.directory, "candidate.dfy"), "changed");
  await assert.rejects(appendFinalizedTrial(first), /Candidate hash mismatch/);
  assert.equal((await locs(first.projectRoot)).length, 4);
});

test("reconciliation repairs interrupted LOC writes and preserves counts without private files", async t => {
  const f = await fixture(t);
  await appendFinalizedTrial(f);
  const trialFile = path.join(f.projectRoot, "records/trials.csv"), locFile = path.join(f.projectRoot, "records/locs.csv");
  const trials = await readFile(trialFile, "utf8");
  await writeFile(locFile, locHeaders.join(",") + "\n");
  assert.equal((await reconcileTrialLedger({ projectRoot: f.projectRoot, resultsRoot: path.join(f.projectRoot, "results") })).locsAppended, 1);
  const saved = await readFile(locFile, "utf8");
  assert.equal((await appendFinalizedTrial(f)).locsAppended, 0);
  assert.equal(await readFile(locFile, "utf8"), saved);
  await rm(path.join(f.directory, "candidate.dfy"));
  assert.equal((await appendFinalizedTrial(f)).locsAppended, 0);
  await rm(f.run, { recursive: true });
  assert.deepEqual(await backfillLocs({ projectRoot: f.projectRoot }), { scanned: 1, appended: 0, measured: 1 });
  assert.equal(await readFile(locFile, "utf8"), saved);
  assert.equal(await readFile(trialFile, "utf8"), trials);
});

test("unavailable counts remain blank and can be filled after source recovery", async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, "candidate.dfy");
  await rm(file);
  await appendFinalizedTrial(f);
  assert.equal((await locs(f.projectRoot))[0].added_dafny_lines, "");
  assert.equal((await locs(f.projectRoot))[0].reason, "missing-candidate");
  await writeFile(file, candidate);
  assert.equal((await backfillLocs({ projectRoot: f.projectRoot })).appended, 1);
  const content = await readFile(path.join(f.projectRoot, "records/locs.csv"), "utf8");
  assert.equal(parseCsv(content, locHeaders).length, 2);
  assert.equal([...readLocIndex(content).values()][0].added_dafny_lines, "1");
  assert.equal((await backfillLocs({ projectRoot: f.projectRoot })).appended, 0);

  await writeFile(path.join(f.directory, "diff.patch"), "@@ -1 +1 @@\n-wrong\n+wrong\n");
  await assert.rejects(appendFinalizedTrial(f), /Original-task hash mismatch/);
  assert.equal(await readFile(path.join(f.projectRoot, "records/locs.csv"), "utf8"), content);
});

test("backfill covers archived trials but does not restore unrecorded results to the trial ledger", async t => {
  const current = await fixture(t, "current");
  const old = await fixture(t, "old", "auto-pass", current.projectRoot);
  await appendFinalizedTrial(current); await appendFinalizedTrial(old);
  await fixture(t, "unrecorded", "failed", current.projectRoot);
  const records = path.join(current.projectRoot, "records");
  const lines = (await readFile(path.join(records, "trials.csv"), "utf8")).trimEnd().split("\n");
  const currentCsv = `${lines[0]}\n${lines.find(l => l.startsWith("current/"))}\n`;
  const oldCsv = `${lines[0]}\n${lines.find(l => l.startsWith("old/"))}\n`;
  await writeFile(path.join(records, "trials.csv"), currentCsv);
  await writeFile(path.join(records, "trials-pre-context.csv"), oldCsv);
  const archive = path.join(current.projectRoot, "private-archive");
  await mkdir(archive);
  await rename(old.run, path.join(archive, "old"));
  await rm(path.join(records, "locs.csv"));
  assert.deepEqual(await backfillLocs({ projectRoot: current.projectRoot, preContextRoot: archive }), { scanned: 2, appended: 2, measured: 2 });
  assert.equal(await readFile(path.join(records, "trials.csv"), "utf8"), currentCsv);
  assert.equal(await readFile(path.join(records, "trials-pre-context.csv"), "utf8"), oldCsv);
  assert.equal((await locs(current.projectRoot)).length, 2);
});
