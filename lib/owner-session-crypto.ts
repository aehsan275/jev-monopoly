export const OWNER_SESSION_SECONDS = 12 * 60 * 60;

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export async function hashOwnerCode(code: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(code))));
}

export function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

export async function createSignedOwnerSession(secret: string, now = Date.now(), nonceBytes?: Uint8Array) {
  const expiresAt = now + OWNER_SESSION_SECONDS * 1000;
  const nonce = bytesToBase64Url(nonceBytes ?? crypto.getRandomValues(new Uint8Array(18)));
  const payload = `${expiresAt}.${nonce}`;
  return { value: `${payload}.${await hmac(payload, secret)}`, expiresAt };
}

export async function verifySignedOwnerSession(value: string | undefined, secret: string, now = Date.now()) {
  if (!value || !secret) return null;
  const [expiresText, nonce, signature, ...extra] = value.split(".");
  const expiresAt = Number(expiresText);
  if (extra.length || !Number.isFinite(expiresAt) || expiresAt <= now || !nonce || !signature) return null;
  const expected = await hmac(`${expiresText}.${nonce}`, secret);
  return constantTimeEqual(signature, expected) ? { expiresAt } : null;
}
