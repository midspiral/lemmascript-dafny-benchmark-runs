import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const validRunKinds = new Set(["benchmark", "smoke", "diagnostic"]);

export const trialLedgerHeaders = Object.freeze([
  "record_id",
  "recorded_at",
  "started_at",
  "ended_at",
  "run_id",
  "task_id",
  "trial",
  "profile",
  "reported_model",
  "effort",
  "run_kind",
  "outcome",
  "agent_wall_seconds",
  "validation_wall_seconds",
  "added_code_lines",
  "input_tokens",
  "output_tokens",
  "reported_cost_usd",
  "benchmark_commit",
  "candidate_sha256",
  "result_path",
  "result_sha256",
]);

export const reviewLedgerHeaders = Object.freeze([
  "review_id",
  "recorded_at",
  "record_id",
  "candidate_sha256",
  "decision",
  "reviewer",
  "notes",
]);

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function pathExists(file) {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function seconds(milliseconds) {
  return milliseconds === undefined || milliseconds === null
    ? undefined
    : (milliseconds / 1000).toFixed(3);
}

function padTask(id) {
  return String(id).padStart(4, "0");
}

function padTrial(trial) {
  return String(trial).padStart(2, "0");
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function withLedgerLock(recordsRoot, action) {
  await mkdir(recordsRoot, { recursive: true });
  const lockPath = path.join(recordsRoot, ".ledger.lock");
  const deadline = Date.now() + 10_000;
  let handle;

  for (;;) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ledger lock ${lockPath}; remove it if no runner is active`);
      }
      await delay(100);
    }
  }

  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
    await handle.sync();
    return await action();
  } finally {
    await handle.close();
    try {
      await unlink(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function ensureCsv(file, headers) {
  const expectedHeader = headers.join(",");
  let handle;
  try {
    handle = await open(file, "wx");
    await handle.writeFile(`${expectedHeader}\n`);
    await handle.sync();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    if (handle) await handle.close();
  }

  const actualHeader = (await readFile(file, "utf8")).split(/\r?\n/, 1)[0];
  if (actualHeader !== expectedHeader) {
    throw new Error(`Unexpected ledger schema in ${file}`);
  }
}

function inferRunKind(result, runManifest) {
  const explicit = result.runKind ?? runManifest.configuration?.runKind;
  if (explicit !== undefined) {
    if (!validRunKinds.has(explicit)) throw new Error(`Unknown run kind ${JSON.stringify(explicit)}`);
    return explicit;
  }
  if (result.runId?.startsWith("debug-")) return "diagnostic";
  if (result.runId?.startsWith("fake-")) return "smoke";
  return "benchmark";
}

function finalValidationResult(result) {
  const attempts = result.validation?.attempts ?? [];
  for (let index = attempts.length - 1; index >= 0; index--) {
    if (attempts[index]?.result) return attempts[index].result;
  }
  return undefined;
}

function validationWallMilliseconds(result) {
  if (result.validation?.totalWallMilliseconds !== undefined) {
    return result.validation.totalWallMilliseconds;
  }
  const attempts = result.validation?.attempts ?? [];
  if (!attempts.some(attempt => attempt.wallMilliseconds !== undefined)) return undefined;
  return attempts.reduce((total, attempt) => total + (attempt.wallMilliseconds ?? 0), 0);
}

function recordId(result) {
  if (!result.runId || !Number.isInteger(result.task?.id) || !Number.isInteger(result.trial)) {
    throw new Error("Result manifest lacks runId, integer task.id, or integer trial");
  }
  return `${result.runId}/${padTask(result.task.id)}/${padTrial(result.trial)}`;
}

async function buildTrialRecord({ projectRoot, resultPath, runManifestPath, recordedAt = new Date().toISOString() }) {
  const [resultBytes, runBytes] = await Promise.all([
    readFile(resultPath),
    readFile(runManifestPath),
  ]);
  const result = JSON.parse(resultBytes.toString("utf8"));
  const runManifest = JSON.parse(runBytes.toString("utf8"));
  const id = recordId(result);
  const relativeResultPath = path.relative(projectRoot, resultPath);
  if (relativeResultPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeResultPath)) {
    throw new Error(`Cannot publish a ledger path outside the runner repository: ${resultPath}; use --no-ledger`);
  }

  const check = finalValidationResult(result);
  const usage = result.agent?.resultEvent?.usage;
  const resultSha256 = sha256Bytes(resultBytes);
  const row = [
    id,
    recordedAt,
    result.startedAt,
    result.endedAt,
    result.runId,
    result.task.id,
    result.trial,
    result.profile,
    result.agent?.initEvent?.model,
    result.effort,
    inferRunKind(result, runManifest),
    result.outcome,
    seconds(result.agent?.wallMilliseconds),
    seconds(validationWallMilliseconds(result)),
    check?.additions?.addedCodeLines,
    usage?.input_tokens,
    usage?.output_tokens,
    result.agent?.resultEvent?.total_cost_usd,
    runManifest.configuration?.benchmarkCommit,
    result.task?.candidateSha256,
    relativeResultPath.split(path.sep).join("/"),
    resultSha256,
  ];

  return {
    id,
    endedAt: result.endedAt ?? "",
    resultSha256,
    line: row.map(csvCell).join(","),
  };
}

function readTrialIndex(contents, file) {
  const lines = contents.split(/\r?\n/).filter(Boolean);
  const expectedHeader = trialLedgerHeaders.join(",");
  if (lines.shift() !== expectedHeader) throw new Error(`Unexpected ledger schema in ${file}`);
  const records = new Map();
  for (const line of lines) {
    const firstComma = line.indexOf(",");
    const lastComma = line.lastIndexOf(",");
    if (firstComma <= 0 || lastComma <= firstComma) throw new Error(`Malformed trial ledger row in ${file}`);
    const id = line.slice(0, firstComma);
    const resultSha256 = line.slice(lastComma + 1);
    if (records.has(id)) throw new Error(`Duplicate trial ledger record ${id}`);
    records.set(id, resultSha256);
  }
  return records;
}

async function appendRecords({ projectRoot, records }) {
  const recordsRoot = path.join(projectRoot, "records");
  const trialLedgerPath = path.join(recordsRoot, "trials.csv");
  const reviewLedgerPath = path.join(recordsRoot, "reviews.csv");

  return withLedgerLock(recordsRoot, async () => {
    await Promise.all([
      ensureCsv(trialLedgerPath, trialLedgerHeaders),
      ensureCsv(reviewLedgerPath, reviewLedgerHeaders),
    ]);
    const index = readTrialIndex(await readFile(trialLedgerPath, "utf8"), trialLedgerPath);
    const missing = [];

    for (const record of records.sort((a, b) => a.endedAt.localeCompare(b.endedAt) || a.id.localeCompare(b.id))) {
      const recordedSha = index.get(record.id);
      if (recordedSha !== undefined) {
        if (recordedSha !== record.resultSha256) {
          throw new Error(`Immutable result changed after ledgering: ${record.id}`);
        }
        continue;
      }
      index.set(record.id, record.resultSha256);
      missing.push(record.line);
    }

    if (missing.length) {
      const handle = await open(trialLedgerPath, "a");
      try {
        await handle.writeFile(`${missing.join("\n")}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return { appended: missing.length, alreadyRecorded: records.length - missing.length };
  });
}

