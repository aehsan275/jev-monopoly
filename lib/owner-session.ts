import { env } from "cloudflare:workers";
import { constantTimeEqual, createSignedOwnerSession, hashOwnerCode, verifySignedOwnerSession } from "./owner-session-crypto";

export { constantTimeEqual, hashOwnerCode, OWNER_SESSION_SECONDS } from "./owner-session-crypto";

export const OWNER_COOKIE = "uwm_owner_session";

type RuntimeSecrets = {
  OWNER_ACCESS_CODE_HASH?: string;
  OWNER_SESSION_SECRET?: string;
  JEV_DEFAULT_API_KEY?: string;
};

function runtimeSecrets(): RuntimeSecrets {
  return env as unknown as RuntimeSecrets;
}

export async function ownerCodeIsValid(code: string) {
  const expected = runtimeSecrets().OWNER_ACCESS_CODE_HASH?.trim().toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return constantTimeEqual(await hashOwnerCode(code), expected);
}

export async function createOwnerSession(now = Date.now()) {
  const secret = runtimeSecrets().OWNER_SESSION_SECRET?.trim();
  if (!secret) throw new Error("Owner access is not configured.");
  return createSignedOwnerSession(secret, now);
}

export async function verifyOwnerSession(value: string | undefined, now = Date.now()) {
  const secret = runtimeSecrets().OWNER_SESSION_SECRET?.trim();
  if (!secret) return null;
  return verifySignedOwnerSession(value, secret, now);
}

export function defaultJevKey() {
  return runtimeSecrets().JEV_DEFAULT_API_KEY?.trim() ?? "";
}
