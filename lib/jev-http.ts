export const DEFAULT_JEV_COOLDOWN_SECONDS = 30;
export const MAX_JEV_COOLDOWN_SECONDS = 60;

export function isJevTimeout(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  const name = String(error.name);
  return name === "AbortError" || name === "TimeoutError";
}

export function jevCooldownSeconds(retryAfter: string | null | undefined, now = Date.now()) {
  let seconds = Number(retryAfter);
  if (!retryAfter || !Number.isFinite(seconds)) {
    const retryAt = retryAfter ? Date.parse(retryAfter) : Number.NaN;
    seconds = Number.isFinite(retryAt) ? Math.ceil((retryAt - now) / 1000) : DEFAULT_JEV_COOLDOWN_SECONDS;
  }
  return Math.max(DEFAULT_JEV_COOLDOWN_SECONDS, Math.min(MAX_JEV_COOLDOWN_SECONDS, Math.ceil(seconds)));
}

export async function jevFailureMetadata(response: Response) {
  let providerCode: number | string | undefined;
  let providerMessage: string | undefined;
  try {
    const body = await response.clone().json() as { code?: unknown; message?: unknown };
    if (typeof body.code === "number" || typeof body.code === "string") providerCode = body.code;
    if (typeof body.message === "string") providerMessage = body.message.slice(0, 240);
  } catch {
    // Upstream HTML and empty bodies are intentionally not copied into logs.
  }
  return {
    status: response.status,
    providerCode,
    providerMessage,
    requestId: response.headers.get("x-request-id") ?? response.headers.get("cf-ray") ?? undefined,
    retryAfter: response.headers.get("retry-after") ?? undefined,
  };
}
