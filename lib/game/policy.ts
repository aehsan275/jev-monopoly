import type { AgentDecision, AgentId, ArenaScenario, LegalAction } from "./types.ts";

export const AGENTS: Record<AgentId, { name: string; role: string; color: string; description: string }> = {
  builder: {
    name: "Builder",
    role: "Board pressure",
    color: "#f4c430",
    description: "Turns complete sets into rent pressure quickly.",
  },
  risk: {
    name: "Risk Manager",
    role: "Liquidity",
    color: "#6cd4c5",
    description: "Protects cash, survival, and recovery options.",
  },
  dealmaker: {
    name: "Dealmaker",
    role: "Trade leverage",
    color: "#eb7f54",
    description: "Searches for asymmetric exchanges and set completion.",
  },
  balanced: {
    name: "Opportunist",
    role: "All-around",
    color: "#a99bea",
    description: "Balances position, tempo, cash, and denial value.",
  },
};

const FAMILY_WEIGHTS: Record<ArenaScenario["family"], Record<AgentId, number>> = {
  purchase: { builder: 0.3, risk: 0.25, dealmaker: 0.15, balanced: 0.3 },
  auction: { builder: 0.22, risk: 0.28, dealmaker: 0.2, balanced: 0.3 },
  building: { builder: 0.42, risk: 0.18, dealmaker: 0.12, balanced: 0.28 },
  mortgage: { builder: 0.12, risk: 0.48, dealmaker: 0.12, balanced: 0.28 },
  trade: { builder: 0.18, risk: 0.14, dealmaker: 0.45, balanced: 0.23 },
  jail: { builder: 0.2, risk: 0.34, dealmaker: 0.1, balanced: 0.36 },
};

function normalizedEntropy(probabilities: number[]) {
  if (probabilities.length <= 1) return 0;
  const entropy = -probabilities.reduce(
    (sum, value) => sum + (value > 0 ? value * Math.log(value) : 0),
    0,
  );
  return entropy / Math.log(probabilities.length);
}

export function confidenceFromProbabilities(probabilities: Record<string, number>) {
  return 1 - normalizedEntropy(Object.values(probabilities));
}

export function combineDecisions(
  scenario: Pick<ArenaScenario, "family" | "legalActions" | "decisions">,
): AgentDecision {
  const weights = FAMILY_WEIGHTS[scenario.family];
  const probabilities: Record<string, number> = {};

  for (const action of scenario.legalActions) {
    let weightedLogProbability = 0;
    for (const agentId of Object.keys(weights) as AgentId[]) {
      const probability = scenario.decisions[agentId].probabilities[action.id] ?? 0.0001;
      weightedLogProbability += weights[agentId] * Math.log(Math.max(probability, 0.0001));
    }
    probabilities[action.id] = Math.exp(weightedLogProbability);
  }

  const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  for (const actionId of Object.keys(probabilities)) probabilities[actionId] /= total;

  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  const leadingAgents = (Object.keys(weights) as AgentId[])
    .sort((a, b) => weights[b] - weights[a])
    .slice(0, 2)
    .map((id) => AGENTS[id].name);

  return {
    agentId: "champion",
    choice,
    confidence: confidenceFromProbabilities(probabilities),
    probabilities,
    factors: [`${leadingAgents.join(" + ")} carry the most weight here`, "Consensus is adjusted by decision type"],
    source: "combined-policy",
  };
}

export function validateDecision(decision: AgentDecision, legalActions: LegalAction[]) {
  const ids = new Set(legalActions.map((action) => action.id));
  if (!ids.has(decision.choice)) return false;
  const entries = Object.entries(decision.probabilities);
  if (!entries.length || entries.some(([id, value]) => !ids.has(id) || value < 0 || value > 1)) return false;
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return Math.abs(total - 1) < 0.02;
}
