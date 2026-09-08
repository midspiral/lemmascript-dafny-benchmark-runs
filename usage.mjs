import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const tokenFields = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isPrice = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function mergeUsage(target, source, { output = true } = {}) {
  source = object(source);
  for (const field of tokenFields) {
    if (field === "output_tokens" && !output) continue;
    if (isCount(source[field])) target[field] = source[field];
  }
  for (const field of ["cache_creation", "server_tool_use", "output_tokens_details"]) {
    if (field === "output_tokens_details" && !output) continue;
    for (const [key, value] of Object.entries(object(source[field]))) {
      if (isCount(value)) (target[field] ??= {})[key] = value;
    }
  }
  for (const field of ["speed", "service_tier", "inference_geo"]) {
    if (typeof source[field] === "string") target[field] = source[field];
  }
  return target;
}

function sumUsage(items) {
  const total = Object.fromEntries(tokenFields.map(field => [field, null]));
  for (const usage of items) {
    for (const field of tokenFields) {
      if (isCount(usage[field])) total[field] = (total[field] ?? 0) + usage[field];
    }
    for (const field of ["cache_creation", "server_tool_use", "output_tokens_details"]) {
      for (const [key, value] of Object.entries(object(usage[field]))) {
        if (isCount(value)) {
          const nested = total[field] ??= {};
          nested[key] = (nested[key] ?? 0) + value;
        }
      }
    }
  }
  return total;
}

