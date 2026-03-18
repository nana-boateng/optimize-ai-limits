import test from "node:test";
import assert from "node:assert/strict";

import {
  parseClaudeStreamJson,
  parseCodexRateLimitsJsonl,
} from "../src/parsers.mjs";

test("parseCodexRateLimitsJsonl reads the newest token_count rate limit line", () => {
  const jsonl = [
    '{"timestamp":"2026-03-16T01:00:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":10,"window_minutes":300,"resets_at":1773622800},"secondary":{"used_percent":20,"window_minutes":10080,"resets_at":1774204800},"credits":{"has_credits":false,"unlimited":false,"balance":null},"plan_type":null}}}',
    '{"timestamp":"2026-03-16T02:00:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":12,"window_minutes":300,"resets_at":1773626400},"secondary":{"used_percent":22,"window_minutes":10080,"resets_at":1774208400},"credits":{"has_credits":false,"unlimited":false,"balance":null},"plan_type":null}}}',
  ].join("\n");

  const parsed = parseCodexRateLimitsJsonl(jsonl, "/tmp/fake.jsonl");
  assert.ok(parsed);
  assert.equal(parsed.primary.label, "5h");
  assert.equal(parsed.primary.resetsAtMs, 1773626400 * 1000);
  assert.equal(parsed.secondary.label, "weekly");
  assert.equal(parsed.secondary.resetsAtMs, 1774208400 * 1000);
  assert.equal(parsed.rawPath, "/tmp/fake.jsonl");
});

test("parseClaudeStreamJson extracts rate_limit_event from stream-json output", () => {
  const stdout = [
    '{"type":"system","subtype":"init","session_id":"abc123"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1773730800,"rateLimitType":"five_hour","overageStatus":"allowed","overageResetsAt":1775001600,"isUsingOverage":false}}',
    '{"type":"result","subtype":"success","is_error":false}',
  ].join("\n");

  const parsed = parseClaudeStreamJson(stdout);
  assert.ok(parsed);
  assert.equal(parsed.provider, "claude");
  assert.equal(parsed.source, "stream-json");
  assert.ok(parsed.primary);
  assert.equal(parsed.primary.label, "5h");
  assert.equal(parsed.primary.windowMinutes, 300);
  assert.equal(parsed.primary.resetsAtMs, 1773730800 * 1000);
  assert.ok(parsed.secondary);
  assert.equal(parsed.secondary.label, "weekly");
  assert.equal(parsed.secondary.windowMinutes, 10080);
  assert.equal(parsed.secondary.resetsAtMs, 1775001600 * 1000);
});

test("parseClaudeStreamJson returns null when no rate_limit_event present", () => {
  const stdout = [
    '{"type":"system","subtype":"init"}',
    '{"type":"result","subtype":"success"}',
  ].join("\n");

  const parsed = parseClaudeStreamJson(stdout);
  assert.equal(parsed, null);
});

test("parseClaudeStreamJson handles primary-only rate limit", () => {
  const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1773730800,"rateLimitType":"five_hour"}}';

  const parsed = parseClaudeStreamJson(stdout);
  assert.ok(parsed);
  assert.ok(parsed.primary);
  assert.equal(parsed.primary.resetsAtMs, 1773730800 * 1000);
  assert.equal(parsed.secondary, null);
});

test("parseClaudeStreamJson skips malformed JSON lines", () => {
  const stdout = [
    "not json at all",
    '{"type":"rate_limit_event","rate_limit_info":{"resetsAt":1773730800,"overageResetsAt":1775001600}}',
    "another bad line",
  ].join("\n");

  const parsed = parseClaudeStreamJson(stdout);
  assert.ok(parsed);
  assert.equal(parsed.primary.resetsAtMs, 1773730800 * 1000);
  assert.equal(parsed.secondary.resetsAtMs, 1775001600 * 1000);
});

test("parseClaudeStreamJson returns null for empty input", () => {
  assert.equal(parseClaudeStreamJson(""), null);
  assert.equal(parseClaudeStreamJson(null), null);
  assert.equal(parseClaudeStreamJson(undefined), null);
});
