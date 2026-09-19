import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createSkillTracker, inspectRun, parseSkillsCsv, skillHeaders, skillsCsv } from "../skill-report.mjs";
import { appendFinalizedTrial, reconcileTrialLedger } from "../ledger.mjs";

const init = skills => ({ type: "system", subtype: "init", skills });
const call = (id = "skill-1", skill = "dafny") => ({
  type: "assistant", session_id: "session", parent_tool_use_id: null,
  message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill } }] },
});
const response = (id = "skill-1", success = true) => ({
  type: "user", session_id: "session", parent_tool_use_id: null,
  tool_use_result: { success, commandName: "dafny" },
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !success,
    content: success ? "Launching skill: dafny" : "Unknown skill: dafny" }] },
});
const injection = (skill = "dafny") => ({
  type: "user", session_id: "session", isSynthetic: true,
  message: { content: [{ type: "text", text: `Base directory for this skill: /attempt/.claude/skills/${skill}\n\n# Instructions\nDo the proof.` }] },
});
const done = { type: "result", subtype: "success" };
const observe = (tracker, events) => events.forEach((event, index) => tracker.observe(event, index + 1));

test("advertised, invoked, successful, and injected are independent logged states", () => {
  const tracker = createSkillTracker("dafny");
  observe(tracker, [init(["dafny"]), done]);
  let row = tracker.snapshot();
  assert.equal(row.skill_available, "yes");
  assert.equal(row.skill_invoked, "no");
  assert.equal(row.skill_invocation_succeeded, "no");
  assert.equal(row.skill_instructions_injected, "no");

  tracker.observe(call(), 3);
  row = tracker.snapshot();
  assert.equal(row.skill_invoked, "yes");
  assert.equal(row.skill_invocation_succeeded, "no");
  tracker.observe(response(), 4);
  row = tracker.snapshot();
  assert.equal(row.skill_invocation_succeeded, "yes");
  assert.equal(row.skill_instructions_injected, "no");
  tracker.observe(injection(), 5);
  row = tracker.snapshot();
  assert.equal(row.skill_instructions_injected, "yes");
  assert.equal(row.invocation_lines, "3");
  assert.equal(row.success_lines, "4");
  assert.equal(row.instruction_lines, "5");
});

test("deduplicates completed calls and ignores partial inputs, other skills, and subagents", () => {
  const tracker = createSkillTracker("dafny");
  const child = { parent_tool_use_id: "child" };
  observe(tracker, [init(["dafny"]),
    { type: "stream_event", event: { type: "content_block_start", content_block: call().message.content[0] } },
    call(), call(), response(), response(), injection(),
    call("other", "different"), { ...call("child"), ...child },
    { ...response("child"), ...child }, { ...injection(), ...child }, done]);
  const row = tracker.snapshot();
  assert.equal(row.invocation_count, 1);
  assert.equal(row.successful_invocation_count, 1);
  assert.equal(row.invocation_lines, "3");
  assert.equal(row.success_lines, "5");
  assert.equal(row.instruction_lines, "7");
});

test("failed or unrelated responses and ordinary quoted instructions cannot count as success", () => {
  const tracker = createSkillTracker("dafny");
  observe(tracker, [init(["dafny"]), call(), response("skill-1", false), response("unrelated"),
    { ...injection(), isSynthetic: false }, injection("different"), done]);
  const row = tracker.snapshot();
  assert.equal(row.skill_invoked, "yes");
  assert.equal(row.skill_invocation_succeeded, "no");
  assert.equal(row.skill_instructions_injected, "no");
  const otherName = createSkillTracker("other:dafny");
  observe(otherName, [init(["dafny"]), injection(), done]);
  assert.equal(otherName.snapshot().skill_instructions_injected, "no");
});

test("incomplete evidence remains unknown while positive evidence and saved init survive", () => {
  const tracker = createSkillTracker("dafny", init(["dafny"]));
  assert.equal(tracker.snapshot({ streamPresent: false }).skill_available, "yes");
  assert.equal(tracker.snapshot({ streamPresent: false }).skill_invoked, "unknown");
  assert.equal(tracker.snapshot({ streamPresent: false }).stream_status, "missing");
  observe(tracker, [init(["dafny"]), call()]);
  assert.equal(tracker.snapshot().skill_invoked, "yes");
  assert.equal(tracker.snapshot().skill_invocation_succeeded, "unknown");
  tracker.observe(done, 3);
  assert.equal(tracker.snapshot({ malformedLines: 1 }).skill_invocation_succeeded, "unknown");
  assert.equal(tracker.snapshot({ malformedLines: 1 }).stream_status, "malformed");
  const injectedOnly = createSkillTracker("dafny");
  injectedOnly.observe(injection(), 8);
  assert.equal(injectedOnly.snapshot().skill_instructions_injected, "yes");
  assert.equal(injectedOnly.snapshot().skill_invoked, "unknown");
});