function fromModelUsage(value) {
  return mergeUsage({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, {
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    cache_creation_input_tokens: value.cacheCreationInputTokens,
    cache_read_input_tokens: value.cacheReadInputTokens,
    output_tokens_details: { thinking_tokens: value.thinkingTokens },
    server_tool_use: { web_search_requests: value.webSearchRequests },
  });
}

function priceUsage(model, usage, pricing) {
  const catalog = object(pricing?.models);
  const rates = Object.hasOwn(catalog, model) ? catalog[model] : undefined;
  if (!rates) return { usd: null, missing: [`No pricing for ${model}`] };
  const missing = [];
  let usd = 0;
  let priced = false;
  const add = (field, count, rate) => {
    if (!isCount(count)) {
      missing.push(`${model}: missing ${field}`);
    } else if (count === 0) {
      // An absent price for an unused category does not prevent estimation.
    } else if (!isPrice(rate)) {
      missing.push(`${model}: no price for ${field}`);
    } else {
      usd += count * rate / 1_000_000;
      priced = true;
    }
  };
  add("input_tokens", usage.input_tokens, rates.input);
  add("output_tokens", usage.output_tokens, rates.output);
  add("cache_read_input_tokens", usage.cache_read_input_tokens ?? 0, rates.cacheRead);
  const writes = usage.cache_creation_input_tokens ?? 0;
  if (writes > 0 && !isPrice(rates.cacheWrite)) {
    const ttl = object(usage.cache_creation);
    const short = ttl.ephemeral_5m_input_tokens;
    const long = ttl.ephemeral_1h_input_tokens;
    if (isCount(short) && isCount(long) && short + long === writes) {
      add("5m cache writes", short, rates.cacheWrite5m);
      add("1h cache writes", long, rates.cacheWrite1h);
    } else {
      missing.push(`${model}: cache-write TTL breakdown unavailable`);
    }
  } else {
    add("cache_creation_input_tokens", writes, rates.cacheWrite);
  }
  // Keep unusual billing modes visible instead of silently using standard rates.
  if (usage.speed === "fast" || usage.service_tier === "batch" || usage.inference_geo === "us") {
    return { usd: null, missing: [`${model}: pricing modifiers require provider billing data`] };
  }
  if (Object.values(object(usage.server_tool_use)).some(value => value > 0)) {
    missing.push(`${model}: server tool fees are not included`);
  }
  const knownZero = missing.length === 0 && tokenFields.every(field => (usage[field] ?? 0) === 0);
  return { usd: priced || knownZero ? usd : null, missing };
}

// Assistant messages repeat the same message-start usage for each content block.
// Their output_tokens are placeholders. Only raw message_delta or result events
// supply output counts: https://code.claude.com/docs/en/agent-sdk/cost-tracking
export function createUsageTracker({ pricing = null } = {}) {
  const requests = new Map();
  const active = new Map();
  let initModel;
  let result;
  let malformedLines = 0;
  let orphanDeltas = 0;

  const lane = event => JSON.stringify([event.session_id ?? "", event.parent_tool_use_id ?? null]);
  const request = (event, message) => {
    if (typeof message.id !== "string" || !message.id) return;
    const key = JSON.stringify([lane(event), message.id]);
    if (!requests.has(key)) {
      requests.set(key, {
        model: message.model ?? initModel ?? "unknown",
        base: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        delta: {}, stopped: false,
      });
    }
    const item = requests.get(key);
    if (typeof message.model === "string") item.model = message.model;
    mergeUsage(item.base, message.usage, { output: false });
    return item;
  };

  function observe(event) {
    event = object(event);
    if (event.type === "system" && event.subtype === "init") initModel = event.model;
    if (event.type === "result" && !event.parent_tool_use_id) {
      result = event;
      return true;
    }
    if (event.type === "assistant") return Boolean(request(event, object(event.message)));
    if (event.type !== "stream_event") return false;
    const raw = object(event.event);
    if (raw.type === "message_start") {
      const item = request(event, object(raw.message));
      if (item) active.set(lane(event), item);
      return Boolean(item);
    }
    if (raw.type !== "message_delta" && raw.type !== "message_stop") return false;
    const item = active.get(lane(event));
    if (!item) {
      if (raw.usage) orphanDeltas++;
      return false;
    }
    if (raw.type === "message_delta") mergeUsage(item.delta, raw.usage);
    if (raw.type === "message_stop") {
      item.stopped = true;
      active.delete(lane(event));
    }
    return true;
  }

  function inspectLine(line) {
    if (!line.trim()) return false;
    try {
      return observe(JSON.parse(line));
    } catch {
      malformedLines++;
      return false;
    }
  }

  function snapshot() {
    const streamed = [...requests.values()].map(item => ({
      model: item.model,
      usage: mergeUsage(mergeUsage({}, item.base), item.delta),
    }));
    const notes = [];
    // Some Claude crash results reset all counters to zero. Preserve observations.
    const zeroedCrash = result?.subtype === "error_during_execution" &&
      !Object.values(object(result.modelUsage)).some(value =>
        ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"].some(field => object(value)[field] > 0)) &&
      !tokenFields.some(field => result.usage?.[field] > 0) &&
      !result.total_cost_usd;
    const final = zeroedCrash ? undefined : result;
    const finalModels = Object.entries(object(final?.modelUsage)).map(([model, value]) => [model, object(value)]);
    let items = streamed;
    let source = requests.size ? "stream" : "unavailable";
    let scope = "visible-responses";
    if (finalModels.length) {
      items = finalModels.map(([model, value]) => ({ model, usage: fromModelUsage(value) }));
      source = "result";
      scope = "all-models";
    } else if (final?.usage && tokenFields.some(field => isCount(final.usage[field]))) {
      items = [{ model: streamed.at(-1)?.model ?? initModel ?? "unknown", usage: mergeUsage({}, final.usage) }];
      source = "result";
      scope = "main-agent";
    }
    const coverage = source === "result" ? "final" : source === "stream" ? "partial" : "unavailable";
    if (coverage === "partial") {
      notes.push("Observed requests only; interrupted requests, internal calls, and unforwarded subagent usage may be missing.");
    }
    if (zeroedCrash) notes.push("Ignored zeroed crash totals; recovered usage from preceding stream events.");
    const missingOutputMessages = [...requests.values()].filter(item => !isCount(item.delta.output_tokens)).length;
    if (coverage !== "final" && missingOutputMessages) {
      notes.push(`${missingOutputMessages} response(s) lack real output counts; assistant-message placeholders are excluded.`);
    }
    if (malformedLines) notes.push(`${malformedLines} malformed or truncated JSON line(s) skipped.`);
    if (orphanDeltas) notes.push(`${orphanDeltas} usage delta(s) had no matching message_start.`);
    const models = Object.fromEntries([...new Set(items.map(item => item.model))].sort().map(model => [
      model, sumUsage(items.filter(item => item.model === model).map(item => item.usage)),
    ]));
    const reportedCostUsd = isPrice(final?.total_cost_usd) ? final.total_cost_usd : null;
    const unknownReportedPricing = finalModels.some(([, value]) => value.costBasis === "unknown");
    if (unknownReportedPricing) notes.push("Claude reported an unknown model price; its cost total may be incomplete.");
    const useReported = reportedCostUsd !== null && !unknownReportedPricing;
    const priced = useReported ? [] : items.map(item => priceUsage(item.model, item.usage, pricing));
    const missingPrices = [...new Set(priced.flatMap(item => item.missing))];
    const estimatedCostUsd = priced.some(item => item.usd !== null)
      ? Number(priced.reduce((sum, item) => sum + (item.usd ?? 0), 0).toFixed(9)) : null;
    const completeEstimate = coverage === "final" && scope === "all-models" && missingPrices.length === 0;
    return {
      schemaVersion: 1,
      source, coverage, scope,
      usage: sumUsage(items.map(item => item.usage)),
      models,
      observedMessages: requests.size,
      stoppedMessages: [...requests.values()].filter(item => item.stopped).length,
      missingOutputMessages,
      reportedCostUsd,
      estimatedCostUsd,
      costUsd: useReported ? reportedCostUsd : estimatedCostUsd,
      costStatus: useReported ? "reported-estimate" : estimatedCostUsd === null ? "unavailable"
        : completeEstimate ? "estimated" : "partial-estimate",
      pricing,
      unpriced: missingPrices,
      notes,
    };
  }

  return { observe, inspectLine, snapshot };
}

export async function readUsageStream(file, { pricing = null } = {}) {
  const tracker = createUsageTracker({ pricing });
  const hash = createHash("sha256");
  const input = createReadStream(file);
  input.on("data", chunk => hash.update(chunk));
  for await (const line of createInterface({ input, crlfDelay: Infinity })) tracker.inspectLine(line);
  return { streamSha256: hash.digest("hex"), accounting: tracker.snapshot() };
}

export const usageSummaryHeaders = Object.freeze([
  "usage_source", "usage_coverage", "usage_scope", "input_tokens", "output_tokens",
  "cache_creation_input_tokens", "cache_read_input_tokens", "cost_usd", "cost_status",
  "reported_cost_usd", "estimated_cost_usd",
]);

export function usageSummaryValues(accounting) {
  return [
    accounting?.source, accounting?.coverage, accounting?.scope,
    ...tokenFields.map(field => accounting?.usage?.[field]),
    accounting?.costUsd, accounting?.costStatus, accounting?.reportedCostUsd, accounting?.estimatedCostUsd,
  ];
}
