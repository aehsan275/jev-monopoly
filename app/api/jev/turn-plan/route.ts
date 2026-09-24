import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_POLICY_ARTIFACT } from "@/lib/monopoly/policy-model";
import { RULES_VERSION } from "@/lib/monopoly/types";

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

function combine(distributions: Record<SpecialistId, Record<string, number>>, family: keyof typeof DEFAULT_POLICY_ARTIFACT.routerWeights) {
  const weights = DEFAULT_POLICY_ARTIFACT.routerWeights[family];
  const ids = Object.keys(distributions.builder);
  const raw = Object.fromEntries(ids.map((id) => [id, Math.exp(specialistIds.reduce(
    (sum, specialist) => sum + weights[specialist] * Math.log(Math.max(distributions[specialist][id], 1e-5)),
    0,
  ))]));
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(raw).map(([id, value]) => [id, value / total]));
}

export async function POST(request: NextRequest) {
  const key = request.headers.get("x-jev-api-key")?.trim();
  if (!key) return NextResponse.json({ error: "A JevAI API key is required." }, { status: 401 });
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
  const requestedSpecialists: SpecialistId[] = input.policyId === "champion" ? [...specialistIds] : [input.policyId];
  const questions = Object.fromEntries(requestedSpecialists.map((specialist) => [
    `${specialist}_plan`,
    { type: "choice", instructions: instructions[specialist], criteria },
  ]));
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
  } catch {
    return NextResponse.json({ error: "JEV timed out; use the local fallback for this decision." }, { status: 504 });
  }
  if (!upstream.ok) {
    const status = upstream.status === 401 ? 401 : upstream.status === 429 ? 429 : 502;
    const error = status === 401 ? "The JevAI key was rejected." : status === 429 ? "JEV quota or rate limit reached." : "JEV returned an upstream error.";
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
  const distributions = {} as Record<SpecialistId, Record<string, number>>;
  for (const specialist of requestedSpecialists) {
    const probabilities = normalize(result.data.answers[`${specialist}_plan`] ?? {}, legalIds);
    if (!probabilities) return NextResponse.json({ error: `JEV returned an invalid ${specialist} distribution.` }, { status: 502 });
    distributions[specialist] = probabilities;
  }
  const probabilities = input.policyId === "champion"
    ? combine(distributions, input.decisionType)
    : distributions[input.policyId];
  const planId = Object.entries(probabilities).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

  return NextResponse.json({
    planId,
    probabilities,
    confidence: confidence(probabilities),
    specialistProbabilities: input.policyId === "champion" ? distributions : undefined,
    latencyMs: Date.now() - startedAt,
    provider: "JevAI community gateway",
    model: result.data.model ?? "typesafe-ai/jev",
  }, { headers: { "Cache-Control": "no-store" } });
}