test("matches responses by session and tool ID, including older launch responses", () => {
  const tracker = createSkillTracker("dafny");
  observe(tracker, [init([]), call(), { ...response(), session_id: "different-session" }, done]);
  assert.equal(tracker.snapshot().skill_available, "no");
  assert.equal(tracker.snapshot().skill_invocation_succeeded, "no");
  const legacy = response();
  delete legacy.tool_use_result;
  tracker.observe(legacy, 5);
  assert.equal(tracker.snapshot().skill_invocation_succeeded, "yes");
});

test("CLI reports stored trials and unfinished logs, exports evidence, and protects historical files", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "lsdb-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trial = path.join(root, "tasks", "0055", "trial-01");
  const unfinished = path.join(root, "tasks", "0057", "trial-01");
  const missing = path.join(root, "tasks", "0061", "trial-01");
  await mkdir(trial, { recursive: true });
  await mkdir(unfinished, { recursive: true });
  await mkdir(missing, { recursive: true });
  const run = JSON.stringify({ configuration: { runId: "test,run", profile: "test", skills: ["/skills/dafny"] } });
  const result = JSON.stringify({ runId: "test,run", task: { id: 55 }, trial: 1, outcome: "auto-pass", agent: { initEvent: init(["dafny"]) } });
  const stream = [init(["dafny"]), call(), response(), injection(), done].map(JSON.stringify).join("\n") + "\n";
  await writeFile(path.join(root, "run.json"), run);
  await writeFile(path.join(trial, "result.json"), result);
  await writeFile(path.join(missing, "result.json"), JSON.stringify({
    runId: "test,run", task: { id: 61 }, trial: 1,
    agent: { initEvent: init(["dafny"]) }, outcome: "auto-pass",
  }));
  await writeFile(path.join(trial, "claude.stream.jsonl"), stream);
  await writeFile(path.join(unfinished, "claude.stream.jsonl"), JSON.stringify(init(["dafny"])) + '\n{"type":');

  const rows = await inspectRun(root, ["dafny"], root);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].skill_configured, "yes");
  assert.equal(rows[0].skill_instructions_injected, "yes");
  assert.equal(rows[0].stream_sha256, createHash("sha256").update(stream).digest("hex"));
  assert.equal(rows[0].result_sha256, createHash("sha256").update(result).digest("hex"));
  assert.equal(rows[1].outcome, "unfinished");
  assert.equal(rows[1].stream_status, "malformed");
  assert.equal(rows[1].skill_invoked, "unknown");
  assert.equal(rows[2].stream_status, "missing");
  assert.equal(rows[2].skill_available, "yes");
  assert.equal(rows[2].skill_invoked, "unknown");
  assert.equal(rows[2].available_evidence, "result.json#agent.initEvent.skills");
  assert.ok(skillsCsv(rows).includes('"test,run/0055/01"'));

  const exec = promisify(execFile);
  const script = path.resolve("skill-report.mjs");
  const out = path.join(root, "skills.csv");
  const { stdout } = await exec(process.execPath, [script, root]);
  assert.match(stdout, /succeeded/);
  await exec(process.execPath, [script, root, "--out", out]);
  assert.equal((await readFile(out, "utf8")).split("\n")[0], skillHeaders.join(","));
  await assert.rejects(exec(process.execPath, [script, root, "--out", out]), error => error.stderr.includes("EEXIST"));
  await assert.rejects(exec(process.execPath, [script, "update"]), error => error.stderr.includes("recorded automatically"));
  await assert.rejects(exec(process.execPath, [script, root, "--out", out, "--force"]), error => error.stderr.includes("Unknown argument"));
  await assert.rejects(exec(process.execPath, [script, root, "--out", path.join(trial, "result.json")]), error => error.stderr.includes("EEXIST"));
  assert.equal(await readFile(path.join(trial, "result.json"), "utf8"), result);
  assert.equal(await readFile(path.join(trial, "claude.stream.jsonl"), "utf8"), stream);
  assert.equal(await readFile(path.join(root, "run.json"), "utf8"), run);
});

test("skill CSV index round-trips quoted evidence and rejects truncated or malformed rows", () => {
  const row = Object.fromEntries(skillHeaders.map(key => [key, ""]));
  Object.assign(row, { record_id: "run/0055/01", skill: "dafny", stream_path: 'results/a,"b\nc/stream.jsonl' });
  assert.deepEqual(parseSkillsCsv(skillsCsv([row])), [row]);
  assert.throws(() => parseSkillsCsv(skillsCsv([row]) + '"truncated'), /Truncated/);
  assert.throws(() => parseSkillsCsv(skillHeaders.join(",") + '\nwrong,row\n'), /Malformed/);
});

