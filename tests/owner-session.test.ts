import assert from "node:assert/strict";
import test from "node:test";
import { constantTimeEqual, createSignedOwnerSession, hashOwnerCode, OWNER_SESSION_SECONDS, verifySignedOwnerSession } from "../lib/owner-session-crypto.ts";

test("owner code hashing is deterministic and comparison rejects near matches", async () => {
  const hash = await hashOwnerCode("owner-code-example");
  assert.equal(hash, await hashOwnerCode("owner-code-example"));
  assert.equal(hash.length, 64);
  assert.equal(constantTimeEqual(hash, hash), true);
  assert.equal(constantTimeEqual(hash, `${hash.slice(0, -1)}0`), false);
});

test("owner sessions verify, expire, and reject forged cookies", async () => {
  const now = 1_800_000_000_000;
  const session = await createSignedOwnerSession("a-long-session-secret", now, new Uint8Array(18).fill(7));
  assert.equal(session.expiresAt, now + OWNER_SESSION_SECONDS * 1000);
  assert.deepEqual(await verifySignedOwnerSession(session.value, "a-long-session-secret", now + 1), { expiresAt: session.expiresAt });
  assert.equal(await verifySignedOwnerSession(session.value, "wrong-secret", now + 1), null);
  assert.equal(await verifySignedOwnerSession(`${session.value.slice(0, -1)}x`, "a-long-session-secret", now + 1), null);
  assert.equal(await verifySignedOwnerSession(session.value, "a-long-session-secret", session.expiresAt), null);
});
