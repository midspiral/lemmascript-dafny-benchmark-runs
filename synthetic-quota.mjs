#!/usr/bin/env node

const key = process.env.SYNTHETIC_API_KEY;

try {
  if (!key) throw new Error("Set SYNTHETIC_API_KEY first.");

  const response = await fetch("https://api.synthetic.new/v2/quotas", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);

  const { weeklyTokenLimit: weekly, rollingFiveHourLimit: requests } = JSON.parse(body);
  if (!weekly || !requests) throw new Error("Response is missing weekly or five-hour quota information.");

  const nextReplenishment = new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(weekly.nextRegenAt));
  const rows = [
    ["Weekly credits", `${weekly.remainingCredits} / ${weekly.maxCredits} (${weekly.percentRemaining.toFixed(2)}%)`],
    ["Five-hour requests", `${requests.remaining} / ${requests.max}`],
    ["Next weekly-credit replenishment", `+${weekly.nextRegenCredits} at ${nextReplenishment}`],
  ];
  const headers = ["Allowance", "Remaining"];
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => row[i].length)));
  const printRow = row => console.log(`| ${row.map((value, i) => value.padEnd(widths[i])).join(" | ")} |`);
  printRow(headers);
  console.log(`| ${widths.map(width => "-".repeat(width)).join(" | ")} |`);
  for (const row of rows) printRow(row);
} catch (error) {
  const message = error.name === "TimeoutError" ? "Request timed out after 30 seconds." : String(error.message ?? error);
  console.error(`Synthetic quota: ${(key ? message.replaceAll(key, "[redacted]") : message).slice(0, 2000)}`);
  process.exitCode = 1;
}
