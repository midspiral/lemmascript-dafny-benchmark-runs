import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";

const maxRequestBytes = 32 * 1024 * 1024;
const messagePaths = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

function endToEndHeaders(headers) {
  const excluded = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
    ...String(headers.connection ?? "").toLowerCase().split(",").map(value => value.trim()),
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}

function sendError(response, status, message) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({
    type: "error",
    error: { type: status === 401 ? "authentication_error" : status >= 500 ? "api_error" : "invalid_request_error", message },
  }));
}

// Return the capability error Claude Code recognizes, so it regenerates its own
// messages. Accepted requests and SSE response bodies pass through unchanged.
// https://code.claude.com/docs/en/llm-gateway-protocol#automatic-retry-and-error-forwarding
export async function startAnthropicProxy({ upstreamBaseUrl, upstreamAuthToken, rejectMidConversationSystemForModels }) {
  const upstreamBase = new URL(upstreamBaseUrl);
  if (!["http:", "https:"].includes(upstreamBase.protocol) || upstreamBase.username || upstreamBase.password || upstreamBase.search || upstreamBase.hash) {
    throw new Error("Compatibility proxy requires an HTTP(S) base URL without credentials, query, or fragment");
  }
  if (!upstreamAuthToken) throw new Error("Compatibility proxy requires ANTHROPIC_AUTH_TOKEN");
  const models = new Set(rejectMidConversationSystemForModels);
  const authToken = randomBytes(32).toString("hex");
  const expectedAuthorization = Buffer.from(`Bearer ${authToken}`);
  const pending = new Set();
  const stats = { rejectedRequests: 0, forwardedRequests: 0 };

  const server = http.createServer(async (request, response) => {
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
      request.resume();
      sendError(response, 401, "Invalid local proxy credential");
      return;
    }
    try {
      const incoming = new URL(request.url, "http://127.0.0.1");
      if (request.method !== "POST" || !messagePaths.has(incoming.pathname)) {
        request.resume();
        sendError(response, 404, "Unsupported proxy endpoint");
        return;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > maxRequestBytes) {
          sendError(response, 413, "Request body exceeds 32 MiB");
          return;
        }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        sendError(response, 400, "Invalid JSON request body");
        return;
      }
      if (models.has(body?.model) && Array.isArray(body.messages) && body.messages.some(message => message?.role === "system")) {
        stats.rejectedRequests++;
        sendError(response, 400, "capability_rejected: mid_conv_system");
        return;
      }
      const target = new URL(upstreamBase);
      target.pathname = upstreamBase.pathname.replace(/\/$/, "") + incoming.pathname;
      target.search = incoming.search;
      const headers = endToEndHeaders(request.headers);
      delete headers.host;
      delete headers["x-api-key"];
      headers.authorization = `Bearer ${upstreamAuthToken}`;
      headers["content-length"] = String(raw.length);
      const transport = target.protocol === "https:" ? https : http;
      const upstream = transport.request(target, { method: "POST", headers }, reply => {
        if (response.destroyed) {
          reply.destroy();
          return;
        }
        response.writeHead(reply.statusCode, endToEndHeaders(reply.headers));
        reply.on("error", () => response.destroy());
        reply.pipe(response);
      });
      pending.add(upstream);
      upstream.once("close", () => pending.delete(upstream));
      upstream.once("error", () => sendError(response, 502, "Upstream request failed"));
      response.once("close", () => upstream.destroy());
      stats.forwardedRequests++;
      upstream.end(raw);
    } catch {
      sendError(response, 400, "Invalid or interrupted proxy request");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    authToken,
    stats,
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      for (const request of pending) request.destroy();
      await closed;
    },
  };
}
