import { NextResponse } from "next/server";
import { OWNER_COOKIE } from "@/lib/owner-session";

export const runtime = "edge";

export async function POST() {
  const response = NextResponse.json({ owner: false }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(OWNER_COOKIE, "", { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 0 });
  return response;
}
