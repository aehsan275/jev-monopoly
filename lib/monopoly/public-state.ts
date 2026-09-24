import { BOARD } from "../game/board.ts";
import { TITLE_DEEDS } from "./data.ts";
import { netWorth } from "./engine.ts";
import type { GameState, LegalPlan } from "./types.ts";

export function buildPublicDecisionState(state: GameState, actorId: string, plans: LegalPlan[]) {
  return {
    game: "Four-player official-style property trading game with Waterloo-themed names",
    rules_version: state.rulesVersion,
    mode: state.mode,
    round: state.round,
    phase: state.phase,
    acting_player_id: actorId,
    dice: state.lastRoll,
    bank: state.bank,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      policy: player.policy,
      cash: player.cash,
      position: player.position,
      position_name: BOARD[player.position].name,
      in_jail: player.inJail,
      jail_turns: player.jailTurns,
      bankrupt: player.bankrupt,
      get_out_card_count: player.getOutCards.length,
      properties: player.properties,
      net_worth: netWorth(state, player.id),
    })),
    deeds: Object.fromEntries(Object.entries(state.deeds).map(([index, deed]) => [index, {
      name: TITLE_DEEDS[Number(index)].name,
      owner_id: deed.ownerId,
      buildings: deed.buildings,
      mortgaged: deed.mortgaged,
    }])),
    auction: state.auction ? {
      space_index: state.auction.spaceIndex,
      active_bidder_ids: state.auction.activeBidderIds,
      current_bidder_id: state.auction.currentBidderId,
      high_bidder_id: state.auction.highBidderId,
      high_bid: state.auction.highBid,
      reason: state.auction.reason,
      building_kind: state.auction.buildingKind,
    } : null,
    pending_building_placement: state.pendingBuildingPlacement,
    debt: state.pendingDebt,
    trade: state.pendingTrade,
    legal_plans: plans.map((plan) => ({
      id: plan.id,
      label: plan.label,
      description: plan.description,
      family: plan.family,
    })),
    recent_public_events: state.events.slice(-12).map((event) => ({
      sequence: event.sequence,
      actor_id: event.actorId,
      type: event.type,
      payload: event.payload,
    })),
    rules: [
      "Choose only one listed legal plan.",
      "No future dice, shuffled deck order, seed, or private credential is available.",
      "The objective is to win the game, not merely maximize current cash.",
    ],
  };
}
