#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
export const skillHeaders = [
  "record_id", "run_id", "task_id", "trial", "profile", "outcome", "skill",
  "skill_configured", "skill_available", "skill_invoked", "skill_invocation_succeeded", "skill_instructions_injected",
  "invocation_count", "successful_invocation_count", "available_evidence",
  "invocation_lines", "success_lines", "instruction_lines", "stream_status",
  "stream_path", "stream_sha256", "result_path", "result_sha256",
];

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const content = event => {
  const blocks = event.message?.content;
  return typeof blocks === "string" ? [{ type: "text", text: blocks }] : Array.isArray(blocks) ? blocks : [];
};
const textContent = blocks => typeof blocks === "string" ? blocks :
  Array.isArray(blocks) ? blocks.filter(block => block.type === "text").map(block => block.text).join("\n") : "";

// Inspect main-agent events only. Partial stream_event tool inputs are deliberately
// ignored: the completed assistant message contains the authoritative tool call.
export function createSkillTracker(skill, savedInit) {
  const calls = new Map();
  const instructions = new Set();
  let available;
  let availableEvidence = "";
  let sawInit = false;
  let sawResult = false;

  function observeInit(event, evidence) {
    if (!Array.isArray(event?.skills)) return;
    available = event.skills.includes(skill);
    availableEvidence = evidence;
  }
  observeInit(savedInit, "result.json#agent.initEvent.skills");

  return {
    observe(event, line) {
      if (event.parent_tool_use_id != null) return;
      if (event.type === "system" && event.subtype === "init") {
        sawInit = true;
        observeInit(event, `claude.stream.jsonl:${line}`);
      }
      if (event.type === "result") sawResult = true;
      if (event.type === "assistant") {
        for (const block of content(event)) {
          if (block.type !== "tool_use" || block.name !== "Skill" || block.input?.skill !== skill || !block.id) continue;
          const key = JSON.stringify([event.session_id ?? "", block.id]);
          if (!calls.has(key)) calls.set(key, { line, successLine: null });
        }
      }
      if (event.type !== "user") return;
      for (const block of content(event)) {
        if (block.type === "tool_result") {
          const key = JSON.stringify([event.session_id ?? "", block.tool_use_id]);
          const call = calls.get(key);
          const result = event.tool_use_result;
          if (call && !block.is_error && result?.success !== false &&
              ((result?.success === true && result.commandName === skill) ||
               textContent(block.content).trim() === `Launching skill: ${skill}`)) {
            call.successLine ??= line;
          }
        }
        if (block.type === "text" && event.isSynthetic === true) {
          const match = /^Base directory for this skill: ([^\r\n]+)\r?\n\s*\n(\S[\s\S]*)/.exec(block.text ?? "");
          // Match the exact local skill directory name recorded by the runner.
          const base = match?.[1].trim().replaceAll("\\", "/").replace(/\/$/, "").split("/").at(-1);
          if (base === skill) {
            instructions.add(line);
          }
        }
      }
    },
    snapshot({ streamPresent = true, malformedLines = 0 } = {}) {
      const complete = streamPresent && sawInit && sawResult && malformedLines === 0;
      const observed = condition => condition ? "yes" : complete ? "no" : "unknown";
      const successLines = [...calls.values()].flatMap(call => call.successLine ? [call.successLine] : []);
      return {
        skill_available: available === undefined ? "unknown" : available ? "yes" : "no",
        skill_invoked: observed(calls.size > 0),
        skill_invocation_succeeded: observed(successLines.length > 0),
        skill_instructions_injected: observed(instructions.size > 0),
        invocation_count: calls.size,
        successful_invocation_count: successLines.length,
        available_evidence: availableEvidence,
        invocation_lines: [...calls.values()].map(call => call.line).join(";"),
        success_lines: successLines.join(";"),
        instruction_lines: [...instructions].join(";"),
        stream_status: !streamPresent ? "missing" : malformedLines ? "malformed" : complete ? "complete" : "partial",
      };
    },
  };
}

