import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

export const locCountingMethod = "dafny-added-source-v1";
// Physical source lines inserted by git diff --no-index --minimal. Excludes blank lines
// and comments; includes helper declarations and braces in the final candidate.
export const locHeaders = Object.freeze([
  "record_id", "recorded_at", "run_id", "task_id", "trial", "counting_method",
  "status", "added_dafny_lines", "task_sha256", "candidate_sha256", "diff_sha256",
  "reason", "result_path", "result_sha256",
]);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function parseCsv(text, expectedHeaders) {
  const records = [];
  let fields = [], value = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else value += c;
    } else if (c === "," || c === "\n" || c === "\r") {
      fields.push(value); value = ""; closed = false;
      if (c !== ",") {
        if (fields.length > 1 || fields[0] !== "") records.push(fields);
        fields = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else if (c === '"' && !value && !closed) quoted = true;
    else if (closed || c === '"') throw new Error("Malformed CSV quoting");
    else value += c;
  }
  if (quoted) throw new Error("Truncated CSV");
  if (fields.length || value || closed) records.push([...fields, value]);
  const headers = records.shift();
  if (!headers?.length || new Set(headers).size !== headers.length ||
      (expectedHeaders && JSON.stringify(headers) !== JSON.stringify(expectedHeaders))) throw new Error("Unexpected CSV schema");
  return records.map(row => {
    if (row.length !== headers.length) throw new Error("Malformed CSV row");
    return Object.fromEntries(headers.map((key, i) => [key, row[i]]));
  });
}

/** Keep physical positions while skipping comments and respecting quoted text. */
export function dafnySourceLines(text) {
  const lines = new Set();
  let i = 0, line = 1;
  const advance = () => { if (text[i++] === "\n") line++; };
  while (i < text.length) {
    if (/\s/.test(text[i])) { advance(); continue; }
    if (text.startsWith("//", i)) { while (i < text.length && text[i] !== "\n") advance(); continue; }
    if (text.startsWith("/*", i)) {
      let depth = 1;
      advance(); advance();
      while (depth && i < text.length) {
        if (text.startsWith("/*", i)) { depth++; advance(); advance(); }
        else if (text.startsWith("*/", i)) { depth--; advance(); advance(); }
        else advance();
      }
      if (depth) throw new Error("unterminated-block-comment");
      continue;
    }
    const start = i, startLine = line;
    const verbatim = text.startsWith('@"', i);
    const charLiteral = text[i] === "'" && /^'(?:\\.|[^'\r\n])'/.test(text.slice(i));
    if (verbatim || text[i] === '"' || charLiteral) {
      if (verbatim) advance();
      const closing = text[i];
      advance();
      let closed = false;
      while (i < text.length) {
        if (verbatim && text.startsWith('""', i)) { advance(); advance(); continue; }
        if (text[i] === closing) { advance(); closed = true; break; }
        if (!verbatim && text[i] === "\\") { advance(); if (i < text.length) advance(); }
        else advance();
      }
      if (!closed) throw new Error("unterminated-string");
    } else if (/[\p{L}\p{N}_]/u.test(text[i])) {
      advance();
      while (i < text.length && /[\p{L}\p{N}_'.?!]/u.test(text[i])) advance();
    } else advance();
    for (const [offset, part] of text.slice(start, i).split("\n").entries()) {
      if (part.trim()) lines.add(startLine + offset);
    }
  }
  return lines;
}

/** The archived full-context diff contains the original task, including its EOF. */
export function baselineFromDiff(diff) {
  const parts = [];
  let active = false, previous;
  for (const text of diff.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (text.startsWith("@@ ")) { active = true; previous = undefined; }
    else if (active && (text.startsWith(" ") || text.startsWith("-"))) {
      parts.push(text.slice(1)); previous = text[0];
    } else if (active && text.startsWith("+")) previous = "+";
    else if (active && text.startsWith("\\ No newline") && (previous === " " || previous === "-")) {
      parts[parts.length - 1] = parts.at(-1).replace(/\n$/, "");
    }
  }
  return parts.join("");
}

