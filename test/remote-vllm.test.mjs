import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildProfileEnvironment } from "../run.mjs";

const profiles = JSON.parse(readFileSync(new URL("../profiles.json", import.meta.url)));
const credentials = {
  REMOTE_VLLM_BASE_URL: "https://qwen.example.org",
  REMOTE_VLLM_API_KEY: "test-vllm-key",

};

function fixture(t) {
  for (const [name, value] of Object.entries({
    ...credentials, REMOTE_VLLM_CUSTOM_HEADERS: "CF-Access-Client-Id: test-access-id\nCF-Access-Client-Secret: test-access-secret", ANTHROPIC_AUTH_TOKEN: "stale-token",
    ANTHROPIC_CUSTOM_HEADERS: "Authorization: stale",
    SYNTHETIC_API_KEY: "test-synthetic", QWEN_API_KEY: "test-qwen",
    QWEN_WORKSPACE_ID: "test-workspace",
  })) {
    const old = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    });
  }
}

test("remote profile expands authentication, removes sources, and maps models", t => {
  fixture(t);
  const env = buildProfileEnvironment(profiles["remote-vllm"]);
  assert.equal(env.ANTHROPIC_BASE_URL, credentials.REMOTE_VLLM_BASE_URL);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, credentials.REMOTE_VLLM_API_KEY);
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.REMOTE_VLLM_CUSTOM_HEADERS, undefined);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS,
    "CF-Access-Client-Id: test-access-id\nCF-Access-Client-Secret: test-access-secret");
  for (const name of Object.keys(credentials)) assert.equal(env[name], undefined);
  for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"])
    assert.equal(env[name], "llm");
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "65536");
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  for (const value of Object.values(credentials))
    assert.ok(!JSON.stringify(profiles["remote-vllm"]).includes(value));
});

test("remote profile fails before launch when any required credential is absent", t => {
  fixture(t);
  for (const [name, value] of Object.entries(credentials)) {
    delete process.env[name];
    assert.throws(() => buildProfileEnvironment(profiles["remote-vllm"]),
      new RegExp(`Missing required environment variable.*${name}`));
    process.env[name] = value;
  }
});

test("other profiles do not inherit Cloudflare headers or remote credentials", t => {
  fixture(t);
  for (const [name, profile] of Object.entries(profiles)) {
    if (name === "remote-vllm") continue;
    const env = buildProfileEnvironment(profile);
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined, name);
    for (const key of Object.keys(credentials)) assert.equal(env[key], undefined, name);
  }
});

test("remote profile works without gateway headers", t => {
  fixture(t);
  delete process.env.REMOTE_VLLM_CUSTOM_HEADERS;
  const env = buildProfileEnvironment(profiles["remote-vllm"]);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, credentials.REMOTE_VLLM_API_KEY);
});
