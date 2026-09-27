#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { backfillLocs } from "./ledger.mjs";

try {
  const { values } = parseArgs({ options: {
    "project-root": { type: "string" }, "results-root": { type: "string" },
    "pre-context-root": { type: "string" }, help: { type: "boolean" },
  }, strict: true });
  if (values.help) console.log(`Usage: npm run locs -- [--results-root DIR] [--pre-context-root DIR]
Backfills records/locs.csv for trials already present in the current and historical
trial ledgers. Private result archives can be read from the supplied directories.
The runner also records LOC automatically after every finalized trial.

Counts final added Dafny source lines using git diff --no-index --minimal, excluding blank
lines and comments. Helper declarations and braces count. Missing or incomplete
sources yield unavailable, never zero. Source hashes bind counts to each trial.
Repeated updates preserve existing measurements and append only missing entries
or measurements that fill an earlier unavailable entry. No model calls are made.`);
  else {
    const result = await backfillLocs({
      projectRoot: path.resolve(values["project-root"] ?? fileURLToPath(new URL("./", import.meta.url))),
      ...(values["results-root"] ? { resultsRoot: path.resolve(values["results-root"]) } : {}),
      ...(values["pre-context-root"] ? { preContextRoot: path.resolve(values["pre-context-root"]) } : {}),
    });
    console.log(`LOC ledger: ${result.scanned} recorded trials, ${result.appended} rows appended, ${result.measured} measured, ${result.scanned - result.measured} unavailable.`);
  }
} catch (error) {
  console.error(error.message ?? String(error));
  process.exitCode = 1;
}
