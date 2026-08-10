#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  createWriteStream,
  readFileSync,
} from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { finished } from "node:stream/promises";
import { arch, homedir, hostname, platform, release, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultBenchmarkRoot = path.resolve(projectRoot, "..", "lemmascript-dafny-benchmark");
const defaultResultsRoot = path.join(projectRoot, "results");
const protocolPath = path.join(projectRoot, "protocol.json");
const profilesPath = path.join(projectRoot, "profiles.json");
const validEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);
const commonAgentEnvironment = Object.freeze({
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  DISABLE_AUTOUPDATER: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  TSX_DISABLE_CACHE: "1",
});

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node run.mjs --list [--benchmark-root PATH]
  node run.mjs --dry-run --profile NAME (--tasks IDS | --all) [options]
  node run.mjs --profile NAME (--tasks IDS | --all) [options]

Selection:
  --tasks 31,19,6,24          comma-separated task IDs, in run order
  --all                       all tasks except protocol exclusions
  --include-excluded          permit an explicitly selected excluded task

Run options:
  --profile NAME              profile from profiles.json
  --repeat N                  fresh trials per task (default: 1)
  --timeout-minutes N         agent wall-clock limit
  --validation-timeout-minutes N
  --validation-timeout-retries N
  --effort LEVEL              low, medium, high, xhigh, or max
  --run-id NAME               stable run name; existing completed trials are skipped
  --keep-attempts             retain temporary attempt directories

Paths:
  --benchmark-root PATH       default: ${defaultBenchmarkRoot}
  --results-root PATH         default: ${defaultResultsRoot}