async function optionalFile(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function directories(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export async function inspectTrial(trialDir, run, skills = ["dafny"], root = projectRoot) {
  const resultPath = path.join(trialDir, "result.json");
  const resultBytes = await optionalFile(resultPath);
  const result = resultBytes ? JSON.parse(resultBytes) : null;
  const streamPath = path.join(trialDir, "claude.stream.jsonl");
  const trackers = skills.map(skill => createSkillTracker(skill, result?.agent?.initEvent));
  const hash = createHash("sha256");
  let streamPresent = true;
  let malformedLines = 0;
  let lineNumber = 0;
  const input = createReadStream(streamPath);
  input.on("data", bytes => hash.update(bytes));
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      lineNumber++;
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { malformedLines++; continue; }
      if (!event || typeof event !== "object" || Array.isArray(event)) { malformedLines++; continue; }
      for (const tracker of trackers) tracker.observe(event, lineNumber);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    streamPresent = false;
  } finally { input.destroy(); }

  const config = run.configuration ?? {};
  const runId = result?.runId ?? config.runId ?? path.basename(path.resolve(trialDir, "../../.."));
  const task = result?.task?.id ?? Number(path.basename(path.dirname(trialDir)));
  const trial = result?.trial ?? Number(path.basename(trialDir).slice("trial-".length));
  return skills.map((skill, index) => ({
    record_id: `${runId}/${String(task).padStart(4, "0")}/${String(trial).padStart(2, "0")}`,
    run_id: runId, task_id: task, trial,
    profile: result?.profile ?? config.profile ?? "",
    outcome: result?.outcome ?? "unfinished",
    skill,
    skill_configured: (config.skills ?? []).some(dir => path.basename(dir) === skill) ? "yes" : "no",
    ...trackers[index].snapshot({ streamPresent, malformedLines }),
    stream_path: path.relative(root, streamPath),
    stream_sha256: streamPresent ? hash.copy().digest("hex") : "",
    result_path: resultBytes ? path.relative(root, resultPath) : "",
    result_sha256: resultBytes ? sha256(resultBytes) : "",
  }));
}

export async function inspectRun(runDir, skills = ["dafny"], root = projectRoot) {
  const run = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  const rows = [];
  const tasksDir = path.join(runDir, "tasks");
  for (const task of await directories(tasksDir)) {
    if (!/^\d+$/.test(task)) continue;
    for (const trial of await directories(path.join(tasksDir, task))) {
      if (!/^trial-\d+$/.test(trial)) continue;
      rows.push(...await inspectTrial(path.join(tasksDir, task, trial), run, skills, root));
    }
  }
  return rows;
}

export function skillsCsv(rows) {
  const cell = value => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [skillHeaders.join(","), ...rows.map(row => skillHeaders.map(key => cell(row[key])).join(","))].join("\n") + "\n";
}

export function parseSkillsCsv(text) {
  const records = [];
  let fields = [], value = "", quoted = false, closedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else value += char;
    } else if (char === "," || char === "\n" || char === "\r") {
      fields.push(value); value = ""; closedQuote = false;
      if (char !== ",") {
        if (fields.length > 1 || fields[0] !== "") records.push(fields);
        fields = [];
        if (char === "\r" && text[i + 1] === "\n") i++;
      }
    } else if (char === '"' && !value && !closedQuote) quoted = true;
    else if (closedQuote || char === '"') throw new Error("Malformed skill CSV quoting");
    else value += char;
  }
  if (quoted) throw new Error("Truncated skill CSV");
  if (fields.length || value || closedQuote) records.push([...fields, value]);
  const headers = records.shift();
  if (JSON.stringify(headers) !== JSON.stringify(skillHeaders)) throw new Error("Unexpected skill ledger schema");
  return records.map(row => {
    if (row.length !== skillHeaders.length) throw new Error("Malformed skill ledger row");
    return Object.fromEntries(skillHeaders.map((key, i) => [key, row[i]]));
  });
}

async function main(argv) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: npm run skills -- RUN_ID_OR_DIRECTORY [--skill NAME] [--csv] [--out FILE]
       npm run skills -- --all [--skill NAME] [--out NEW_FILE]

Reads saved main-agent logs; makes no model requests. Skill defaults to dafny;
repeat --skill to inspect multiple skills. --all scans local results, including
unfinished attempts. --out creates a new CSV without overwriting existing files.
records/skills.csv is appended automatically when each trial is recorded.
Use npm run reconcile to backfill missing skill rows for finalized local trials.

Available = advertised in init.skills. Invoked = Skill tool call observed.
Invocation succeeded = matching successful Skill response.
Instructions injected = synthetic skill instructions observed in the conversation.
No claim is made about whether the advice was followed or helped performance.
Missing, partial, or malformed logs yield unknown for unobserved states.`);
    return;
  }
  if (argv[0] === "update") {
    throw new Error("Skill rows are now recorded automatically; use npm run reconcile to backfill historical trials");
  }
  let target, out;
  let all = false, csv = false;
  const skills = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") all = true;
    else if (arg === "--csv") csv = true;
    else if (["--skill", "--out"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--skill") skills.push(value);
      else out = path.resolve(value);
    } else if (!arg.startsWith("-") && !target) target = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (Boolean(target) === all) throw new Error("Specify one run or --all");
  const names = [...new Set(skills.length ? skills : ["dafny"])];
  const resultsRoot = path.join(projectRoot, "results");
  let runDirs;
  if (all) runDirs = (await directories(resultsRoot)).map(name => path.join(resultsRoot, name));
  else {
    const direct = path.resolve(target);
    runDirs = [await optionalFile(path.join(direct, "run.json")) ? direct : path.join(resultsRoot, target)];
  }
  const rows = [];
  for (const dir of runDirs) {
    if (all && !(await optionalFile(path.join(dir, "run.json")))) continue;
    rows.push(...await inspectRun(dir, names));
  }
  if (out) {
    await writeFile(out, skillsCsv(rows), { flag: "wx" });
    console.log(`Skill report: ${out} (${rows.length} rows)`);
  } else if (csv) process.stdout.write(skillsCsv(rows));
  else {
    console.table(rows.map(row => ({
      run: row.run_id, task: row.task_id, trial: row.trial, skill: row.skill,
      available: row.skill_available, invoked: row.skill_invoked,
      succeeded: row.skill_invocation_succeeded, instructions: row.skill_instructions_injected, log: row.stream_status,
    })));
    console.log("Succeeded = successful Skill response; instructions = injected skill text. Advice-following is not inferred.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`error: ${error.message ?? error}`);
    process.exitCode = 1;
  });
}
