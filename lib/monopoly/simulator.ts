import { applyAction, createGame, currentPlayer, getPlayer, netWorth } from "./engine.ts";
import { generateLegalPlans } from "./plans.ts";
import { chooseLocalPlan, DEFAULT_POLICY_ARTIFACT, type PolicyArtifact } from "./policy-model.ts";
import { nextRandom, normalizeSeed } from "./rng.ts";
import type { GameMode, GameState, PlayerSpec, PolicyId } from "./types.ts";

export interface SimulationOptions {
  seed: number;
  mode?: GameMode;
  policies?: Array<Exclude<PolicyId, "human">>;
  artifact?: PolicyArtifact;
  maxActions?: number;
  sampleActions?: boolean;
}

export interface SimulationResult {
  state: GameState;
  completed: boolean;
  actions: number;
  standings: Array<{ playerId: string; netWorth: number; bankrupt: boolean }>;
  failure?: string;
}

export function simulationPlayers(policies: Array<Exclude<PolicyId, "human">>): PlayerSpec[] {
  const tokens = ["π", "▲", "◆", "●"];
  return policies.map((policy, index) => ({
    id: `p${index + 1}`,
    name: policy === "champion" ? "Champion" : `${policy[0].toUpperCase()}${policy.slice(1)}`,
    token: tokens[index],
    kind: "ai",
    policy,
  }));
}

function sample(probabilities: Record<string, number>, randomValue: number) {
  let cursor = 0;
  for (const [id, probability] of Object.entries(probabilities)) {
    cursor += probability;
    if (randomValue <= cursor) return id;
  }
  return Object.keys(probabilities).at(-1)!;
}

export function simulateGame(options: SimulationOptions): SimulationResult {
  const policies = options.policies ?? ["champion", "builder", "risk", "dealmaker"];
  if (policies.length !== 4) throw new Error("Simulation requires four policies.");
  const artifact = options.artifact ?? DEFAULT_POLICY_ARTIFACT;
  let state = createGame({ seed: options.seed, mode: options.mode ?? "classic", players: simulationPlayers(policies), telemetryEnabled: false, createdAt: 0 });
  let policyRng = normalizeSeed(options.seed ^ 0xa5a5a5a5);
  const maxActions = options.maxActions ?? 20_000;

  try {
    for (let actionCount = 0; actionCount < maxActions && state.phase !== "game-over"; actionCount += 1) {
      const actorId = state.phase === "auction"
        ? state.auction!.currentBidderId
        : state.phase === "trade-response"
          ? state.pendingTrade!.toId
          : state.phase === "debt"
            ? state.pendingDebt!.debtorId
            : currentPlayer(state).id;
      const actor = getPlayer(state, actorId);
      const plans = generateLegalPlans(state, actorId);
      if (!plans.length) throw new Error(`No legal plans for ${actorId} during ${state.phase}.`);
      const decision = chooseLocalPlan(state, actorId, plans, actor.policy, artifact);
      let planId = decision.planId;
      if (options.sampleActions) {
        const next = nextRandom(policyRng);
        policyRng = next.state;
        planId = sample(decision.probabilities, next.value);
      }
      const selected = plans.find((plan) => plan.id === planId) ?? plans[0];
      for (const action of selected.actions) state = applyAction(state, actorId, action);
    }
  } catch (error) {
    return {
      state,
      completed: false,
      actions: state.events.length,
      standings: standings(state),
      failure: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    state,
    completed: state.phase === "game-over",
    actions: state.events.length,
    standings: standings(state),
    failure: state.phase === "game-over" ? undefined : `Reached ${maxActions} action cap.`,
  };
}

export function standings(state: GameState) {
  return [...state.players]
    .map((player) => ({ playerId: player.id, netWorth: netWorth(state, player.id), bankrupt: player.bankrupt }))
    .sort((a, b) => Number(a.bankrupt) - Number(b.bankrupt) || b.netWorth - a.netWorth);
}
