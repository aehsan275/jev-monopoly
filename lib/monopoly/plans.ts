import { TITLE_DEEDS, deedFor, groupFor } from "./data.ts";
import { canBuild, canSellBuilding, currentPlayer, getPlayer, isLegalAction, validateTrade } from "./engine.ts";
import type { GameAction, GameState, LegalPlan, TradeOffer } from "./types.ts";

function plan(id: string, label: string, description: string, family: LegalPlan["family"], ...actions: GameAction[]): LegalPlan {
  return { id, label, description, family, actions };
}

function legal(state: GameState, actorId: string, candidate: LegalPlan) {
  return candidate.actions.length > 0 && isLegalAction(state, actorId, candidate.actions[0]);
}

function tradeCandidates(state: GameState, actorId: string) {
  const actor = getPlayer(state, actorId);
  const results: LegalPlan[] = [];
  for (const target of state.players.filter((player) => player.id !== actorId && !player.bankrupt)) {
    for (const wanted of target.properties) {
      const group = groupFor(wanted);
      if (!group.length || state.deeds[wanted].buildings > 0) continue;
      const actorOwns = group.filter((index) => state.deeds[index].ownerId === actorId).length;
      if (actorOwns !== group.length - 1) continue;
      const deed = deedFor(wanted);
      const cash = Math.min(actor.cash, Math.ceil(deed.price * 1.25 / 10) * 10);
      if (cash <= 0) continue;
      const offer: TradeOffer = {
        id: `trade-${actorId}-${target.id}-${wanted}-${state.events.length}`,
        fromId: actorId,
        toId: target.id,
        offer: { cash, properties: [], getOutCards: [] },
        request: { cash: 0, properties: [wanted], getOutCards: [] },
        counterDepth: 0,
      };
      if (validateTrade(state, offer)) {
        results.push(plan(`trade:${target.id}:${wanted}:${cash}`, `Offer $${cash} for ${deed.name}`, `Completes a color group through a structured cash-for-deed offer.`, "trade", { type: "propose-trade", offer }));
      }
    }
  }
  return results.slice(0, 3);
}

