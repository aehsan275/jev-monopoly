import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getScenario } from "@/lib/game/scenarios";
import { combineDecisions, validateDecision } from "@/lib/game/policy";
import type { AgentDecision, AgentId, JevGatewayResponse } from "@/lib/game/types";

export const runtime = "edge";

const requestSchema = z.object({ scenarioId: z.string().min(1).max(80) });
const agentIds: AgentId[] = ["builder", "risk", "dealmaker", "balanced"];

const instructions: Record<AgentId, string> = {
  builder:
    "Choose the legal action that most effectively converts property control into durable rent pressure. Respect solvency and the stated rules.",
  risk:
    "Choose the legal action that maximizes survival, liquidity, and recovery options while still pursuing a win. Avoid ruinous short-term exposure.",
  dealmaker:
    "Choose the legal action with the best leverage, denial value, and future exchange value. Account for what every opponent gains.",
  balanced:
    "Choose the legal action with the strongest overall chance of winning, balancing cash, tempo, board position, development, and opponent denial.",
};

function compactState(scenario: ReturnType<typeof getScenario>) {
  return {
    game: "Four-player official-style property trading game with Waterloo-themed names",
    scenario: scenario.title,
    decision_family: scenario.family,
    prompt: scenario.prompt,
    round: scenario.state.round,
    phase: scenario.state.phase,
    bank: {
      houses_remaining: scenario.state.housesRemaining,
      hotels_remaining: scenario.state.hotelsRemaining,
    },
    players: scenario.state.players.map((player) => ({
      id: player.id,
      cash: player.cash,
      position: player.position,
      in_jail: Boolean(player.inJail),
      properties: player.properties,
    })),
    properties: scenario.state.propertyState,
    recent_public_events: scenario.state.recentEvents,
    rules: [
      "Only listed legal actions may be selected",
      "No future dice rolls or deck order are known",
      "The objective is to be the last solvent player",
    ],
  };
}

export async function POST(request: NextRequest) {
  const key = request.headers.get("x-jev-api-key")?.trim();
  if (!key) return NextResponse.json({ error: "A JevAI API key is required." }, { status: 401 });
  if (key.length > 256) return NextResponse.json({ error: "Invalid credential format." }, { status: 400 });

  let parsedBody: z.infer<typeof requestSchema>;
  try {
    parsedBody = requestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const scenario = getScenario(parsedBody.scenarioId);
  if (scenario.id !== parsedBody.scenarioId) {
    return NextResponse.json({ error: "Unknown scenario." }, { status: 404 });
  }

  const criteria = Object.fromEntries(
    scenario.legalActions.map((action) => [
      action.id,
      `${action.label}. ${action.description}`,
    ]),
  );
  const questions = Object.fromEntries(
    agentIds.map((agentId) => [
      `${agentId}_action`,
      { type: "choice", instructions: instructions[agentId], criteria },
    ]),
  );

  const payload = {
    model: "typesafe-ai/jev",
    state: compactState(scenario),
    questions: {
      ...questions,
      liquidity_risk: {
        type: "score",
        instructions: "Rate how severely the most aggressive listed action threatens near-term solvency.",
        criteria: ["Low", "Manageable", "Material", "Severe"],
      },
      creates_leverage: {
        type: "noul",
        instructions: "Does the strategically best listed action create meaningful leverage over at least one opponent?",
      },
    },
  };

  const encoded = JSON.stringify(payload);
  if (new TextEncoder().encode(encoded).byteLength > 30_000) {
    return NextResponse.json({ error: "Scenario exceeds the provider request limit." }, { status: 413 });
  }

  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch("https://www.jevai.org/api/v1/decisions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: encoded,
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "JEV did not respond in time. Your key was not stored." }, { status: 504 });
  }

  if (!upstream.ok) {
    const status = upstream.status === 401 ? 401 : upstream.status === 429 ? 429 : 502;
    const message = status === 401
      ? "The JevAI key was rejected."
      : status === 429
        ? "JEV is rate-limited. Try again shortly."
        : "JEV returned an invalid upstream response.";
    return NextResponse.json({ error: message }, { status });
  }

  let response: JevGatewayResponse;
  try {
    response = (await upstream.json()) as JevGatewayResponse;
  } catch {
    return NextResponse.json({ error: "JEV returned unreadable data." }, { status: 502 });
  }
  if (response.code !== 0 || !response.data?.answers) {
    return NextResponse.json({ error: "JEV did not return a decision." }, { status: 502 });
  }

  const latencyMs = Date.now() - startedAt;
  const decisions = {} as Record<AgentId, AgentDecision>;
  for (const agentId of agentIds) {
    const answer = response.data.answers[`${agentId}_action`];
    if (!answer || answer.type !== "choice") {
      return NextResponse.json({ error: `JEV omitted the ${agentId} decision.` }, { status: 502 });
    }
    const decision: AgentDecision = {
      agentId,
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      factors: scenario.decisions[agentId].factors,
      source: "live-jev",
      latencyMs,
    };
    if (!validateDecision(decision, scenario.legalActions)) {
      return NextResponse.json({ error: `JEV returned an invalid ${agentId} action distribution.` }, { status: 502 });
    }
    decisions[agentId] = decision;
  }

  const champion = combineDecisions({ ...scenario, decisions });
  return NextResponse.json(
    {
      scenarioId: scenario.id,
      decisions,
      champion,
      factors: {
        liquidityRisk: response.data.answers.liquidity_risk,
        createsLeverage: response.data.answers.creates_leverage,
      },
      latencyMs,
      provider: "JevAI community gateway",
      model: "typesafe-ai/jev",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
