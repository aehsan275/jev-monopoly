import { GROUPS, deedFor } from "./data.ts";
import { applyAction, getPlayer, netWorth, ownsGroup } from "./engine.ts";
import type { DecisionRecord, GameState, LegalPlan, PolicyId } from "./types.ts";

export type FeatureName =
  | "bias"
  | "cash"
  | "netWorth"
  | "propertyCount"
  | "monopolies"
  | "buildings"
  | "mortgaged"
  | "rentPower"
  | "liquidityRisk"
  | "opponentDenial"
  | "tradeLeverage"
  | "endTurn"
  | "jailSafety";

export interface PolicyArtifact {
  version: string;
  expertWeights: Record<Exclude<PolicyId, "human" | "champion">, Record<FeatureName, number>>;
  routerWeights: Record<LegalPlan["family"], Record<Exclude<PolicyId, "human" | "champion">, number>>;
  liveJevWeight: Record<LegalPlan["family"], number>;
}

const specialistIds: Array<Exclude<PolicyId, "human" | "champion">> = ["builder", "risk", "dealmaker", "balanced"];

export const DEFAULT_POLICY_ARTIFACT: PolicyArtifact = {
  version: "experimental-0.2.0",
  expertWeights: {
    builder: { bias: 0, cash: .25, netWorth: .6, propertyCount: .8, monopolies: 3.4, buildings: 3.2, mortgaged: -1.2, rentPower: 2.8, liquidityRisk: -1, opponentDenial: 1.2, tradeLeverage: .4, endTurn: -.2, jailSafety: .1 },
    risk: { bias: 0, cash: 2.8, netWorth: 1, propertyCount: .35, monopolies: 1.5, buildings: .7, mortgaged: -2.3, rentPower: 1, liquidityRisk: -3.2, opponentDenial: .5, tradeLeverage: .3, endTurn: .5, jailSafety: 1.4 },
    dealmaker: { bias: 0, cash: .7, netWorth: .8, propertyCount: .9, monopolies: 2.9, buildings: 1.2, mortgaged: -1.1, rentPower: 1.5, liquidityRisk: -1.3, opponentDenial: 2.2, tradeLeverage: 3, endTurn: -.3, jailSafety: .3 },
    balanced: { bias: 0, cash: 1.4, netWorth: 1.2, propertyCount: .8, monopolies: 2.4, buildings: 1.8, mortgaged: -1.5, rentPower: 1.9, liquidityRisk: -2, opponentDenial: 1.3, tradeLeverage: 1.1, endTurn: .15, jailSafety: .8 },
  },
  routerWeights: {
    purchase: { builder: .25, risk: .15, dealmaker: .5, balanced: .1 },
    auction: { builder: .25, risk: .2, dealmaker: .5, balanced: .05 },
    building: { builder: .55, risk: .15, dealmaker: .25, balanced: .05 },
    mortgage: { builder: .1, risk: .55, dealmaker: .25, balanced: .1 },
    trade: { builder: .15, risk: .1, dealmaker: .7, balanced: .05 },
    jail: { builder: .1, risk: .5, dealmaker: .2, balanced: .2 },
    turn: { builder: .25, risk: .2, dealmaker: .45, balanced: .1 },
    debt: { builder: .1, risk: .55, dealmaker: .25, balanced: .1 },
  },
  liveJevWeight: { purchase: .72, auction: .7, building: .68, mortgage: .65, trade: .74, jail: .7, turn: .62, debt: .66 },
};

function countMonopolies(state: GameState, playerId: string) {
  return Object.values(GROUPS).filter((indexes) => indexes.every((index) => state.deeds[index].ownerId === playerId)).length;
}

function rentPower(state: GameState, playerId: string) {
  const player = getPlayer(state, playerId);
  return player.properties.reduce((sum, index) => {
    const deed = deedFor(index);
    if (state.deeds[index].mortgaged) return sum;
    if (deed.kind !== "property") return sum + (deed.kind === "transit" ? 25 : 20);
    const rent = deed.rent![state.deeds[index].buildings];
    return sum + (state.deeds[index].buildings === 0 && ownsGroup(state, playerId, index) ? rent * 2 : rent);
  }, 0);
}

function planResult(state: GameState, playerId: string, plan: LegalPlan) {
  try {
    const auctionBid = plan.actions.find((action) => action.type === "auction-bid");
    if (auctionBid?.type === "auction-bid" && state.auction) {
      const next = structuredClone(state);
      const player = getPlayer(next, playerId);
      player.cash -= auctionBid.amount;
      next.deeds[next.auction!.spaceIndex].ownerId = playerId;
      player.properties.push(next.auction!.spaceIndex);
      player.properties.sort((a, b) => a - b);
      next.auction = null;
      next.phase = "manage";
      return next;
    }
    let next = plan.actions.reduce((result, action) => applyAction(result, playerId, action), state);
    const proposal = plan.actions.find((action) => action.type === "propose-trade");
    if (proposal?.type === "propose-trade" && next.phase === "trade-response") {
      next = applyAction(next, proposal.offer.toId, { type: "accept-trade" });
    }
    return next;
  } catch {
    return state;
  }
}

