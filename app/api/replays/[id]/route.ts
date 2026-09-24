import { NextRequest, NextResponse } from "next/server";
import { env } from "cloudflare:workers";

export const runtime = "edge";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[a-f0-9]{36}$/.test(id)) return NextResponse.json({ error: "Replay not found." }, { status: 404 });
  if (!env.DB) return NextResponse.json({ error: "Replay storage is temporarily unavailable." }, { status: 503 });
  const now = Date.now();
  try {
    await env.DB.prepare("DELETE FROM replays WHERE expires_at <= ?").bind(now).run();
    const row = await env.DB.prepare("SELECT state_json, expires_at FROM replays WHERE id = ? AND shareable = 1 AND expires_at > ? LIMIT 1").bind(id, now).first<{ state_json: string; expires_at: number }>();
    if (!row) return NextResponse.json({ error: "Replay not found or expired." }, { status: 404 });
    return NextResponse.json({ state: JSON.parse(row.state_json), expiresAt: row.expires_at }, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (error) {
    console.error("Replay read failed", error);
    return NextResponse.json({ error: "Replay storage is temporarily unavailable." }, { status: 503 });
  }
}