test("finalization appends skills with trials, preserves remote rows, and reconciles missing skill records", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "lsdb-skill-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, "results", "local");
  const trialDir = path.join(runDir, "tasks", "0055", "trial-01");
  await mkdir(trialDir, { recursive: true });
  const runManifestPath = path.join(runDir, "run.json");
  const resultPath = path.join(trialDir, "result.json");
  const streamPath = path.join(trialDir, "claude.stream.jsonl");
  await writeFile(runManifestPath, JSON.stringify({ configuration: {
    runId: "local", runKind: "smoke", skills: ["/skills/dafny", "/skills/extra"],
  } }));
  const result = JSON.stringify({ runId: "local", task: { id: 55 }, trial: 1,
    outcome: "auto-pass", agent: { initEvent: init(["dafny", "extra"]) } });
  const stream = [init(["dafny", "extra"]), call(), response(), injection(), done].map(JSON.stringify).join("\n") + "\n";
  await writeFile(resultPath, result);
  await writeFile(streamPath, stream);
  const args = { projectRoot: root, resultPath, runManifestPath };
  // Concurrent recording shares the existing ledger lock and cannot duplicate rows.
  const appended = await Promise.all([appendFinalizedTrial(args), appendFinalizedTrial(args)]);
  assert.equal(appended.reduce((sum, row) => sum + row.appended, 0), 1);
  assert.equal(appended.reduce((sum, row) => sum + row.skillsAppended, 0), 2);
  const skillsPath = path.join(root, "records", "skills.csv");
  const trialsPath = path.join(root, "records", "trials.csv");
  const originalSkills = await readFile(skillsPath, "utf8");
  const originalTrials = await readFile(trialsPath, "utf8");
  const rows = parseSkillsCsv(originalSkills);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].skill, "dafny");
  assert.equal(rows[0].skill_instructions_injected, "yes");
  assert.equal(rows[1].skill, "extra");
  assert.equal(rows[1].skill_available, "yes");
  assert.equal(rows[1].skill_invoked, "no");

  // An incomplete local copy must not replace evidence already in the ledger.
  await rm(streamPath);
  assert.equal((await appendFinalizedTrial(args)).skillsAppended, 0);
  assert.equal(await readFile(skillsPath, "utf8"), originalSkills);
  await writeFile(streamPath, stream);

  // Simulate a trial row written before its skill rows, plus a row from another
  // machine whose results do not exist locally.
  const remote = { ...rows[0], record_id: "remote/0057/01", run_id: "remote", task_id: "57",
    result_path: "results/remote/tasks/0057/trial-01/result.json" };
  const remoteCsv = skillsCsv([remote]);
  await writeFile(skillsPath, remoteCsv);
  const reconciled = await reconcileTrialLedger({ projectRoot: root, resultsRoot: path.join(root, "results") });
  assert.equal(reconciled.appended, 0);
  assert.equal(reconciled.skillsAppended, 2);
  const recovered = await readFile(skillsPath, "utf8");
  assert.ok(recovered.startsWith(remoteCsv));
  assert.equal(parseSkillsCsv(recovered).length, 3);
  assert.equal(await readFile(trialsPath, "utf8"), originalTrials);
  assert.equal((await reconcileTrialLedger({ projectRoot: root, resultsRoot: path.join(root, "results") })).skillsAppended, 0);
  assert.equal(await readFile(skillsPath, "utf8"), recovered);

  await writeFile(resultPath, result + "\n");
  await assert.rejects(appendFinalizedTrial(args), /Immutable result changed/);
  assert.equal(await readFile(skillsPath, "utf8"), recovered);
  assert.equal(await readFile(trialsPath, "utf8"), originalTrials);

  // A machine with none of the source runs retains every existing skill row.
  await rm(runDir, { recursive: true });
  assert.equal((await reconcileTrialLedger({ projectRoot: root, resultsRoot: path.join(root, "results") })).skillsAppended, 0);
  assert.equal(await readFile(skillsPath, "utf8"), recovered);
});

test("legacy unfinished skill snapshots remain intact when the finalized trial is recorded", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "lsdb-skill-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, "results", "legacy");
  const trialDir = path.join(runDir, "tasks", "0055", "trial-01");
  await mkdir(trialDir, { recursive: true });
  await mkdir(path.join(root, "records"));
  const runManifestPath = path.join(runDir, "run.json");
  await writeFile(runManifestPath, JSON.stringify({ configuration: { runId: "legacy", runKind: "smoke" } }));
  const [unfinished] = await inspectRun(runDir, ["dafny"], root);
  const skillsPath = path.join(root, "records", "skills.csv");
  const original = skillsCsv([unfinished]);
  await writeFile(skillsPath, original);
  const resultPath = path.join(trialDir, "result.json");
  await writeFile(resultPath, JSON.stringify({ runId: "legacy", task: { id: 55 }, trial: 1,
    outcome: "infrastructure-error", agent: {} }));
  const args = { projectRoot: root, resultPath, runManifestPath };
  assert.equal((await appendFinalizedTrial(args)).skillsAppended, 1);
  const recorded = await readFile(skillsPath, "utf8");
  assert.ok(recorded.startsWith(original));
  assert.equal(parseSkillsCsv(recorded).length, 2);
  assert.equal((await appendFinalizedTrial(args)).skillsAppended, 0);
  assert.equal(await readFile(skillsPath, "utf8"), recorded);
});
