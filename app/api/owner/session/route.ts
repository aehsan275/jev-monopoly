import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createOwnerSession, OWNER_COOKIE, OWNER_SESSION_SECONDS, ownerCodeIsValid, verifyOwnerSession } from "@/lib/owner-session";

export const runtime = "edge";

const inputSchema = z.object({ code: z.string().min(16).max(160) });

export async function GET(request: NextRequest) {
  const session = await verifyOwnerSession(request.cookies.get(OWNER_COOKIE)?.value);
  return NextResponse.json(session ? { owner: true, expiresAt: session.expiresAt } : { owner: false }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  let input: z.infer<typeof inputSchema>;
  try { input = inputSchema.parse(await request.json()); }
  catch { return NextResponse.json({ error: "Owner access could not be unlocked." }, { status: 401 }); }
  if (!(await ownerCodeIsValid(input.code))) return NextResponse.json({ error: "Owner access could not be unlocked." }, { status: 401 });
  let session: Awaited<ReturnType<typeof createOwnerSession>>;
  try { session = await createOwnerSession(); }
  catch { return NextResponse.json({ error: "Owner access is not configured." }, { status: 503 }); }
  const response = NextResponse.json({ owner: true, expiresAt: session.expiresAt }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(OWNER_COOKIE, session.value, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: OWNER_SESSION_SECONDS });
  return response;
}
