#!/usr/bin/env node

const key = process.env.SYNTHETIC_API_KEY;
const endpoint = "https://api.synthetic.new/anthropic/v1/messages?beta=true";
const messages = [
  { role: "user", content: "Reply OK" },
  { role: "system", content: "Continue." },
];

function safeDetail(value) {
  const text = String(value);
  return (key ? text.replaceAll(key, "[redacted]") : text).slice(0, 1000);
}

async function probe(label, requestMessages) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "mid-conversation-system-2026-04-07",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "syn:small:vision", max_tokens: 1, stream: true, messages: requestMessages }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    let events = [];
    try {
      events = body.split(/\r?\n\r?\n/).flatMap(frame => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart()).join("\n");
        return data ? [JSON.parse(data)] : [];
      });
    } catch {
      // HTTP 200 alone is insufficient: require a complete, valid SSE message.
    }
    const model = events.find(event => event?.type === "message_start")?.message?.model;
    const complete = response.status === 200 &&
      response.headers.get("content-type")?.startsWith("text/event-stream") &&
      typeof model === "string" && model.length > 0 &&
      events.at(-1)?.type === "message_stop" &&
      !events.some(event => event?.type === "error");
    const bytes = Buffer.byteLength(body);
    console.log(`${label}: HTTP ${response.status}, ${bytes} body bytes, complete stream: ${Boolean(complete)}`);
    if (model) console.log(`  model: ${safeDetail(model)}`);
    if (!complete && body) console.log(`  response: ${safeDetail(body)}`);
    return { status: response.status, bytes, complete };
  } catch (error) {
    console.error(`${label}: ${safeDetail(error.cause?.code ?? error.message ?? error)}`);
    return { complete: false };
  }
}

if (!key) {
  console.error("Set SYNTHETIC_API_KEY first.");
  process.exitCode = 2;
} else {
  console.log(`Synthetic Qwen compatibility check — ${new Date().toISOString()}`);
  const original = await probe("With mid-conversation system message", messages);
  const control = await probe("Control without system message", messages.slice(0, 1));
  if (original.complete && control.complete) {
    console.log("NATIVE SUPPORT: both requests completed. Smoke-test Claude Code without the proxy before making it optional.");
    process.exitCode = 0;
  } else if (control.complete && original.status === 500 && original.bytes === 0) {
    console.log("STILL REPRODUCIBLE: empty HTTP 500 only with the system message. Keep the proxy enabled.");
    process.exitCode = 1;
  } else {
    console.log("INCONCLUSIVE: the response differs from the known failure or the control failed. Review the output before changing the proxy.");
    process.exitCode = 2;
  }
}
