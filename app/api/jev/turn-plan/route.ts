import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isJevTimeout, jevCooldownSeconds, jevFailureMetadata } from "@/lib/jev-http";
import { RULES_VERSION } from "@/lib/monopoly/types";
import { defaultJevKey, OWNER_COOKIE, verifyOwnerSession } from "@/lib/owner-session";

export const runtime = "edge";

const specialistIds = ["builder", "risk", "dealmaker", "balanced"] as const;
type SpecialistId = typeof specialistIds[number];

const requestSchema = z.object({
  rulesVersion: z.literal(RULES_VERSION),
  policyId: z.enum(["champion", ...specialistIds]),
  decisionType: z.enum(["purchase", "auction", "building", "mortgage", "trade", "jail", "turn", "debt"]),
  publicState: z.record(z.string(), z.unknown()),
  legalPlans: z.array(z.object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(180),
    description: z.string().max(420),
  })).min(1).max(12),
});

const instructions: Record<SpecialistId, string> = {
  builder: "Select the legal plan that best converts ownership into durable rent pressure. Preserve enough liquidity to survive plausible rent exposure.",
  risk: "Select the legal plan that best protects solvency, liquidity, and recovery options while still pursuing a win.",
  dealmaker: "Select the legal plan with the strongest monopoly leverage, denial value, and exchange value after considering every counterparty's gain.",
  balanced: "Select the legal plan with the highest overall contribution to winning, balancing cash, tempo, development, leverage, and opponent exposure.",
};

interface ChoiceAnswer {
  type?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

function normalize(answer: ChoiceAnswer, legalIds: string[]) {
  if (answer.type !== "choice" || !answer.choice || !legalIds.includes(answer.choice) || !answer.probabilities) return null;
  if (Object.keys(answer.probabilities).some((id) => !legalIds.includes(id))) return null;
  const values = Object.fromEntries(legalIds.map((id) => [id, Number(answer.probabilities?.[id] ?? 0)]));
  if (Object.values(values).some((value) => !Number.isFinite(value) || value < 0)) return null;
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  return Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value / total]));
}

function confidence(probabilities: Record<string, number>) {
  const values = Object.values(probabilities);
  if (values.length <= 1) return 1;
  const entropy = -values.reduce((sum, value) => sum + (value > 0 ? value * Math.log(value) : 0), 0);
  return Math.max(0, Math.min(1, 1 - entropy / Math.log(values.length)));
}

export async function POST(request: NextRequest) {
  const personalKey = request.headers.get("x-jev-api-key")?.trim() ?? "";
  const ownerSession = personalKey ? null : await verifyOwnerSession(request.cookies.get(OWNER_COOKIE)?.value);
  const key = personalKey || (ownerSession ? defaultJevKey() : "");
  const credentialSource = personalKey ? "personal" as const : "owner-default" as const;
  if (!key) return NextResponse.json({ error: "Live JEV access is not enabled." }, { status: 401 });
  if (key.length > 256) return NextResponse.json({ error: "Invalid credential format." }, { status: 400 });

  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid or stale decision request." }, { status: 400 });
  }
  if (new Set(input.legalPlans.map((plan) => plan.id)).size !== input.legalPlans.length) {
    return NextResponse.json({ error: "Legal plan ids must be unique." }, { status: 400 });
  }

  const criteria = Object.fromEntries(input.legalPlans.map((plan) => [plan.id, `${plan.label}. ${plan.description}`]));
  const liveSpecialist: SpecialistId = input.policyId === "champion" ? "balanced" : input.policyId;
  const questions = {
    live_plan: { type: "choice", instructions: instructions[liveSpecialist], criteria },
  };
  const payload = {
    model: "typesafe-ai/jev",
    state: input.publicState,
    questions,
  };
  const encoded = JSON.stringify(payload);
  if (new TextEncoder().encode(encoded).byteLength > 30_000) {
    return NextResponse.json({ error: "Decision state exceeds the provider request limit." }, { status: 413 });
  }

  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch("https://www.jevai.org/api/v1/decisions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: encoded,
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
  } catch (error) {
    const timedOut = isJevTimeout(error);
    console.error("JEV request failed", { kind: timedOut ? "timeout" : "network", errorName: error && typeof error === "object" && "name" in error ? String(error.name) : undefined });
    return NextResponse.json(
      { error: timedOut ? "JEV timed out; use the local fallback for this decision." : "JEV could not be reached; use the local fallback for this decision." },
      { status: timedOut ? 504 : 502 },
    );
  }
  if (!upstream.ok) {
    const metadata = await jevFailureMetadata(upstream);
    console.error("JEV upstream rejected a turn decision", metadata);
    const status = upstream.status === 401 ? 401 : upstream.status === 429 ? 429 : 502;
    const error = status === 401 ? "The JevAI key was rejected." : status === 429 ? "JEV quota or rate limit reached." : "JEV returned an upstream error.";
    if (status === 429) {
      const retryAfter = jevCooldownSeconds(upstream.headers.get("retry-after"));
      return NextResponse.json({ error, retryAfterSeconds: retryAfter }, { status, headers: { "Retry-After": String(retryAfter) } });
    }
    return NextResponse.json({ error }, { status });
  }

  let result: { code?: number; data?: { answers?: Record<string, ChoiceAnswer>; model?: string } };
  try {
    result = await upstream.json() as typeof result;
  } catch {
    return NextResponse.json({ error: "JEV returned unreadable data." }, { status: 502 });
  }
  if (result.code !== 0 || !result.data?.answers) {
    return NextResponse.json({ error: "JEV omitted its decision payload." }, { status: 502 });
  }

  const legalIds = input.legalPlans.map((plan) => plan.id);
  const probabilities = normalize(result.data.answers.live_plan ?? {}, legalIds);
  if (!probabilities) return NextResponse.json({ error: "JEV returned an invalid action distribution." }, { status: 502 });
  const planId = Object.entries(probabilities).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

  return NextResponse.json({
    planId,
    probabilities,
    confidence: confidence(probabilities),
    latencyMs: Date.now() - startedAt,
    provider: "JevAI community gateway",
    model: result.data.model ?? "typesafe-ai/jev",
    credentialSource,
  }, { headers: { "Cache-Control": "no-store" } });
}
