import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const runnerUrl = new URL("../run.mjs", import.meta.url).href;

async function waitFor(check, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(10);
  }
  return false;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

for (const [signal, mode] of [["SIGINT", "graceful"], ["SIGTERM", "stubborn"], ["SIGINT", "orphan"]]) {
  test(`${signal} stops a ${mode} agent and its grandchild`, {
    skip: process.platform === "win32", timeout: 10000,
  }, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), "lsdb-shutdown-"));
    const fake = path.join(dir, "fake-claude.mjs");
    const harness = path.join(dir, "runner.mjs");
    let running;
    let pids;
    t.after(async () => {
      killGroup(pids?.child);
      killGroup(running?.pid);
      await rm(dir, { recursive: true, force: true });
    });
    await writeFile(fake, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = process.argv.includes("--grandchild");
const mode = ${JSON.stringify(mode)};
if (grandchild) {
  process.on("SIGTERM", () => {
    writeFileSync("grandchild-term", "received");
    if (mode === "graceful") process.exit(0);
  });
  process.send({ pid: process.pid });
} else {
  const child = spawn(process.execPath, [${JSON.stringify(fake)}, "--grandchild"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.on("message", message => {
    writeFileSync("pids.json", JSON.stringify({ child: process.pid, grandchild: message.pid }));
  });
  process.on("SIGTERM", () => {
    writeFileSync("child-term", "received");
    if (mode === "orphan") process.exit(0);
    if (mode === "graceful") {
      if (child.exitCode !== null) process.exit(0);
      child.once("close", () => process.exit(0));
    }
  });
}
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    await writeFile(harness, `
import * as runner from ${JSON.stringify(runnerUrl)};
import { writeFileSync } from "node:fs";
runner.installShutdownHandlers?.(0.2);
await runner.spawnClaude({
  profile: { command: ${JSON.stringify(fake)}, model: "fixture", environment: {} },
  effort: "high", prompt: "fixture", attemptDir: ${JSON.stringify(dir)},
  timeoutMilliseconds: 60000, graceSeconds: 0.2,
  stdoutPath: ${JSON.stringify(path.join(dir, "claude.stream.jsonl"))},
  stderrPath: ${JSON.stringify(path.join(dir, "claude.stderr.log"))},
});
writeFileSync("continued", "unexpected next stage");
`);
    running = spawn(process.execPath, [harness], {
      cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise(resolve => running.once("close", (code, signal) => resolve({ code, signal })));
    let stderr = "";
    running.stdout.resume();
    running.stderr.on("data", chunk => { stderr += chunk; });
    assert.ok(await waitFor(async () => {
      try {
        pids = JSON.parse(await readFile(path.join(dir, "pids.json"), "utf8"));
        return true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return false;
      }
    }), `dummy agent did not start: ${stderr}`);

    running.kill(signal);
    assert.ok(await waitFor(() => running.exitCode !== null || running.signalCode !== null), "runner did not stop");
    assert.ok(await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), 1000),
      "agent or grandchild survived runner shutdown");
    assert.deepEqual(await closed, { code: signal === "SIGINT" ? 130 : 143, signal: null });
    assert.equal(await readFile(path.join(dir, "child-term"), "utf8"), "received");
    if (mode !== "orphan") {
      assert.equal(await readFile(path.join(dir, "grandchild-term"), "utf8"), "received");
    }
    await assert.rejects(readFile(path.join(dir, "continued")), { code: "ENOENT" });
  });
}
