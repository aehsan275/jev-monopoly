import { applyAction, createGame, stateHash } from "./engine.ts";
import type { GameAction, GameState, PlayerSpec } from "./types.ts";

const actionTypes = new Set<GameAction["type"]>([
  "roll", "pay-jail", "use-jail-card", "buy-property", "decline-property", "auction-bid", "auction-pass",
  "build", "sell-building", "mortgage", "unmortgage", "propose-trade", "accept-trade", "reject-trade",
  "counter-trade", "declare-bankruptcy", "end-turn",
]);

export function sanitizeReplay(input: GameState) {
  const state = structuredClone(input);
  state.players = state.players.map((player, index) => ({
    ...player,
    name: player.kind === "human" ? "Human" : player.policy === "champion" ? "Champion" : `Specialist ${index}`,
  }));
  return state;
}

export function actionLog(state: GameState) {
  return state.events.flatMap((event) => {
    if (!actionTypes.has(event.type as GameAction["type"])) return [];
    return [{ actorId: event.actorId, action: event.payload as unknown as GameAction }];
  });
}

export function validateReplay(input: GameState) {
  if (!input || typeof input !== "object" || !Array.isArray(input.events) || input.events.length > 25_000) throw new Error("Replay event limit exceeded.");
  if (input.events.some((event) => JSON.stringify(event).toLowerCase().includes("api-key"))) throw new Error("Replay contains a forbidden credential field.");
  const specs: PlayerSpec[] = input.players.map(({ id, name, token, kind, policy }) => ({ id, name, token, kind, policy }));
  let replayed = createGame({ seed: input.seed, mode: input.mode, players: specs, telemetryEnabled: input.telemetryEnabled, createdAt: input.createdAt });
  for (const entry of actionLog(input)) replayed = applyAction(replayed, entry.actorId, entry.action);
  replayed.jevCalls = input.jevCalls;
  replayed.fallbackDecisions = input.fallbackDecisions;
  if (stateHash(replayed) !== stateHash(input)) throw new Error("Replay does not reproduce the submitted state.");
  return true;
}
