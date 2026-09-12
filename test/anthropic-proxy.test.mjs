import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startAnthropicProxy } from "../anthropic-proxy.mjs";

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const proxy = await startAnthropicProxy({
    upstreamBaseUrl: `http://127.0.0.1:${server.address().port}/anthropic`,
    upstreamAuthToken: "upstream-test-credential",
    rejectMidConversationSystemForModels: ["syn:small:vision", "hf:Qwen/Qwen3.8-27B"],
  });
  t.after(async () => {
    await proxy.close();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return proxy;
}

function post(proxy, body, { path = "/v1/messages?beta=true", headers = {} } = {}) {
  return fetch(proxy.baseUrl + path, {
    method: "POST",
    headers: { authorization: `Bearer ${proxy.authToken}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
}

const messages = [{ role: "user", content: "Reply OK" }, { role: "system", content: "Continue." }];

test("Qwen system turns return Claude Code's capability error without an upstream call", async t => {
  let upstreamCalls = 0;
  const proxy = await fixture(t, (_req, res) => { upstreamCalls++; res.end(); });
  for (const model of ["syn:small:vision", "hf:Qwen/Qwen3.8-27B"]) {
    const response = await post(proxy, { model, stream: true, messages });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      type: "error", error: { type: "invalid_request_error", message: "capability_rejected: mid_conv_system" },
    });
  }
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(proxy.stats, { rejectedRequests: 2, forwardedRequests: 0 });
});

test("accepted bodies, beta headers, endpoint queries, and upstream errors survive forwarding", async t => {
  const requests = [];
  const errorBody = '{"error":"original upstream error"}';
  const proxy = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
    res.end(errorBody);
  });
  const bodies = [
    JSON.stringify({ model: "syn:small:vision", system: "Continue.", messages: messages.slice(0, 1) }, null, 2),
    JSON.stringify({ model: "syn:large:vision", messages }),
  ];
  for (const body of bodies) {
    const response = await post(proxy, body, { headers: {
      "anthropic-beta": "mid-conversation-system-2026-04-07",
      "anthropic-version": "2023-06-01", "x-api-key": proxy.authToken,
    } });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "7");
    assert.equal(await response.text(), errorBody);
    const forwarded = requests.at(-1);
    assert.equal(forwarded.body, body);
    assert.equal(forwarded.path, "/anthropic/v1/messages?beta=true");
    assert.equal(forwarded.headers["anthropic-beta"], "mid-conversation-system-2026-04-07");
    assert.equal(forwarded.headers["anthropic-version"], "2023-06-01");
    assert.equal(forwarded.headers.authorization, "Bearer upstream-test-credential");
    assert.equal(forwarded.headers["x-api-key"], undefined);
    assert.ok(!JSON.stringify(forwarded).includes(proxy.authToken));
  }
  assert.deepEqual(proxy.stats, { rejectedRequests: 0, forwardedRequests: 2 });
});

test("local credentials and endpoint restrictions prevent unauthorized upstream requests", async t => {
  let upstreamCalls = 0;
  const proxy = await fixture(t, (_req, res) => { upstreamCalls++; res.end(); });
  for (const authorization of ["", "Bearer upstream-test-credential", "Bearer wrong"]) {
    const response = await post(proxy, {}, { headers: { authorization } });
    assert.equal(response.status, 401);
    await response.text();
  }
  const unsupported = await post(proxy, {}, { path: "/anything-else" });
  assert.equal(unsupported.status, 404);
  await unsupported.text();
  const invalid = await post(proxy, "{broken");
  assert.equal(invalid.status, 400);
  await invalid.text();
  assert.equal(upstreamCalls, 0);
});

test("SSE bytes reach the client before upstream completion, and close cancels active streams", async t => {
  let endUpstream;
  const first = "event: ping\ndata: {}\n\n";
  const proxy = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(first);
    endUpstream = () => res.end();
  });
  try {
    const response = await post(proxy, { model: "syn:small:vision", messages: messages.slice(0, 1), stream: true });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body.getReader();
    const chunk = await reader.read();
    assert.equal(new TextDecoder().decode(chunk.value), first);
    assert.equal(chunk.done, false);
    await proxy.close();
    await assert.rejects(reader.read());
    await assert.rejects(post(proxy, {}));
  } finally {
    endUpstream?.();
  }
});
