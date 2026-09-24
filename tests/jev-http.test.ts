import assert from "node:assert/strict";
import test from "node:test";
import { isJevTimeout, jevCooldownSeconds } from "../lib/jev-http.ts";

test("JEV cooldown uses a bounded fallback and honors useful Retry-After values", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  assert.equal(jevCooldownSeconds(null, now), 30);
  assert.equal(jevCooldownSeconds("5", now), 30);
  assert.equal(jevCooldownSeconds("45", now), 45);
  assert.equal(jevCooldownSeconds("120", now), 60);
  assert.equal(jevCooldownSeconds("Wed, 23 Sep 2026 12:00:50 GMT", now), 50);
});

test("only abort-style fetch failures are reported as timeouts", () => {
  assert.equal(isJevTimeout({ name: "TimeoutError" }), true);
  assert.equal(isJevTimeout({ name: "AbortError" }), true);
  assert.equal(isJevTimeout(new TypeError("fetch failed")), false);
  assert.equal(isJevTimeout(null), false);
});