Other:
  --dry-run                   validate and print a plan; write nothing
  --list                      list tasks and exclusions; write nothing
  --help`);
  process.exit(exitCode);
}

function parseInteger(name, raw, { min = 0 } = {}) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parsePositiveNumber(name, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseArgs(argv, protocol) {
  const options = {
    benchmarkRoot: defaultBenchmarkRoot,
    resultsRoot: defaultResultsRoot,
    repeat: 1,
    timeoutMinutes: protocol.defaultTimeoutMinutes,
    validationTimeoutMinutes: protocol.defaultValidationTimeoutMinutes,
    validationTimeoutRetries: protocol.defaultValidationTimeoutRetries,
    effort: protocol.defaultEffort,
    includeExcluded: false,
    keepAttempts: false,
    dryRun: false,
    list: false,
    all: false,
  };

  const valueFor = (arg, index) => {
    const equals = arg.indexOf("=");
    if (equals !== -1) return { value: arg.slice(equals + 1), consumed: 0 };
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    return { value: next, consumed: 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--include-excluded") {
      options.includeExcluded = true;
      continue;
    }
    if (arg === "--keep-attempts") {
      options.keepAttempts = true;
      continue;
    }

    const key = arg.split("=", 1)[0];
    const valued = new Set([
      "--benchmark-root",
      "--results-root",
      "--profile",
      "--tasks",
      "--repeat",
      "--timeout-minutes",
      "--validation-timeout-minutes",
      "--validation-timeout-retries",
      "--effort",
      "--run-id",
    ]);
    if (!valued.has(key)) throw new Error(`Unknown option: ${arg}`);
    const { value, consumed } = valueFor(arg, i);
    i += consumed;

    switch (key) {
      case "--benchmark-root": options.benchmarkRoot = path.resolve(value); break;
      case "--results-root": options.resultsRoot = path.resolve(value); break;
      case "--profile": options.profile = value; break;
      case "--tasks": options.tasks = value; break;
      case "--repeat": options.repeat = parseInteger(key, value, { min: 1 }); break;
      case "--timeout-minutes": options.timeoutMinutes = parsePositiveNumber(key, value); break;
      case "--validation-timeout-minutes": options.validationTimeoutMinutes = parsePositiveNumber(key, value); break;
      case "--validation-timeout-retries": options.validationTimeoutRetries = parseInteger(key, value); break;
      case "--effort": options.effort = value; break;
      case "--run-id": options.runId = value; break;
    }
  }

  if (!validEfforts.has(options.effort)) {
    throw new Error(`--effort must be one of ${[...validEfforts].join(", ")}`);
  }
  if (options.runId && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.runId)) {
    throw new Error("--run-id may contain only letters, digits, dot, underscore, and hyphen");
  }
  return options;
}

function jsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(file) {
  return sha256Bytes(await readFile(file));
}

function nowIso() {
  return new Date().toISOString();
}

function generatedRunId(profile) {
  return `${nowIso().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${profile}`;
}

function padTask(id) {
  return String(id).padStart(4, "0");
}

function padTrial(trial) {
  return String(trial).padStart(2, "0");
}

function elapsedMilliseconds(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

async function pathExists(file) {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

function shellDisplay(argv) {
  return argv.map(value => /^[A-Za-z0-9_./:=,-]+$/.test(value) ? value : JSON.stringify(value)).join(" ");
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process has already exited.
    }
  }
}

async function spawnCapture(command, args, options = {}) {
  const started = process.hrtime.bigint();
  let timedOut = false;
  let spawnError;
  let stdout = "";
  let stderr = "";
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: platform() !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("error", error => { spawnError = error; });

  let forceTimer;
  const timeout = options.timeoutMilliseconds
    ? setTimeout(() => {
        timedOut = true;
        killProcessGroup(child, "SIGTERM");
        forceTimer = setTimeout(
          () => killProcessGroup(child, "SIGKILL"),
          (options.graceSeconds ?? 10) * 1000,
        );
      }, options.timeoutMilliseconds)
    : undefined;

  const closed = await new Promise(resolve => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  if (timeout) clearTimeout(timeout);
  if (forceTimer) clearTimeout(forceTimer);

  return {
    ...closed,
    timedOut,
    spawnError: spawnError ? String(spawnError.message ?? spawnError) : undefined,
    wallMilliseconds: Math.round(elapsedMilliseconds(started)),
    stdout,
    stderr,
  };
}

async function commandVersion(command, args, cwd) {
  const result = await spawnCapture(command, args, { cwd, timeoutMilliseconds: 15_000 });
  return {
    command: shellDisplay([command, ...args]),
    ok: result.code === 0 && !result.spawnError && !result.timedOut,
    value: (result.stdout || result.stderr).trim().split("\n")[0] || null,
    exitCode: result.code,
    error: result.spawnError,
  };
}

async function preflight(benchmarkRoot, metadata) {
  for (const relative of ["package.json", "metadata.json", "PROMPT.md", "bin/check.ts", "bin/make-attempt.ts"]) {
    const file = path.join(benchmarkRoot, relative);
    if (!(await pathExists(file))) throw new Error(`Benchmark file not found: ${file}`);
  }

  const [claude, dafny, node, tsx, git, commit, dirty] = await Promise.all([
    commandVersion("claude", ["--version"], benchmarkRoot),
    commandVersion("dafny", ["--version"], benchmarkRoot),
    commandVersion("node", ["--version"], benchmarkRoot),
    // `tsx --version` starts tsx's IPC machinery on some releases. Presence on
    // PATH is the preflight fact we need, and checking it avoids creating a
    // socket merely to print a version.
    commandVersion("which", ["tsx"], benchmarkRoot),
    commandVersion("git", ["--version"], benchmarkRoot),
    spawnCapture("git", ["rev-parse", "HEAD"], { cwd: benchmarkRoot, timeoutMilliseconds: 15_000 }),
    spawnCapture("git", ["status", "--porcelain"], { cwd: benchmarkRoot, timeoutMilliseconds: 15_000 }),
  ]);

  for (const tool of [claude, dafny, node, tsx, git]) {
    if (!tool.ok) throw new Error(`Preflight failed: ${tool.command}: ${tool.error ?? tool.value ?? `exit ${tool.exitCode}`}`);
  }
  const foundDafny = dafny.value?.trim().split(/\s+/)[0]?.split("+")[0];
  if (foundDafny !== metadata.dafnyVersion.split("+")[0]) {
    throw new Error(`Expected Dafny ${metadata.dafnyVersion}, found ${dafny.value}`);
  }
  if (commit.code !== 0) throw new Error(`Could not read benchmark commit: ${commit.stderr.trim()}`);
  if (dirty.code !== 0) throw new Error(`Could not read benchmark status: ${dirty.stderr.trim()}`);

  const tsxExecutable = tsx.value;
  const tsxCli = await realpath(tsxExecutable);
  const tsxLoader = path.join(path.dirname(tsxCli), "loader.mjs");
  if (!(await pathExists(tsxLoader))) {
    throw new Error(`Could not locate the tsx loader beside ${tsxCli}`);
  }

  return {
    checkedAt: nowIso(),
    tools: { claude, dafny, node, tsx, git },
    benchmarkCommit: commit.stdout.trim(),
    benchmarkDirty: dirty.stdout.trim().length > 0,
    benchmarkStatus: dirty.stdout.trim().split("\n").filter(Boolean),
    attemptCheckerCommand: shellDisplay(["node", "--import", tsxLoader, ".bench/check.ts"]),
    host: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      arch: arch(),
    },
  };
}

function selectTasks(options, metadata, excludedIds) {
  if (options.all && options.tasks) throw new Error("Choose either --all or --tasks, not both");
  if (!options.all && !options.tasks) throw new Error("Choose tasks with --tasks IDS or --all");
  const byId = new Map(metadata.tasks.map(task => [task.id, task]));

  if (options.all) return metadata.tasks.filter(task => !excludedIds.has(task.id));

  const ids = options.tasks.split(",").filter(Boolean).map(raw => parseInteger("task ID", raw, { min: 1 }));
  if (ids.length === 0) throw new Error("--tasks did not contain any IDs");
  if (new Set(ids).size !== ids.length) throw new Error("--tasks contains duplicate IDs");
  return ids.map(id => {
    const task = byId.get(id);
    if (!task) throw new Error(`No benchmark task ${id}`);
    if (excludedIds.has(id) && !options.includeExcluded) {
      throw new Error(`Task ${id} is excluded by protocol; pass --include-excluded to name it explicitly`);
    }
    return task;
  });
}

function publicProfile(profile) {
  return {
    description: profile.description,
    command: profile.command,
    model: profile.model,
    auth: profile.auth,
    environment: profile.environment,
    secretMappings: Object.fromEntries(
      Object.entries(profile.environmentFromSecret ?? {}).map(([target, source]) => [target, `<from ${source}>`]),
    ),
  };
}

function buildProfileEnvironment(profile) {
  const missing = (profile.requiredEnvironment ?? []).filter(name => !process.env[name]);
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);

  const env = { ...process.env };
  for (const name of profile.unsetEnvironment ?? []) delete env[name];
  for (const [name, value] of Object.entries(profile.environment ?? {})) env[name] = String(value);
  for (const [target, source] of Object.entries(profile.environmentFromSecret ?? {})) {
    env[target] = process.env[source];
    if (profile.dropSecretSources) delete env[source];
  }
  Object.assign(env, commonAgentEnvironment);
  return env;
}

function renderAgentPrompt(template, checkerCommand) {
  const rendered = template.replaceAll("{{CHECK_COMMAND}}", checkerCommand);
  const unresolved = [...rendered.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]);
  if (unresolved.length) throw new Error(`Unknown agent prompt placeholder(s): ${unresolved.join(", ")}`);
  return rendered;
}

function permissionAbsolute(file) {
  return file.startsWith("/") ? `/${file}` : file;
}

function claudeSettings(attemptDir) {
  const benchDir = path.join(attemptDir, ".bench");
  return {
    permissions: {
      deny: [
        `Read(${permissionAbsolute(path.join(homedir(), "**"))})`,
        "Edit(/.bench/**)",
        "WebFetch",
        "WebSearch",
      ],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [homedir()],
        denyWrite: [benchDir],
        allowRead: [attemptDir],
      },
      network: {
        allowedDomains: [],
        strictAllowlist: true,
      },
      credentials: {
        envVars: [
          { name: "ANTHROPIC_API_KEY", mode: "deny" },
          { name: "ANTHROPIC_AUTH_TOKEN", mode: "deny" },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" },
          { name: "SYNTHETIC_API_KEY", mode: "deny" },
        ],
      },
    },
  };
}

function claudeArguments(profile, effort, prompt, attemptDir) {
  return [
    "--model", profile.model,
    "--effort", effort,
    "--setting-sources", "project",
    "--settings", JSON.stringify(claudeSettings(attemptDir)),
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--prompt-suggestions", "false",
    "--permission-mode", "acceptEdits",
    "--output-format", "stream-json",
    "--verbose",
    "-p", prompt,
  ];
}

async function spawnClaude({ profile, effort, prompt, attemptDir, timeoutMilliseconds, graceSeconds, stdoutPath, stderrPath }) {
  const args = claudeArguments(profile, effort, prompt, attemptDir);
  const env = buildProfileEnvironment(profile);
  const stdoutFile = createWriteStream(stdoutPath, { flags: "wx" });
  const stderrFile = createWriteStream(stderrPath, { flags: "wx" });
  const started = process.hrtime.bigint();
  let timedOut = false;
  let spawnError;
  let lineBuffer = "";
  let initEvent;
  let resultEvent;
  let malformedEventLines = 0;
  let lastActivity = "startup";

  const child = spawn(profile.command, args, {
    cwd: attemptDir,
    env,
    detached: platform() !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const inspectLine = line => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "system" && event.subtype === "init") initEvent = event;
      if (event.type === "result") resultEvent = event;
      if (event.type === "assistant") {
        for (const content of event.message?.content ?? []) {
          if (content.type !== "tool_use") continue;
          const command = content.name === "Bash" && typeof content.input?.command === "string"
            ? `: ${content.input.command.replace(/\s+/g, " ").slice(0, 120)}`
            : "";
          lastActivity = `${content.name}${command}`;
          console.log(`    ${(elapsedMilliseconds(started) / 1000).toFixed(1)}s Claude tool ${lastActivity}`);
        }
      }
    } catch {
      malformedEventLines++;
    }
  };

  child.stdout.on("data", chunk => {
    stdoutFile.write(chunk);
    lineBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = lineBuffer.indexOf("\n");
      if (newline === -1) break;
      inspectLine(lineBuffer.slice(0, newline));
      lineBuffer = lineBuffer.slice(newline + 1);
    }
  });
  child.stderr.on("data", chunk => stderrFile.write(chunk));
  child.on("error", error => { spawnError = error; });

  let forceTimer;
  const heartbeat = setInterval(() => {
    console.log(`    ${(elapsedMilliseconds(started) / 1000).toFixed(1)}s Claude still running; last activity: ${lastActivity}`);
  }, 30_000);
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child, "SIGTERM");
    forceTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), graceSeconds * 1000);
  }, timeoutMilliseconds);

  const closed = await new Promise(resolve => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  clearInterval(heartbeat);
  if (forceTimer) clearTimeout(forceTimer);
  if (lineBuffer) inspectLine(lineBuffer);
  stdoutFile.end();
  stderrFile.end();
  await Promise.all([finished(stdoutFile), finished(stderrFile)]);

  return {
    ...closed,
    command: profile.command,
    arguments: args,
    timedOut,
    spawnError: spawnError ? String(spawnError.message ?? spawnError) : undefined,
    wallMilliseconds: Math.round(elapsedMilliseconds(started)),
    initEvent,
    resultEvent,
    malformedEventLines,
  };
}

function parseJsonOutput(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error("command produced no JSON object");
  return JSON.parse(stdout.slice(start));
}

async function authoritativeCheck({ benchmarkRoot, taskId, candidatePath, timeoutMilliseconds, graceSeconds, trialDir, index }) {
  const run = await spawnCapture(
    "npm",
    ["run", "--silent", "check", "--", String(taskId), candidatePath, "--json"],
    { cwd: benchmarkRoot, timeoutMilliseconds, graceSeconds },
  );
  await writeFile(path.join(trialDir, `check-${index}.stdout.log`), run.stdout);
  await writeFile(path.join(trialDir, `check-${index}.stderr.log`), run.stderr);

  let parsed;
  let parseError;
  try {
    parsed = parseJsonOutput(run.stdout);
    await writeJsonAtomic(path.join(trialDir, `check-${index}.json`), parsed);
  } catch (error) {
    parseError = String(error.message ?? error);
  }
  return {
    exitCode: run.code,
    signal: run.signal,
    timedOut: run.timedOut,
    spawnError: run.spawnError,
    wallMilliseconds: run.wallMilliseconds,
    parseError,
    result: parsed,
  };
}

function checkHitTimeout(check) {
  return Boolean(check.timedOut || check.result?.verify?.timedOut || check.result?.verify?.timeouts > 0);
}

function checkInfrastructureFailure(check) {
  return Boolean(
    check.spawnError ||
    check.timedOut ||
    check.parseError ||
    !check.result ||
    check.result.additions?.status === "not-run" ||
    check.result.verify?.status === "not-run"
  );
}

async function fullDiff(benchmarkRoot, taskFile, candidatePath, trialDir) {
  const original = path.join(benchmarkRoot, taskFile);
  const diff = await spawnCapture(
    "git",
    ["diff", "--no-index", "--no-color", "-U1000000", "--", original, candidatePath],
    { cwd: benchmarkRoot, timeoutMilliseconds: 60_000 },
  );
  await writeFile(path.join(trialDir, "diff.patch"), diff.stdout);
  await writeFile(path.join(trialDir, "diff.stderr.log"), diff.stderr);
  return {
    exitCode: diff.code,
    signal: diff.signal,
    timedOut: diff.timedOut,
    wallMilliseconds: diff.wallMilliseconds,
    ok: !diff.spawnError && !diff.timedOut && (diff.code === 0 || diff.code === 1),
    error: diff.spawnError,
  };
}

async function makeAttempt(benchmarkRoot, taskId, attemptDir, graceSeconds) {
  return spawnCapture(
    "npm",
    ["run", "--silent", "make-attempt", "--", String(taskId), `--out=${attemptDir}`],
    { cwd: benchmarkRoot, timeoutMilliseconds: 60_000, graceSeconds },
  );
}

function finalOutcome(agent, checks) {
  const passed = checks.some(check => check.result?.passed === true);
  if (passed) return "auto-pass";
  const finalCheck = checks.at(-1);
  if (
    !agent ||
    agent.spawnError ||
    (!agent.timedOut && agent.code !== 0) ||
    (!agent.timedOut && !agent.resultEvent) ||
    !finalCheck ||
    checkInfrastructureFailure(finalCheck)
  ) return "infrastructure-error";
  if (agent.timedOut) return "agent-timeout";
  return "failed";
}

async function executeTrial(context, task, trial, trialDir) {
  const {
    benchmarkRoot,
    profile,
    profileName,
    effort,
    protocol,
    timeoutMinutes,
    validationTimeoutMinutes,
    validationTimeoutRetries,
    keepAttempts,
  } = context;

  const tempParent = await mkdtemp(path.join(tmpdir(), `lsdb-agent-${padTask(task.id)}-`));
  const attemptDir = path.join(tempParent, "attempt");
  const startedAt = nowIso();
  let attemptCreation;
  let agent;
  const checks = [];

  try {
    attemptCreation = await makeAttempt(benchmarkRoot, task.id, attemptDir, protocol.terminationGraceSeconds);
    await writeFile(path.join(trialDir, "make-attempt.stdout.log"), attemptCreation.stdout);
    await writeFile(path.join(trialDir, "make-attempt.stderr.log"), attemptCreation.stderr);
    if (attemptCreation.code !== 0 || attemptCreation.timedOut || attemptCreation.spawnError) {
      throw new Error(`make-attempt failed: ${attemptCreation.spawnError ?? attemptCreation.stderr.trim() ?? `exit ${attemptCreation.code}`}`);
    }

    const promptPath = path.join(attemptDir, "PROMPT.md");
    const solutionPath = path.join(attemptDir, "solution.dfy");
    const promptHash = await sha256File(promptPath);
    const initialCandidateHash = await sha256File(solutionPath);

    console.log(`  task ${task.id}, trial ${trial}: Claude Code started`);
    agent = await spawnClaude({
      profile,
      effort,
      prompt: context.agentPrompt,
      attemptDir,
      timeoutMilliseconds: timeoutMinutes * 60_000,
      graceSeconds: protocol.terminationGraceSeconds,
      stdoutPath: path.join(trialDir, "claude.stream.jsonl"),
      stderrPath: path.join(trialDir, "claude.stderr.log"),
    });

    const candidatePath = path.join(trialDir, "candidate.dfy");
    await copyFile(solutionPath, candidatePath);
    await copyFile(promptPath, path.join(trialDir, "PROMPT.md"));
    const candidateHash = await sha256File(candidatePath);

    const maxChecks = 1 + validationTimeoutRetries;
    for (let index = 1; index <= maxChecks; index++) {
      const check = await authoritativeCheck({
        benchmarkRoot,
        taskId: task.id,
        candidatePath,
        timeoutMilliseconds: validationTimeoutMinutes * 60_000,
        graceSeconds: protocol.terminationGraceSeconds,
        trialDir,
        index,
      });
      checks.push(check);
      if (!checkHitTimeout(check) || check.result?.passed) break;
      console.log(`  task ${task.id}, trial ${trial}: validation timed out; retrying unchanged candidate`);
    }

    const diff = await fullDiff(benchmarkRoot, task.file, candidatePath, trialDir);
    const outcome = finalOutcome(agent, checks);
    const result = {
      schemaVersion: 1,
      runId: context.runId,
      task: {
        id: task.id,
        key: task.key,
        file: task.file,
        taskSha256: await sha256File(path.join(benchmarkRoot, task.file)),
        promptSha256: promptHash,
        initialCandidateSha256: initialCandidateHash,
        candidateSha256: candidateHash,
      },
      trial,
      profile: profileName,
      effort,
      startedAt,
      endedAt: nowIso(),
      outcome,
      autoPassed: outcome === "auto-pass",
      manualProofOnlyReview: outcome === "auto-pass" ? "pending" : "not-applicable",
      attemptCreation: {
        exitCode: attemptCreation.code,
        wallMilliseconds: attemptCreation.wallMilliseconds,
      },
      agent,
      validation: {
        attempts: checks,
        totalWallMilliseconds: checks.reduce((total, check) => total + check.wallMilliseconds, 0),
      },
      diff,
      artifacts: {
        candidate: "candidate.dfy",
        prompt: "PROMPT.md",
        claudeStream: "claude.stream.jsonl",
        claudeStderr: "claude.stderr.log",
        diff: "diff.patch",
      },
      temporaryAttempt: keepAttempts ? attemptDir : undefined,
    };
    await writeJsonAtomic(path.join(trialDir, "result.json"), result);
    console.log(
      `  task ${task.id}, trial ${trial}: ${outcome} in ${(agent.wallMilliseconds / 1000).toFixed(1)}s` +
      (agent.timedOut ? " (time limit reached)" : ""),
    );
    return result;
  } catch (error) {
    const result = {
      schemaVersion: 1,
      runId: context.runId,
      task: { id: task.id, key: task.key, file: task.file },
      trial,
      profile: profileName,
      effort,
      startedAt,
      endedAt: nowIso(),
      outcome: "infrastructure-error",
      autoPassed: false,
      manualProofOnlyReview: "not-applicable",
      error: String(error.stack ?? error.message ?? error),
      attemptCreation: attemptCreation && {
        exitCode: attemptCreation.code,
        timedOut: attemptCreation.timedOut,
        spawnError: attemptCreation.spawnError,
        wallMilliseconds: attemptCreation.wallMilliseconds,
      },
      agent,
      validation: { attempts: checks },
      temporaryAttempt: attemptDir,
    };
    await writeJsonAtomic(path.join(trialDir, "result.json"), result);
    console.error(`  task ${task.id}, trial ${trial}: infrastructure-error: ${error.message ?? error}`);
    return result;
  } finally {
    if (!keepAttempts) await rm(tempParent, { recursive: true, force: true });
  }
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function collectResults(runRoot) {
  const taskRoot = path.join(runRoot, "tasks");
  if (!(await pathExists(taskRoot))) return [];
  const results = [];
  const { readdir } = await import("node:fs/promises");
  for (const taskName of (await readdir(taskRoot)).sort()) {
    const taskDir = path.join(taskRoot, taskName);
    if (!(await stat(taskDir)).isDirectory()) continue;
    for (const trialName of (await readdir(taskDir)).sort()) {
      const resultPath = path.join(taskDir, trialName, "result.json");
      if (await pathExists(resultPath)) results.push(jsonFile(resultPath));
    }
  }
  return results;
}

async function writeSummary(runRoot) {
  const results = await collectResults(runRoot);
  await writeJsonAtomic(path.join(runRoot, "summary.json"), { generatedAt: nowIso(), results });
  const headers = [
    "run_id", "profile", "task_id", "trial", "outcome", "auto_passed", "manual_review",
    "agent_wall_seconds", "agent_timed_out", "agent_exit_code", "reported_model",
    "validation_wall_seconds", "candidate_sha256",
  ];
  const rows = results.map(result => [
    result.runId,
    result.profile,
    result.task.id,
    result.trial,
    result.outcome,
    result.autoPassed,
    result.manualProofOnlyReview,
    result.agent?.wallMilliseconds === undefined ? undefined : (result.agent.wallMilliseconds / 1000).toFixed(3),
    result.agent?.timedOut,
    result.agent?.code,
    result.agent?.initEvent?.model,
    result.validation?.totalWallMilliseconds === undefined
      ? undefined
      : (result.validation.totalWallMilliseconds / 1000).toFixed(3),
    result.task.candidateSha256,
  ]);
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\n") + "\n";
  await writeFile(path.join(runRoot, "summary.csv"), csv);
  return results;
}

function planObject({ options, protocol, profileName, profile, tasks, preflightResult, metadata, snapshot, agentPrompt }) {
  return {
    profile: profileName,
    provider: publicProfile(profile),
    effort: options.effort,
    repeat: options.repeat,
    taskIds: tasks.map(task => task.id),
    excludedTaskIds: protocol.excludedTaskIds,
    timeoutMinutes: options.timeoutMinutes,
    validationTimeoutMinutes: options.validationTimeoutMinutes,
    validationTimeoutRetries: options.validationTimeoutRetries,
    benchmarkRoot: options.benchmarkRoot,
    benchmarkCommit: preflightResult.benchmarkCommit,
    benchmarkDirty: preflightResult.benchmarkDirty,
    benchmarkSnapshot: snapshot,
    dafnyVersion: metadata.dafnyVersion,
    toolVersions: Object.fromEntries(
      Object.entries(preflightResult.tools).map(([name, tool]) => [name, tool.value]),
    ),
    attemptCheckerCommand: preflightResult.attemptCheckerCommand,
    commonAgentEnvironment,
    agentPrompt,
    sequential: true,
  };
}

function printTaskList(metadata, excludedIds) {
  console.log("id    excluded  reference-code-lines  task");
  for (const task of metadata.tasks) {
    console.log(
      `${padTask(task.id)}  ${excludedIds.has(task.id) ? "yes     " : "no      "}  ` +
      `${String(task.addedCodeLines).padStart(20)}  ${task.key}`,
    );
  }
}

async function main() {
  const protocol = jsonFile(protocolPath);
  const profiles = jsonFile(profilesPath);
  const options = parseArgs(process.argv.slice(2), protocol);
  const metadataPath = path.join(options.benchmarkRoot, "metadata.json");
  if (!(await pathExists(metadataPath))) throw new Error(`No metadata.json at ${metadataPath}`);
  const metadata = jsonFile(metadataPath);
  const excludedIds = new Set(protocol.excludedTaskIds);

  if (options.list) {
    printTaskList(metadata, excludedIds);
    return;
  }
  if (!options.profile) throw new Error(`--profile is required; choose one of: ${Object.keys(profiles).join(", ")}`);
  const profile = profiles[options.profile];
  if (!profile) throw new Error(`Unknown profile ${options.profile}; choose one of: ${Object.keys(profiles).join(", ")}`);
  const tasks = selectTasks(options, metadata, excludedIds);
  const preflightResult = await preflight(options.benchmarkRoot, metadata);
  const agentPrompt = renderAgentPrompt(protocol.agentPrompt, preflightResult.attemptCheckerCommand);
  const snapshot = {
    metadataSha256: await sha256File(metadataPath),
    promptTemplateSha256: await sha256File(path.join(options.benchmarkRoot, "PROMPT.md")),
    protocolSha256: await sha256File(protocolPath),
    profilesSha256: await sha256File(profilesPath),
    runnerSha256: await sha256File(fileURLToPath(import.meta.url)),
    tasks: Object.fromEntries(await Promise.all(tasks.map(async task => [
      task.id,
      await sha256File(path.join(options.benchmarkRoot, task.file)),
    ]))),
  };
  const plan = planObject({
    options,
    protocol,
    profileName: options.profile,
    profile,
    tasks,
    preflightResult,
    metadata,
    snapshot,
    agentPrompt,
  });

  if (options.dryRun) {
    const missing = (profile.requiredEnvironment ?? []).filter(name => !process.env[name]);
    console.log(JSON.stringify({ ...plan, credentialsReady: missing.length === 0, missingEnvironment: missing }, null, 2));
    return;
  }

  buildProfileEnvironment(profile); // Fail before writing a run if credentials are absent.
  const runId = options.runId ?? generatedRunId(options.profile);
  const runRoot = path.join(options.resultsRoot, runId);
  const runManifestPath = path.join(runRoot, "run.json");
  const expectedConfiguration = {
    ...plan,
    runId,
    resultsRoot: options.resultsRoot,
  };

  if (await pathExists(runManifestPath)) {
    const existing = jsonFile(runManifestPath);
    const old = JSON.stringify(existing.configuration);
    const current = JSON.stringify(expectedConfiguration);
    if (old !== current) throw new Error(`Run ${runId} exists with a different configuration`);
    console.log(`Resuming run ${runId}`);
  } else {
    await mkdir(runRoot, { recursive: true });
    await writeJsonAtomic(runManifestPath, {
      schemaVersion: 1,
      status: "running",
      createdAt: nowIso(),
      configuration: expectedConfiguration,
      preflight: preflightResult,
    });
  }

  const context = {
    runId,
    benchmarkRoot: options.benchmarkRoot,
    profile,
    profileName: options.profile,
    effort: options.effort,
    protocol,
    agentPrompt,
    timeoutMinutes: options.timeoutMinutes,
    validationTimeoutMinutes: options.validationTimeoutMinutes,
    validationTimeoutRetries: options.validationTimeoutRetries,
    keepAttempts: options.keepAttempts,
  };

  console.log(`Run ${runId}: ${tasks.length} task(s) x ${options.repeat} trial(s), sequential`);
  console.log(`Results: ${runRoot}`);
  for (const task of tasks) {
    for (let trial = 1; trial <= options.repeat; trial++) {
      const trialDir = path.join(runRoot, "tasks", padTask(task.id), `trial-${padTrial(trial)}`);
      const resultPath = path.join(trialDir, "result.json");
      if (await pathExists(resultPath)) {
        console.log(`  task ${task.id}, trial ${trial}: already complete; skipped`);
        continue;
      }
      if (await pathExists(trialDir)) {
        const preserved = `${trialDir}.interrupted-${Date.now()}`;
        await rename(trialDir, preserved);
        console.log(`  preserved incomplete trial as ${path.basename(preserved)}`);
      }
      await mkdir(trialDir, { recursive: true });
      await executeTrial(context, task, trial, trialDir);
      await writeSummary(runRoot);
    }
  }

  const results = await writeSummary(runRoot);
  const counts = Object.fromEntries(
    [...new Set(results.map(result => result.outcome))].sort().map(outcome => [
      outcome,
      results.filter(result => result.outcome === outcome).length,
    ]),
  );
  const manifest = jsonFile(runManifestPath);
  await writeJsonAtomic(runManifestPath, {
    ...manifest,
    status: "completed",
    completedAt: nowIso(),
    counts,
  });
  console.log(`Completed ${runId}: ${JSON.stringify(counts)}`);
}

main().catch(error => {
  console.error(`error: ${error.message ?? error}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});
