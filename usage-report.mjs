#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readUsageStream } from "./usage.mjs";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.length) {
    console.log("Usage: npm run usage -- TRIAL_DIRECTORY [--out NEW_FILE] [--pricing-file FILE]\n" +
      "Reconstruct usage from saved events. Prints JSON; --out creates a new report without changing trial records.");
    return;
  }
  const trialDir = path.resolve(args.shift());
  let out;
  let pricingFile;
  while (args.length) {
    const flag = args.shift();
    if (!["--out", "--pricing-file"].includes(flag) || !args[0] || args[0].startsWith("--")) {
      throw new Error(`Unknown option or missing value: ${flag}`);
    }
    if (flag === "--out") out = path.resolve(args.shift());
    else pricingFile = path.resolve(args.shift());
  }
  const run = JSON.parse(await readFile(path.resolve(trialDir, "../../..", "run.json"), "utf8"));
  const pinned = Object.hasOwn(run.configuration, "usagePricing");
  let pricing = run.configuration.usagePricing ?? null;
  const pricingSource = pricingFile ? "explicit-file" : pinned ? "run-snapshot" : "current-catalog";
  if (pricingFile || !pinned) {
    const catalogPath = pricingFile ?? fileURLToPath(new URL("./pricing.json", import.meta.url));
    pricing = JSON.parse(await readFile(catalogPath, "utf8")).profiles?.[run.configuration.profile] ?? null;
  }
  let resultSha256 = null;
  try {
    resultSha256 = createHash("sha256").update(await readFile(path.join(trialDir, "result.json"))).digest("hex");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const recovered = await readUsageStream(path.join(trialDir, "claude.stream.jsonl"), { pricing });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: path.basename(path.resolve(trialDir, "../../..")),
    trialPath: path.relative(path.resolve(trialDir, "../../.."), trialDir),
    pricingSource,
    resultSha256,
    ...recovered,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) await writeFile(out, json, { flag: "wx" });
  console.log(out ? `Usage report: ${out}` : json.trimEnd());
}

main().catch(error => {
  console.error(`error: ${error.message ?? error}`);
  process.exitCode = 1;
});