export function generateLegalPlans(state: GameState, actorId: string): LegalPlan[] {
  const actor = getPlayer(state, actorId);
  const plans: LegalPlan[] = [];

  if (state.phase === "pre-roll") {
    if (!actor.inJail) return [plan("roll", "Roll the dice", "Advance and resolve the landing space.", "turn", { type: "roll" })];
    if (state.mode === "classic") plans.push(plan("jail:roll", "Try for doubles", "Remain in jail if the roll fails before the third attempt.", "jail", { type: "roll" }));
    plans.push(plan("jail:pay", "Pay $50", state.mode === "short" ? "Short Game rules require release on the next turn." : "Leave jail before rolling.", "jail", { type: "pay-jail" }));
    for (const deck of actor.getOutCards) plans.push(plan(`jail:card:${deck}`, "Use amnesty card", `Return the ${deck} card and leave jail.`, "jail", { type: "use-jail-card", deck }));
    return plans.filter((candidate) => legal(state, actorId, candidate));
  }

  if (state.phase === "purchase" && state.pendingPurchase?.playerId === actorId) {
    const deed = deedFor(state.pendingPurchase.spaceIndex);
    plans.push(plan("purchase:buy", `Buy ${deed.name} for $${deed.price}`, "Acquire the unowned deed at face value.", "purchase", { type: "buy-property" }));
    plans.push(plan("purchase:auction", "Send to auction", "Decline the deed and open mandatory bidding to every solvent player.", "purchase", { type: "decline-property" }));
    return plans.filter((candidate) => legal(state, actorId, candidate));
  }

  if (state.phase === "auction" && state.auction?.currentBidderId === actorId) {
    plans.push(plan("auction:pass", "Pass", "Leave this auction permanently.", "auction", { type: "auction-pass" }));
    const deed = deedFor(state.auction.spaceIndex);
    const minimum = state.auction.highBid + 1;
    const candidates = new Set([
      minimum,
      Math.min(actor.cash, Math.max(minimum, Math.floor(deed.price * 0.6))),
      Math.min(actor.cash, Math.max(minimum, deed.price)),
      Math.min(actor.cash, Math.max(minimum, Math.floor(deed.price * 1.25))),
    ]);
    for (const amount of candidates) {
      if (amount >= minimum && amount <= actor.cash) plans.push(plan(`auction:bid:${amount}`, `Bid $${amount}`, `Raise the current $${state.auction.highBid} bid.`, "auction", { type: "auction-bid", amount }));
    }
    return plans.filter((candidate) => legal(state, actorId, candidate));
  }

  if (state.phase === "debt" && state.pendingDebt?.debtorId === actorId) {
    for (const index of actor.properties) {
      if (canSellBuilding(state, actorId, index)) plans.push(plan(`debt:sell:${index}`, `Sell one building on ${deedFor(index).name}`, "Return a building to the bank at half price.", "debt", { type: "sell-building", spaceIndex: index }));
    }
    for (const index of actor.properties) {
      const deedState = state.deeds[index];
      if (!deedState.mortgaged && groupFor(index).every((groupIndex) => state.deeds[groupIndex].buildings === 0)) plans.push(plan(`debt:mortgage:${index}`, `Mortgage ${deedFor(index).name}`, `Raise $${deedFor(index).mortgage}.`, "debt", { type: "mortgage", spaceIndex: index }));
    }
    plans.push(plan("debt:bankrupt", "Declare bankruptcy", "Retire only when every legal liquidation still cannot satisfy the debt.", "debt", { type: "declare-bankruptcy" }));
    return plans.filter((candidate) => legal(state, actorId, candidate));
  }

  if (state.phase === "trade-response" && state.pendingTrade?.toId === actorId) {
    plans.push(plan("trade:accept", "Accept trade", "Execute the offered cash, deed, and card transfers.", "trade", { type: "accept-trade" }));
    plans.push(plan("trade:reject", "Reject trade", "End this negotiation without exchanging assets.", "trade", { type: "reject-trade" }));
    return plans.filter((candidate) => legal(state, actorId, candidate));
  }

  if (state.phase === "manage" && currentPlayer(state).id === actorId) {
    for (const index of actor.properties) {
      if (canBuild(state, actorId, index)) plans.push(plan(`build:${index}`, `Build on ${deedFor(index).name}`, `Pay $${deedFor(index).houseCost} and increase rent pressure evenly.`, "building", { type: "build", spaceIndex: index }));
      const deed = TITLE_DEEDS[index];
      const payoff = Math.ceil(deed.mortgage * 1.1);
      if (state.deeds[index].mortgaged && actor.cash >= payoff) plans.push(plan(`unmortgage:${index}`, `Unmortgage ${deed.name}`, `Pay $${payoff} to restore rent and building eligibility.`, "mortgage", { type: "unmortgage", spaceIndex: index }));
    }
    const turnEvents = [...state.events].reverse().slice(0, state.events.length - Math.max(-1, state.events.map((event) => event.actorId === actorId && event.type === "roll").lastIndexOf(true)));
    const alreadyNegotiated = turnEvents.some((event) => event.actorId === actorId && event.type === "propose-trade");
    if (!alreadyNegotiated) plans.push(...tradeCandidates(state, actorId));
    plans.push(plan("turn:end", state.extraRoll ? "Take the extra roll" : "End turn", state.extraRoll ? "Continue after rolling doubles." : "Pass play clockwise.", "turn", { type: "end-turn" }));
    return plans.filter((candidate) => legal(state, actorId, candidate)).slice(0, 12);
  }

  return [];
}

export function actionLabel(action: GameAction) {
  switch (action.type) {
    case "build": return `Build on ${deedFor(action.spaceIndex).name}`;
    case "sell-building": return `Sell a building on ${deedFor(action.spaceIndex).name}`;
    case "mortgage": return `Mortgage ${deedFor(action.spaceIndex).name}`;
    case "unmortgage": return `Unmortgage ${deedFor(action.spaceIndex).name}`;
    case "auction-bid": return `Bid $${action.amount}`;
    default: return action.type.replaceAll("-", " ");
  }
}
