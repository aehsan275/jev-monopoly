import { NextRequest, NextResponse } from "next/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { assertStateIntegrity } from "@/lib/monopoly/engine";
import { sanitizeReplay, validateReplay } from "@/lib/monopoly/replay-validation";
import type { GameState } from "@/lib/monopoly/types";

export const runtime = "edge";

const requestSchema = z.object({ state: z.unknown(), share: z.boolean().default(false) });
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

function replayId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 1_500_000) return NextResponse.json({ error: "Replay payload is too large." }, { status: 413 });
  let input: z.infer<typeof requestSchema>;
  try { input = requestSchema.parse(await request.json()); }
  catch { return NextResponse.json({ error: "Invalid replay payload." }, { status: 400 }); }
  if (!env.DB) return NextResponse.json({ error: "Replay storage is temporarily unavailable." }, { status: 503 });
  const state = input.state as GameState;
  try { assertStateIntegrity(state); validateReplay(state); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Replay validation failed." }, { status: 422 }); }
  if (input.share && state.phase !== "game-over") return NextResponse.json({ error: "Only completed matches can be shared." }, { status: 409 });

  const sanitized = sanitizeReplay(state);
  const id = replayId(); const now = Date.now(); const expiresAt = now + THIRTY_DAYS;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM replays WHERE expires_at <= ?").bind(now),
      env.DB.prepare(`INSERT INTO replays
        (id, created_at, expires_at, shareable, schema_version, rules_version, policy_version, mode, seed, action_count, jev_calls, fallback_decisions, winner_policy, state_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, now, expiresAt, input.share ? 1 : 0, sanitized.schemaVersion, sanitized.rulesVersion, sanitized.policyVersion, sanitized.mode, sanitized.seed, sanitized.events.length, sanitized.jevCalls, sanitized.fallbackDecisions, sanitized.players.find((player) => player.id === sanitized.winnerId)?.policy ?? null, JSON.stringify(sanitized)),
    ]);
  } catch (error) {
    console.error("Replay insert failed", error);
    return NextResponse.json({ error: "Replay storage is temporarily unavailable." }, { status: 503 });
  }
  return NextResponse.json({ id: input.share ? id : undefined, expiresAt, stored: true }, { status: 201 });
}