export async function appendFinalizedTrial({ projectRoot, resultPath, runManifestPath }) {
  const record = await buildTrialRecord({ projectRoot, resultPath, runManifestPath });
  return appendRecords({ projectRoot, records: [record] });
}

async function resultPathsInRun(runRoot) {
  const taskRoot = path.join(runRoot, "tasks");
  if (!(await pathExists(taskRoot))) return [];
  const resultPaths = [];
  for (const taskName of (await readdir(taskRoot)).sort()) {
    const taskDir = path.join(taskRoot, taskName);
    if (!(await stat(taskDir)).isDirectory()) continue;
    for (const trialName of (await readdir(taskDir)).sort()) {
      const trialDir = path.join(taskDir, trialName);
      if (!(await stat(trialDir)).isDirectory()) continue;
      const resultPath = path.join(trialDir, "result.json");
      if (await pathExists(resultPath)) resultPaths.push(resultPath);
    }
  }
  return resultPaths;
}

export async function reconcileTrialLedger({ projectRoot, resultsRoot }) {
  const records = [];
  if (await pathExists(resultsRoot)) {
    for (const runName of (await readdir(resultsRoot)).sort()) {
      const runRoot = path.join(resultsRoot, runName);
      if (!(await stat(runRoot)).isDirectory()) continue;
      const runManifestPath = path.join(runRoot, "run.json");
      if (!(await pathExists(runManifestPath))) continue;
      for (const resultPath of await resultPathsInRun(runRoot)) {
        records.push(await buildTrialRecord({ projectRoot, resultPath, runManifestPath }));
      }
    }
  }
  return {
    scanned: records.length,
    ...(await appendRecords({ projectRoot, records })),
  };
}