export function extractFeatures(state: GameState, playerId: string, plan: LegalPlan): Record<FeatureName, number> {
  const before = getPlayer(state, playerId);
  const next = planResult(state, playerId, plan);
  const after = getPlayer(next, playerId);
  const maxOpponentWorth = Math.max(...state.players.filter((player) => player.id !== playerId && !player.bankrupt).map((player) => netWorth(state, player.id)), 1);
  const monopolyDelta = countMonopolies(next, playerId) - countMonopolies(state, playerId);
  const buildingBefore = before.properties.reduce((sum, index) => sum + state.deeds[index].buildings, 0);
  const buildingAfter = after.properties.reduce((sum, index) => sum + next.deeds[index].buildings, 0);
  const mortgagedAfter = after.properties.filter((index) => next.deeds[index].mortgaged).length;
  const cashRatio = after.cash / 1500;
  const purchaseIndex = plan.actions.find((action) => action.type === "buy-property" || action.type === "auction-bid");
  let denial = 0;
  const purchaseSpace = state.pendingPurchase?.spaceIndex ?? state.auction?.spaceIndex;
  if (purchaseIndex && purchaseSpace !== undefined) {
    const groupName = deedFor(purchaseSpace).group;
    const group = groupName ? GROUPS[groupName] : [];
    denial = group.length > 0 && state.players.some((player) => player.id !== playerId && group.filter((index) => state.deeds[index].ownerId === player.id).length === group.length - 1) ? 1 : 0;
  }
  return {
    bias: 1,
    cash: cashRatio,
    netWorth: netWorth(next, playerId) / Math.max(1500, maxOpponentWorth),
    propertyCount: (after.properties.length - before.properties.length) / 4,
    monopolies: monopolyDelta,
    buildings: (buildingAfter - buildingBefore) / 4,
    mortgaged: mortgagedAfter / 5,
    rentPower: (rentPower(next, playerId) - rentPower(state, playerId)) / 500,
    liquidityRisk: cashRatio < .12 ? 1 : cashRatio < .25 ? .45 : 0,
    opponentDenial: denial,
    tradeLeverage: plan.family === "trade" ? monopolyDelta + .5 : 0,
    endTurn: plan.id === "turn:end" ? 1 : 0,
    jailSafety: before.inJail && state.round > 15 ? 1 : 0,
  };
}

function dot(features: Record<FeatureName, number>, weights: Record<FeatureName, number>) {
  return (Object.keys(features) as FeatureName[]).reduce((sum, name) => sum + features[name] * weights[name], 0);
}

function softmax(scores: Record<string, number>) {
  const max = Math.max(...Object.values(scores));
  const exps = Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, Math.exp(Math.max(-40, Math.min(40, score - max)))]));
  const total = Object.values(exps).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(exps).map(([id, value]) => [id, value / total]));
}

export function policyProbabilities(state: GameState, playerId: string, plans: LegalPlan[], policy: Exclude<PolicyId, "human" | "champion">, artifact = DEFAULT_POLICY_ARTIFACT) {
  const scores = Object.fromEntries(plans.map((plan) => [plan.id, dot(extractFeatures(state, playerId, plan), artifact.expertWeights[policy])]));
  return softmax(scores);
}

function confidence(probabilities: Record<string, number>) {
  const values = Object.values(probabilities);
  if (values.length <= 1) return 1;
  const entropy = -values.reduce((sum, value) => sum + (value > 0 ? value * Math.log(value) : 0), 0);
  return 1 - entropy / Math.log(values.length);
}

export function championProbabilities(state: GameState, playerId: string, plans: LegalPlan[], artifact = DEFAULT_POLICY_ARTIFACT) {
  const family = plans[0]?.family ?? "turn";
  const distributions = Object.fromEntries(specialistIds.map((id) => [id, policyProbabilities(state, playerId, plans, id, artifact)])) as Record<typeof specialistIds[number], Record<string, number>>;
  const raw: Record<string, number> = {};
  for (const plan of plans) {
    raw[plan.id] = Math.exp(specialistIds.reduce((sum, id) => sum + artifact.routerWeights[family][id] * Math.log(Math.max(distributions[id][plan.id], 1e-5)), 0));
  }
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  return { probabilities: Object.fromEntries(Object.entries(raw).map(([id, value]) => [id, value / total])), specialists: distributions };
}

export function chooseLocalPlan(state: GameState, playerId: string, plans: LegalPlan[], policy: PolicyId, artifact = DEFAULT_POLICY_ARTIFACT): DecisionRecord {
  if (!plans.length) throw new Error("Cannot choose from an empty legal plan set.");
  const result = policy === "champion"
    ? championProbabilities(state, playerId, plans, artifact)
    : { probabilities: policyProbabilities(state, playerId, plans, policy === "human" ? "balanced" : policy, artifact), specialists: undefined };
  const planId = Object.entries(result.probabilities).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return { planId, probabilities: result.probabilities, confidence: confidence(result.probabilities), source: "local-policy", specialistProbabilities: result.specialists };
}

export function blendWithLiveJev(local: DecisionRecord, liveProbabilities: Record<string, number>, family: LegalPlan["family"], artifact = DEFAULT_POLICY_ARTIFACT) {
  const alpha = artifact.liveJevWeight[family];
  const raw = Object.fromEntries(Object.keys(local.probabilities).map((id) => [id, Math.exp(alpha * Math.log(Math.max(liveProbabilities[id] ?? 1e-5, 1e-5)) + (1 - alpha) * Math.log(Math.max(local.probabilities[id], 1e-5)))]));
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  const probabilities = Object.fromEntries(Object.entries(raw).map(([id, value]) => [id, value / total]));
  const planId = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { planId, probabilities, confidence: confidence(probabilities), source: "live-jev" as const };
}