export function countAddedDafnyLines(baseline, candidate) {
  const source = dafnySourceLines(candidate);
  const root = mkdtempSync(path.join(tmpdir(), "lsdb-locs-"));
  try {
    const before = path.join(root, "task.dfy"), after = path.join(root, "candidate.dfy");
    writeFileSync(before, baseline); writeFileSync(after, candidate);
    let diff;
    try {
      diff = execFileSync("git", ["diff", "--no-index", "--minimal", "--no-color", "--no-ext-diff", "--no-textconv", "--text", "--unified=0", "--", before, after], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1" },
      });
    } catch (error) {
      if (error.status !== 1 || error.signal || error.code || typeof error.stdout !== "string" || !error.stdout.startsWith("diff --git ")) throw new Error("git-diff-failed");
      diff = error.stdout;
    }
    let line, added = 0;
    for (const text of diff.split("\n")) {
      const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { line = Number(hunk[1]); continue; }
      if (line === undefined) continue;
      if (text.startsWith("+")) { if (source.has(line)) added++; line++; }
      else if (text.startsWith(" ")) line++;
    }
    return added;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function optionalRead(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function measureLocs({ result, resultPath, resultSha256, relativeResultPath, recordedAt }) {
  const row = {
    record_id: `${result.runId}/${String(result.task.id).padStart(4, "0")}/${String(result.trial).padStart(2, "0")}`,
    recorded_at: recordedAt, run_id: result.runId, task_id: String(result.task.id), trial: String(result.trial),
    counting_method: locCountingMethod, status: "unavailable", added_dafny_lines: "",
    task_sha256: result.task.taskSha256 ?? "", candidate_sha256: result.task.candidateSha256 ?? "", diff_sha256: "",
    reason: "", result_path: relativeResultPath, result_sha256: resultSha256,
  };
  if (!row.task_sha256 || !row.candidate_sha256) return { ...row, reason: "missing-source-hashes" };
  const directory = path.dirname(resultPath);
  const candidate = await optionalRead(path.join(directory, "candidate.dfy"));
  if (!candidate) return { ...row, reason: "missing-candidate" };
  if (sha256(candidate) !== row.candidate_sha256) throw new Error(`Candidate hash mismatch: ${row.record_id}`);
  let baseline = candidate;
  if (row.task_sha256 !== row.candidate_sha256) {
    const diff = await optionalRead(path.join(directory, "diff.patch"));
    if (!diff) return { ...row, reason: "missing-diff" };
    row.diff_sha256 = sha256(diff);
    baseline = Buffer.from(baselineFromDiff(diff.toString("utf8")));
    if (sha256(baseline) !== row.task_sha256) throw new Error(`Original-task hash mismatch in diff: ${row.record_id}`);
  }
  try {
    row.added_dafny_lines = String(countAddedDafnyLines(baseline.toString("utf8"), candidate.toString("utf8")));
    row.status = "measured";
  } catch (error) {
    if (!["unterminated-block-comment", "unterminated-string", "git-diff-failed"].includes(error.message)) throw error;
    row.reason = error.message;
  }
  return row;
}

export function locKey(row) { return JSON.stringify([row.record_id, row.counting_method]); }

/** Permit a later measurement to fill an unavailable entry; never lose a count. */
export function readLocIndex(contents) {
  const index = new Map();
  for (const row of parseCsv(contents, locHeaders)) {
    if (!["measured", "unavailable"].includes(row.status) ||
        (row.status === "measured" ? !/^\d+$/.test(row.added_dafny_lines) || row.reason !== "" : row.added_dafny_lines !== "" || !row.reason)) throw new Error(`Invalid LOC row: ${row.record_id}`);
    const key = locKey(row), previous = index.get(key);
    if (previous && (previous.result_sha256 !== row.result_sha256 || previous.status === "measured" || row.status !== "measured" ||
        ["task_sha256", "candidate_sha256"].some(field => previous[field] && previous[field] !== row[field]))) throw new Error(`Conflicting LOC rows: ${row.record_id}`);
    index.set(key, row);
  }
  return index;
}
