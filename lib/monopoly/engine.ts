import { BOARD } from "../game/board.ts";
import {
  CARD_LABELS,
  CHANCE_CARD_IDS,
  COMMUNITY_CARD_IDS,
  DEED_INDEXES,
  GROUPS,
  TRANSIT_INDEXES,
  UTILITY_INDEXES,
  deedFor,
  groupFor,
} from "./data.ts";
import { nextRandom, normalizeSeed, shuffle } from "./rng.ts";
import {
  GAME_SCHEMA_VERSION,
  POLICY_VERSION,
  RULES_VERSION,
  type AuctionState,
  type GameAction,
  type GameMode,
  type GamePlayer,
  type GameState,
  type PendingPayment,
  type PlayerSpec,
  type TradeAssets,
  type TradeOffer,
} from "./types.ts";

export interface CreateGameOptions {
  seed: number;
  mode: GameMode;
  players: PlayerSpec[];
  telemetryEnabled?: boolean;
  createdAt?: number;
}

const fail = (message: string): never => { throw new Error(message); };
const activePlayers = (state: GameState) => state.players.filter((player) => !player.bankrupt);
export const currentPlayer = (state: GameState) => state.players[state.currentPlayerIndex];
export const getPlayer = (state: GameState, id: string) => state.players.find((player) => player.id === id) ?? fail(`Unknown player ${id}.`);

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function stateHash(state: GameState) {
  return fnv1a(JSON.stringify({
    mode: state.mode,
    rngState: state.rngState,
    rngCursor: state.rngCursor,
    round: state.round,
    phase: state.phase,
    players: state.players,
    currentPlayerIndex: state.currentPlayerIndex,
    deeds: state.deeds,
    bank: state.bank,
    chance: state.chance,
    community: state.community,
    doublesInTurn: state.doublesInTurn,
    extraRoll: state.extraRoll,
    lastRoll: state.lastRoll,
    pendingPurchase: state.pendingPurchase,
    auction: state.auction,
    pendingBuildingPlacement: state.pendingBuildingPlacement,
    pendingDebt: state.pendingDebt,
    paymentQueue: state.paymentQueue,
    pendingLandingAfterDebt: state.pendingLandingAfterDebt,
    pendingTrade: state.pendingTrade,
    bankruptcyAuctionQueue: state.bankruptcyAuctionQueue,
    bankruptcyResume: state.bankruptcyResume,
    postDebtAction: state.postDebtAction,
    winnerId: state.winnerId,
  }));
}

function addEvent(state: GameState, actorId: string | "bank" | "system", type: string, payload: Record<string, unknown>) {
  const sequence = state.events.length;
  state.updatedAt = state.createdAt + sequence + 1;
  state.events.push({
    sequence,
    actorId,
    type,
    payload,
    rngCursor: state.rngCursor,
    stateHash: stateHash(state),
    at: state.updatedAt,
  });
}

function random(state: GameState) {
  const next = nextRandom(state.rngState);
  state.rngState = next.state;
  state.rngCursor += 1;
  return next.value;
}

function rollDice(state: GameState): [number, number] {
  return [Math.floor(random(state) * 6) + 1, Math.floor(random(state) * 6) + 1];
}

export function ownsGroup(state: GameState, playerId: string, spaceIndex: number) {
  const group = groupFor(spaceIndex);
  return group.length > 0 && group.every((index) => state.deeds[index].ownerId === playerId);
}

export function netWorth(state: GameState, playerId: string) {
  const player = getPlayer(state, playerId);
  let value = player.cash;
  for (const index of player.properties) {
    const deed = deedFor(index);
    const deedState = state.deeds[index];
    value += deedState.mortgaged ? deed.mortgage : deed.price;
    if (deed.kind === "property" && deed.houseCost) {
      const buildingCount = deedState.buildings === 5 ? (state.mode === "short" ? 4 : 5) : deedState.buildings;
      value += buildingCount * deed.houseCost;
    }
  }
  return value;
}

function liquidationValue(state: GameState, playerId: string) {
  const player = getPlayer(state, playerId);
  return player.properties.reduce((total, index) => {
    const deed = deedFor(index);
    const deedState = state.deeds[index];
    const buildings = deedState.buildings === 5 ? (state.mode === "short" ? 4 : 5) : deedState.buildings;
    return total + (deedState.mortgaged ? 0 : deed.mortgage) + buildings * Math.floor((deed.houseCost ?? 0) / 2);
  }, player.cash);
}

function findNextPlayerIndex(state: GameState, fromIndex: number) {
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const index = (fromIndex + offset) % state.players.length;
    if (!state.players[index].bankrupt) return index;
  }
  return fromIndex;
}

function sendToJail(state: GameState, player: GamePlayer) {
  player.position = 10;
  player.inJail = true;
  player.jailTurns = 0;
  state.extraRoll = false;
  state.doublesInTurn = 0;
  state.phase = "manage";
}

function moveTo(state: GameState, player: GamePlayer, destination: number, collectStart = true) {
  if (collectStart && destination < player.position) player.cash += 200;
  player.position = destination;
}

function rentFor(state: GameState, spaceIndex: number, diceTotal: number, multiplier = 1) {
  const deed = deedFor(spaceIndex);
  const deedState = state.deeds[spaceIndex];
  const ownerId = deedState.ownerId!;
  if (deedState.mortgaged) return 0;
  if (deed.kind === "transit") {
    const count = TRANSIT_INDEXES.filter((index) => state.deeds[index].ownerId === ownerId).length;
    return 25 * 2 ** Math.max(0, count - 1) * multiplier;
  }
  if (deed.kind === "utility") {
    const count = UTILITY_INDEXES.filter((index) => state.deeds[index].ownerId === ownerId).length;
    return diceTotal * (multiplier > 1 ? multiplier : count === 2 ? 10 : 4);
  }
  const base = deed.rent![deedState.buildings];
  return deedState.buildings === 0 && ownsGroup(state, ownerId, spaceIndex) ? base * 2 : base;
}

function credit(state: GameState, creditorId: string | "bank", amount: number) {
  if (creditorId !== "bank") getPlayer(state, creditorId).cash += amount;
}

function processPayments(state: GameState, resumePhase: "manage" | "pre-roll" | "game-over" = "manage") {
  while (!state.pendingDebt && state.paymentQueue.length) {
    const payment = state.paymentQueue.shift()!;
    const debtor = getPlayer(state, payment.debtorId);
    if (debtor.bankrupt) continue;
    if (debtor.cash >= payment.amount) {
      debtor.cash -= payment.amount;
      credit(state, payment.creditorId, payment.amount);
      continue;
    }
    state.pendingDebt = { ...payment, resumePhase };
    state.phase = "debt";
  }
  if (!state.pendingDebt && state.paymentQueue.length === 0) state.phase = resumePhase;
}

function queuePayments(state: GameState, payments: PendingPayment[], resumePhase: "manage" | "pre-roll" | "game-over" = "manage") {
  state.paymentQueue.push(...payments.filter((payment) => payment.amount > 0));
  processPayments(state, resumePhase);
}

function calculateRepairs(state: GameState, player: GamePlayer, houseRate: number, hotelRate: number) {
  return player.properties.reduce((total, index) => {
    const buildings = state.deeds[index].buildings;
    return total + (buildings === 5 ? hotelRate : buildings * houseRate);
  }, 0);
}

function nextOfType(position: number, indexes: number[]) {
  return indexes.find((index) => index > position) ?? indexes[0];
}

function drawCard(state: GameState, player: GamePlayer, deckName: "chance" | "community") {
  const deck = state[deckName];
  const card = deck.cards.shift()!;
  if (card !== "jail-free") deck.cards.push(card);
  const otherPlayers = activePlayers(state).filter((candidate) => candidate.id !== player.id);

  if (card === "jail-free") {
    player.getOutCards.push(deckName);
    state.phase = "manage";
  } else if (card === "go-jail") {
    sendToJail(state, player);
  } else if (card === "advance-start") {
    moveTo(state, player, 0, true);
    state.phase = "manage";
  } else if (deckName === "chance" && card === "advance-dp") {
    moveTo(state, player, 39, true); resolveLanding(state, player);
  } else if (deckName === "chance" && card === "advance-ev3") {
    moveTo(state, player, 24, true); resolveLanding(state, player);
  } else if (deckName === "chance" && card === "advance-al") {
    moveTo(state, player, 11, true); resolveLanding(state, player);
  } else if (deckName === "chance" && card.startsWith("nearest-transit")) {
    moveTo(state, player, nextOfType(player.position, TRANSIT_INDEXES), true); resolveLanding(state, player, 2);
  } else if (deckName === "chance" && card === "nearest-utility") {
    moveTo(state, player, nextOfType(player.position, UTILITY_INDEXES), true);
    const utilityRoll = rollDice(state);
    state.lastRoll = utilityRoll;
    resolveLanding(state, player, 10);
  } else if (deckName === "chance" && card === "back-three") {
    player.position = (player.position + 37) % 40; resolveLanding(state, player);
  } else if (deckName === "chance" && card === "trip-ion") {
    moveTo(state, player, 5, true); resolveLanding(state, player);
  } else if (card === "coop-dividend" || card === "stock-sale") {
    player.cash += 50; state.phase = "manage";
  } else if (card === "research-grant") {
    player.cash += 150; state.phase = "manage";
  } else if (card === "bank-error") {
    player.cash += 200; state.phase = "manage";
  } else if (card === "coop-bonus" || card === "insurance" || card === "inheritance") {
    player.cash += 100; state.phase = "manage";
  } else if (card === "tax-refund") {
    player.cash += 20; state.phase = "manage";
  } else if (card === "consulting") {
    player.cash += 25; state.phase = "manage";
  } else if (card === "design-prize") {
    player.cash += 10; state.phase = "manage";
  } else if (card === "health-fee" || card === "school-fee") {
    queuePayments(state, [{ debtorId: player.id, creditorId: "bank", amount: 50, reason: CARD_LABELS[card] }]);
  } else if (card === "hospital") {
    queuePayments(state, [{ debtorId: player.id, creditorId: "bank", amount: 100, reason: CARD_LABELS[card] }]);
  } else if (card === "parking-fine") {
    queuePayments(state, [{ debtorId: player.id, creditorId: "bank", amount: 15, reason: CARD_LABELS[card] }]);
  } else if (card === "general-repairs") {
    queuePayments(state, [{ debtorId: player.id, creditorId: "bank", amount: calculateRepairs(state, player, 25, 100), reason: CARD_LABELS[card] }]);
  } else if (card === "street-repairs") {
    queuePayments(state, [{ debtorId: player.id, creditorId: "bank", amount: calculateRepairs(state, player, 40, 115), reason: CARD_LABELS[card] }]);
  } else if (card === "club-chair") {
    queuePayments(state, otherPlayers.map((other) => ({ debtorId: player.id, creditorId: other.id, amount: 50, reason: CARD_LABELS[card] })));
  } else if (card === "birthday") {
    queuePayments(state, otherPlayers.map((other) => ({ debtorId: other.id, creditorId: player.id, amount: 10, reason: CARD_LABELS[card] })));
  } else {
    state.phase = "manage";
  }
  addEvent(state, "bank", "draw-card", { playerId: player.id, deck: deckName, card, label: CARD_LABELS[card] });
}

function resolveLanding(state: GameState, player: GamePlayer, specialRentMultiplier = 1) {
  const space = BOARD[player.position];
  if (space.kind === "property" || space.kind === "transit" || space.kind === "utility") {
    const deedState = state.deeds[space.index];
    if (!deedState.ownerId) {
      state.pendingPurchase = { playerId: player.id, spaceIndex: space.index };
      state.phase = "purchase";
      return;
    }
    if (deedState.ownerId !== player.id && !deedState.mortgaged) {
      const rollTotal = (state.lastRoll?.[0] ?? 0) + (state.lastRoll?.[1] ?? 0);
      const rent = rentFor(state, space.index, rollTotal, specialRentMultiplier);
      queuePayments(state, [{ debtorId: player.id, creditorId: deedState.ownerId, amount: rent, reason: `Rent at ${space.name}` }]);
      return;
    }
    state.phase = "manage";
    return;
  }
  if (space.index === 30) { sendToJail(state, player); return; }
  if (space.index === 4) { queuePayments(state, [{ debtorId: player.id, creditorId: "bank", amount: 200, reason: "Tuition Due" }]); return; }
  if (space.index === 38) { queuePayments(state, [{ debtorId: player.id, creditorId: "bank", amount: 100, reason: "Textbook Bill" }]); return; }
  if (space.kind === "event") {
    drawCard(state, player, [2, 17, 33].includes(space.index) ? "community" : "chance");
    return;
  }
  state.phase = "manage";
}

function startAuction(state: GameState, spaceIndex: number, reason: AuctionState["reason"]) {
  const buildingKind = reason === "building-shortage" ? buildingKindForTarget(state, spaceIndex) : undefined;
  const bidders = activePlayers(state).filter((player) => player.cash > 0 && (!buildingKind || eligibleBuildingTargets(state, player.id, buildingKind).length > 0)).map((player) => player.id);
  if (!bidders.length) { finishAuction(state, null); return; }
  const startIndex = findNextPlayerIndex(state, state.currentPlayerIndex);
  const clockwise = [...state.players.slice(startIndex), ...state.players.slice(0, startIndex)]
    .filter((player) => bidders.includes(player.id))
    .map((player) => player.id);
  state.auction = {
    spaceIndex,
    activeBidderIds: clockwise,
    currentBidderId: clockwise[0],
    highBidderId: null,
    highBid: 0,
    reason,
    buildingKind,
  };
  state.pendingPurchase = null;
  state.phase = "auction";
}

function nextAuctionBidder(state: GameState) {
  const auction = state.auction!;
  if (!auction.activeBidderIds.length) { finishAuction(state, null); return; }
  if (auction.highBidderId && auction.activeBidderIds.length === 1 && auction.activeBidderIds[0] === auction.highBidderId) {
    finishAuction(state, auction.highBidderId);
    return;
  }
  const currentIndex = state.players.findIndex((player) => player.id === auction.currentBidderId);
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const id = state.players[(currentIndex + offset) % state.players.length].id;
    if (auction.activeBidderIds.includes(id) && id !== auction.highBidderId) {
      auction.currentBidderId = id;
      return;
    }
  }
  if (auction.highBidderId) finishAuction(state, auction.highBidderId);
  else auction.currentBidderId = auction.activeBidderIds[0];
}

function finishAuction(state: GameState, winnerId: string | null) {
  const auction = state.auction;
  if (!auction) return;
  if (winnerId) {
    const winner = getPlayer(state, winnerId);
    winner.cash -= auction.highBid;
    if (auction.reason === "building-shortage" && auction.buildingKind) {
      state.pendingBuildingPlacement = { playerId: winnerId, buildingKind: auction.buildingKind, auctionPrice: auction.highBid };
    } else {
      state.deeds[auction.spaceIndex].ownerId = winnerId;
      winner.properties.push(auction.spaceIndex);
      winner.properties.sort((a, b) => a - b);
    }
  }
  const reason = auction.reason;
  state.auction = null;
  if (reason === "bankruptcy" && state.bankruptcyAuctionQueue.length) {
    startAuction(state, state.bankruptcyAuctionQueue.shift()!, "bankruptcy");
  } else if (reason === "bankruptcy") {
    const resume = state.bankruptcyResume;
    state.bankruptcyResume = null;
    if (resume?.advanceTurn) advanceToNextActivePlayer(state);
    else {
      state.phase = resume?.phase ?? "manage";
      processPayments(state, state.phase === "pre-roll" ? "pre-roll" : "manage");
    }
  } else if (reason === "building-shortage" && state.pendingBuildingPlacement) {
    state.phase = "building-placement";
  } else {
    state.phase = "manage";
  }
}

function advanceToNextActivePlayer(state: GameState) {
  const previous = state.currentPlayerIndex;
  state.currentPlayerIndex = findNextPlayerIndex(state, previous);
  if (state.currentPlayerIndex <= previous) state.round += 1;
  state.phase = "pre-roll";
  state.lastRoll = null;
  state.extraRoll = false;
  state.doublesInTurn = 0;
}

function groupHasBuildings(state: GameState, spaceIndex: number) {
  return groupFor(spaceIndex).some((index) => state.deeds[index].buildings > 0);
}

function buildingKindForTarget(state: GameState, spaceIndex: number): "house" | "hotel" {
  return state.deeds[spaceIndex].buildings === (state.mode === "short" ? 3 : 4) ? "hotel" : "house";
}

function canDevelopStructure(state: GameState, playerId: string, spaceIndex: number, kind?: "house" | "hotel") {
  const deed = deedFor(spaceIndex);
  const deedState = state.deeds[spaceIndex];
  if (!deed || deed.kind !== "property" || deedState.ownerId !== playerId || deedState.mortgaged || !ownsGroup(state, playerId, spaceIndex)) return false;
  const group = groupFor(spaceIndex);
  if (group.some((index) => state.deeds[index].mortgaged)) return false;
  const current = deedState.buildings;
  const hotelThreshold = state.mode === "short" ? 3 : 4;
  if (current === 5) return false;
  const comparable = group.map((index) => state.deeds[index].buildings === 5 ? hotelThreshold + 1 : state.deeds[index].buildings);
  const normalizedCurrent = current === 5 ? hotelThreshold + 1 : current;
  if (normalizedCurrent !== Math.min(...comparable)) return false;
  if (current === hotelThreshold) return (!kind || kind === "hotel") && group.every((index) => state.deeds[index].buildings >= hotelThreshold);
  return (!kind || kind === "house") && current < hotelThreshold;
}

export function eligibleBuildingTargets(state: GameState, playerId: string, kind: "house" | "hotel") {
  return getPlayer(state, playerId).properties.filter((index) => canDevelopStructure(state, playerId, index, kind));
}

function buildingShortage(state: GameState, kind: "house" | "hotel") {
  const available = kind === "house" ? state.bank.houses : state.bank.hotels;
  if (available <= 0) return false;
  const demanders = activePlayers(state).filter((player) => player.cash > 0 && eligibleBuildingTargets(state, player.id, kind).length > 0).length;
  return demanders > available;
}

export function canBuild(state: GameState, playerId: string, spaceIndex: number) {
  if (!canDevelopStructure(state, playerId, spaceIndex)) return false;
  const kind = buildingKindForTarget(state, spaceIndex);
  const available = kind === "house" ? state.bank.houses : state.bank.hotels;
  return available > 0 && !buildingShortage(state, kind);
}

export function canSellBuilding(state: GameState, playerId: string, spaceIndex: number) {
  const deed = deedFor(spaceIndex);
  const deedState = state.deeds[spaceIndex];
  if (!deed || deed.kind !== "property" || deedState.ownerId !== playerId || deedState.buildings === 0) return false;
  const group = groupFor(spaceIndex);
  const hotelThreshold = state.mode === "short" ? 3 : 4;
  const comparable = group.map((index) => state.deeds[index].buildings === 5 ? hotelThreshold + 1 : state.deeds[index].buildings);
  const normalizedCurrent = deedState.buildings === 5 ? hotelThreshold + 1 : deedState.buildings;
  if (normalizedCurrent !== Math.max(...comparable)) return false;
  return deedState.buildings !== 5 || state.bank.houses >= hotelThreshold;
}

function validateTradeAssets(state: GameState, ownerId: string, assets: TradeAssets) {
  const owner = getPlayer(state, ownerId);
  if (!Number.isInteger(assets.cash) || assets.cash < 0 || assets.cash > owner.cash) return false;
  if (new Set(assets.properties).size !== assets.properties.length || new Set(assets.getOutCards).size !== assets.getOutCards.length) return false;
  if (!assets.properties.every((index) => state.deeds[index]?.ownerId === ownerId && !groupHasBuildings(state, index))) return false;
  const cards = [...owner.getOutCards];
  return assets.getOutCards.every((card) => {
    const index = cards.indexOf(card);
    if (index < 0) return false;
    cards.splice(index, 1);
    return true;
  });
}

export function validateTrade(state: GameState, offer: TradeOffer) {
  if (offer.fromId === offer.toId || offer.counterDepth < 0 || offer.counterDepth > 2) return false;
  const from = getPlayer(state, offer.fromId);
  const to = getPlayer(state, offer.toId);
  if (from.bankrupt || to.bankrupt || !validateTradeAssets(state, from.id, offer.offer) || !validateTradeAssets(state, to.id, offer.request)) return false;
  const fromInterest = offer.request.properties.reduce((sum, index) => sum + (state.deeds[index].mortgaged ? Math.ceil(deedFor(index).mortgage * 0.1) : 0), 0);
  const toInterest = offer.offer.properties.reduce((sum, index) => sum + (state.deeds[index].mortgaged ? Math.ceil(deedFor(index).mortgage * 0.1) : 0), 0);
  return from.cash - offer.offer.cash + offer.request.cash >= fromInterest && to.cash - offer.request.cash + offer.offer.cash >= toInterest;
}

function transferAssets(state: GameState, fromId: string, toId: string, assets: TradeAssets) {
  const from = getPlayer(state, fromId);
  const to = getPlayer(state, toId);
  from.cash -= assets.cash;
  to.cash += assets.cash;
  for (const index of assets.properties) {
    state.deeds[index].ownerId = toId;
    from.properties = from.properties.filter((property) => property !== index);
    to.properties.push(index);
    if (state.deeds[index].mortgaged) to.cash -= Math.ceil(deedFor(index).mortgage * 0.1);
  }
  to.properties.sort((a, b) => a - b);
  for (const card of assets.getOutCards) {
    from.getOutCards.splice(from.getOutCards.indexOf(card), 1);
    to.getOutCards.push(card);
  }
}

function settleDebtIfPossible(state: GameState) {
  const debt = state.pendingDebt;
  if (!debt) return;
  const debtor = getPlayer(state, debt.debtorId);
  if (debtor.cash < debt.amount) return;
  debtor.cash -= debt.amount;
  credit(state, debt.creditorId, debt.amount);
  const resume = debt.resumePhase;
  state.pendingDebt = null;
  processPayments(state, resume);
  if (!state.pendingDebt && state.postDebtAction) {
    const action = state.postDebtAction;
    state.postDebtAction = null;
    if (action === "short-game-over") checkForWinner(state);
    else advanceToNextActivePlayer(state);
  }
  if (!state.pendingDebt && state.pendingLandingAfterDebt) {
    state.pendingLandingAfterDebt = false;
    resolveLanding(state, debtor);
  }
}

function returnJailCards(state: GameState, player: GamePlayer) {
  for (const card of player.getOutCards) state[card].cards.push("jail-free");
  player.getOutCards = [];
}

function checkForWinner(state: GameState) {
  const alive = activePlayers(state);
  if (state.mode === "short" && state.players.some((player) => player.bankrupt)) {
    const richest = [...alive].sort((a, b) => netWorth(state, b.id) - netWorth(state, a.id))[0];
    state.winnerId = richest?.id ?? null;
    state.phase = "game-over";
    return true;
  }
  if (alive.length <= 1) {
    state.winnerId = alive[0]?.id ?? null;
    state.phase = "game-over";
    return true;
  }
  return false;
}

function bankruptPlayer(state: GameState) {
  const debt = state.pendingDebt!;
  const debtor = getPlayer(state, debt.debtorId);
  const debtorWasCurrent = currentPlayer(state).id === debtor.id;
  for (const index of debtor.properties) {
    const deed = deedFor(index);
    const deedState = state.deeds[index];
    if (deedState.buildings > 0 && deed.kind === "property") {
      const buildingCount = deedState.buildings === 5 ? (state.mode === "short" ? 4 : 5) : deedState.buildings;
      const refund = buildingCount * Math.floor(deed.houseCost! / 2);
      credit(state, debt.creditorId, refund);
      if (deedState.buildings === 5) state.bank.hotels += 1;
      else state.bank.houses += deedState.buildings;
      deedState.buildings = 0;
    }
  }
  credit(state, debt.creditorId, debtor.cash);
  debtor.cash = 0;
  debtor.bankrupt = true;
  returnJailCards(state, debtor);
  const properties = [...debtor.properties];
  let transferInterest = 0;
  debtor.properties = [];
  if (debt.creditorId === "bank") {
    for (const index of properties) {
      state.deeds[index] = { ownerId: null, buildings: 0, mortgaged: false };
    }
    state.bankruptcyAuctionQueue.push(...properties);
  } else {
    const creditor = getPlayer(state, debt.creditorId);
    for (const index of properties) {
      state.deeds[index].ownerId = creditor.id;
      creditor.properties.push(index);
      if (state.deeds[index].mortgaged) transferInterest += Math.ceil(deedFor(index).mortgage * 0.1);
    }
    creditor.properties.sort((a, b) => a - b);
  }
  state.pendingDebt = null;
  state.pendingLandingAfterDebt = false;
  state.paymentQueue = state.paymentQueue.filter((payment) => payment.debtorId !== debtor.id);
  if (debt.creditorId !== "bank" && transferInterest > 0) {
    const creditor = getPlayer(state, debt.creditorId);
    if (creditor.cash >= transferInterest) creditor.cash -= transferInterest;
    else {
      state.pendingDebt = { debtorId: creditor.id, creditorId: "bank", amount: transferInterest, reason: "Mortgage transfer interest", resumePhase: "manage" };
      state.postDebtAction = state.mode === "short" ? "short-game-over" : debtorWasCurrent ? "advance-turn" : null;
      state.phase = "debt";
      return;
    }
  }
  if (checkForWinner(state)) { state.postDebtAction = null; return; }
  if (debt.creditorId === "bank" && state.bankruptcyAuctionQueue.length) {
    state.bankruptcyResume = { phase: debt.resumePhase === "pre-roll" ? "pre-roll" : "manage", advanceTurn: debtorWasCurrent };
    startAuction(state, state.bankruptcyAuctionQueue.shift()!, "bankruptcy");
  } else if (debtorWasCurrent) advanceToNextActivePlayer(state);
  else {
    state.phase = debt.resumePhase;
    processPayments(state, debt.resumePhase);
  }
}

function ownsDeed(state: GameState, playerId: string, index: number) {
  return Boolean(state.deeds[index] && state.deeds[index].ownerId === playerId);
}

export function isLegalAction(state: GameState, actorId: string, action: GameAction) {
  if (state.phase === "game-over") return false;
  const actor = getPlayer(state, actorId);
  if (actor.bankrupt) return false;
  const active = currentPlayer(state);
  if (state.phase === "auction") {
    if (state.auction?.currentBidderId !== actorId) return false;
    if (action.type === "auction-pass") return true;
    return action.type === "auction-bid" && Number.isInteger(action.amount) && action.amount > state.auction.highBid && action.amount <= actor.cash;
  }
  if (state.phase === "building-placement") {
    return action.type === "place-auction-building"
      && state.pendingBuildingPlacement?.playerId === actorId
      && canDevelopStructure(state, actorId, action.spaceIndex, state.pendingBuildingPlacement.buildingKind);
  }
  if (state.phase === "trade-response") {
    if (state.pendingTrade?.toId !== actorId) return false;
    if (action.type === "accept-trade" || action.type === "reject-trade") return true;
    return action.type === "counter-trade"
      && action.offer.fromId === actorId
      && action.offer.toId === state.pendingTrade.fromId
      && action.offer.counterDepth === state.pendingTrade.counterDepth + 1
      && validateTrade(state, action.offer);
  }
  if (state.phase === "debt") {
    if (state.pendingDebt?.debtorId !== actorId) return false;
    if (action.type === "sell-building") return canSellBuilding(state, actorId, action.spaceIndex);
    if (action.type === "mortgage") return ownsDeed(state, actorId, action.spaceIndex) && !state.deeds[action.spaceIndex].mortgaged && !groupHasBuildings(state, action.spaceIndex);
    return action.type === "declare-bankruptcy" && liquidationValue(state, actorId) < state.pendingDebt.amount;
  }
  if (active.id !== actorId) return false;
  if (state.phase === "pre-roll") {
    if (!actor.inJail) return action.type === "roll";
    if (action.type === "roll") return state.mode === "classic";
    if (action.type === "pay-jail") return true;
    return action.type === "use-jail-card" && actor.getOutCards.includes(action.deck);
  }
  if (state.phase === "purchase") {
    if (state.pendingPurchase?.playerId !== actorId) return false;
    if (action.type === "decline-property") return true;
    return action.type === "buy-property" && actor.cash >= deedFor(state.pendingPurchase.spaceIndex).price;
  }
  if (state.phase === "manage") {
    if (action.type === "end-turn") return true;
    if (action.type === "build") return canBuild(state, actorId, action.spaceIndex) && actor.cash >= deedFor(action.spaceIndex).houseCost!;
    if (action.type === "request-building-auction") {
      const available = action.buildingKind === "house" ? state.bank.houses : state.bank.hotels;
      return available > 0 && buildingShortage(state, action.buildingKind) && eligibleBuildingTargets(state, actorId, action.buildingKind).length > 0;
    }
    if (action.type === "sell-building") return canSellBuilding(state, actorId, action.spaceIndex);
    if (action.type === "mortgage") return ownsDeed(state, actorId, action.spaceIndex) && !state.deeds[action.spaceIndex].mortgaged && !groupHasBuildings(state, action.spaceIndex);
    if (action.type === "unmortgage") return ownsDeed(state, actorId, action.spaceIndex) && state.deeds[action.spaceIndex].mortgaged && actor.cash >= Math.ceil(deedFor(action.spaceIndex).mortgage * 1.1);
    return action.type === "propose-trade" && action.offer.fromId === actorId && validateTrade(state, action.offer);
  }
  return false;
}

function executeRoll(state: GameState, player: GamePlayer) {
  const dice = rollDice(state);
  state.lastRoll = dice;
  const isDouble = dice[0] === dice[1];
  if (player.inJail) {
    if (isDouble) {
      player.inJail = false;
      player.jailTurns = 0;
      state.extraRoll = false;
      moveTo(state, player, (player.position + dice[0] + dice[1]) % 40, true);
      resolveLanding(state, player);
      return;
    }
    player.jailTurns += 1;
    if (player.jailTurns >= 3) {
      player.inJail = false;
      player.jailTurns = 0;
      state.extraRoll = false;
      queuePayments(state, [{ debtorId: player.id, creditorId: "bank", amount: 50, reason: "Third failed jail roll" }], "manage");
      moveTo(state, player, (player.position + dice[0] + dice[1]) % 40, true);
      if (!state.pendingDebt) resolveLanding(state, player);
      else state.pendingLandingAfterDebt = true;
    } else {
      state.extraRoll = false;
      state.phase = "manage";
    }
    return;
  }
  state.doublesInTurn = isDouble ? state.doublesInTurn + 1 : 0;
  if (state.doublesInTurn >= 3) { sendToJail(state, player); return; }
  state.extraRoll = isDouble;
  const destination = (player.position + dice[0] + dice[1]) % 40;
  moveTo(state, player, destination, true);
  resolveLanding(state, player);
}

function applyBuilding(state: GameState, player: GamePlayer, index: number, selling: boolean, prepaid = false) {
  const deed = deedFor(index);
  const deedState = state.deeds[index];
  const hotelThreshold = state.mode === "short" ? 3 : 4;
  if (selling) {
    player.cash += Math.floor(deed.houseCost! / 2);
    if (deedState.buildings === 5) {
      deedState.buildings = hotelThreshold;
      state.bank.hotels += 1;
      state.bank.houses -= hotelThreshold;
    } else {
      deedState.buildings -= 1;
      state.bank.houses += 1;
    }
  } else {
    if (!prepaid) player.cash -= deed.houseCost!;
    if (deedState.buildings === hotelThreshold) {
      deedState.buildings = 5;
      state.bank.hotels -= 1;
      state.bank.houses += hotelThreshold;
    } else {
      deedState.buildings += 1;
      state.bank.houses -= 1;
    }
  }
}

export function applyAction(input: GameState, actorId: string, action: GameAction) {
  if (!isLegalAction(input, actorId, action)) throw new Error(`Illegal action ${action.type} by ${actorId} during ${input.phase}.`);
  const state = structuredClone(input) as GameState;
  const actor = getPlayer(state, actorId);
  const purchaseIndex = action.type === "buy-property" ? state.pendingPurchase?.spaceIndex : undefined;

  switch (action.type) {
    case "roll": executeRoll(state, actor); break;
    case "pay-jail":
      actor.inJail = false; actor.jailTurns = 0;
      queuePayments(state, [{ debtorId: actor.id, creditorId: "bank", amount: 50, reason: "Jail release fee" }], "pre-roll");
      break;
    case "use-jail-card": {
      actor.getOutCards.splice(actor.getOutCards.indexOf(action.deck), 1);
      state[action.deck].cards.push("jail-free");
      actor.inJail = false; actor.jailTurns = 0; state.phase = "pre-roll"; break;
    }
    case "buy-property": {
      const index = state.pendingPurchase!.spaceIndex;
      const price = deedFor(index).price;
      actor.cash -= price; actor.properties.push(index); actor.properties.sort((a, b) => a - b);
      state.deeds[index].ownerId = actor.id; state.pendingPurchase = null; state.phase = "manage"; break;
    }
    case "decline-property": startAuction(state, state.pendingPurchase!.spaceIndex, "declined"); break;
    case "auction-bid":
      state.auction!.highBid = action.amount; state.auction!.highBidderId = actor.id; nextAuctionBidder(state); break;
    case "auction-pass":
      state.auction!.activeBidderIds = state.auction!.activeBidderIds.filter((id) => id !== actor.id); nextAuctionBidder(state); break;
    case "request-building-auction": {
      const target = eligibleBuildingTargets(state, actor.id, action.buildingKind)[0];
      startAuction(state, target, "building-shortage"); break;
    }
    case "place-auction-building":
      applyBuilding(state, actor, action.spaceIndex, false, true); state.pendingBuildingPlacement = null; state.phase = "manage"; break;
    case "build": applyBuilding(state, actor, action.spaceIndex, false); break;
    case "sell-building": applyBuilding(state, actor, action.spaceIndex, true); settleDebtIfPossible(state); break;
    case "mortgage": actor.cash += deedFor(action.spaceIndex).mortgage; state.deeds[action.spaceIndex].mortgaged = true; settleDebtIfPossible(state); break;
    case "unmortgage": actor.cash -= Math.ceil(deedFor(action.spaceIndex).mortgage * 1.1); state.deeds[action.spaceIndex].mortgaged = false; break;
    case "propose-trade": state.pendingTrade = action.offer; state.phase = "trade-response"; break;
    case "accept-trade": {
      const offer = state.pendingTrade!;
      transferAssets(state, offer.fromId, offer.toId, offer.offer);
      transferAssets(state, offer.toId, offer.fromId, offer.request);
      state.pendingTrade = null; state.phase = "manage"; break;
    }
    case "reject-trade": state.pendingTrade = null; state.phase = "manage"; break;
    case "counter-trade": state.pendingTrade = action.offer; state.phase = "trade-response"; break;
    case "declare-bankruptcy": bankruptPlayer(state); break;
    case "end-turn":
      if (state.extraRoll && !actor.inJail) { state.phase = "pre-roll"; state.extraRoll = false; }
      else advanceToNextActivePlayer(state);
      break;
  }
  const payload = { ...action } as unknown as Record<string, unknown>;
  if (action.type === "roll") {
    payload.dice = state.lastRoll;
    payload.destination = actor.position;
    payload.destinationName = BOARD[actor.position].name;
  }
  if (action.type === "buy-property" && purchaseIndex !== undefined) {
    payload.spaceIndex = purchaseIndex;
    payload.name = deedFor(purchaseIndex).name;
    payload.price = deedFor(purchaseIndex).price;
  }
  addEvent(state, actorId, action.type, payload);
  assertStateIntegrity(state);
  return state;
}

export function createGame(options: CreateGameOptions): GameState {
  if (options.players.length !== 4) throw new Error("A game requires exactly four players.");
  if (new Set(options.players.map((player) => player.id)).size !== options.players.length) throw new Error("Player ids must be unique.");
  const seed = normalizeSeed(options.seed);
  const chanceShuffle = shuffle(CHANCE_CARD_IDS, seed);
  const communityShuffle = shuffle(COMMUNITY_CARD_IDS, chanceShuffle.state);
  const createdAt = options.createdAt ?? Date.now();
  const players: GamePlayer[] = options.players.map((player) => ({
    ...player, cash: 1500, position: 0, properties: [], inJail: false, jailTurns: 0, bankrupt: false, getOutCards: [],
  }));
  const deeds = Object.fromEntries(DEED_INDEXES.map((index) => [index, { ownerId: null, buildings: 0, mortgaged: false }]));
  const state: GameState = {
    schemaVersion: GAME_SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    policyVersion: POLICY_VERSION,
    id: `uwm-${seed.toString(16).padStart(8, "0")}`,
    mode: options.mode,
    seed,
    rngState: communityShuffle.state,
    rngCursor: chanceShuffle.draws + communityShuffle.draws,
    round: 1,
    phase: "pre-roll",
    players,
    currentPlayerIndex: 0,
    deeds,
    bank: { houses: 32, hotels: 12 },
    chance: { cards: [...chanceShuffle.items] },
    community: { cards: [...communityShuffle.items] },
    doublesInTurn: 0,
    extraRoll: false,
    lastRoll: null,
    pendingPurchase: null,
    auction: null,
    pendingBuildingPlacement: null,
    pendingDebt: null,
    paymentQueue: [],
    pendingLandingAfterDebt: false,
    pendingTrade: null,
    bankruptcyAuctionQueue: [],
    bankruptcyResume: null,
    postDebtAction: null,
    winnerId: null,
    events: [],
    jevCalls: 0,
    fallbackDecisions: 0,
    telemetryEnabled: options.telemetryEnabled ?? true,
    createdAt,
    updatedAt: createdAt,
  };

  if (options.mode === "short") {
    const deal = shuffle(DEED_INDEXES, state.rngState);
    state.rngState = deal.state;
    state.rngCursor += deal.draws;
    for (let round = 0; round < 3; round += 1) {
      for (const player of players) {
        const index = deal.items[round * players.length + players.indexOf(player)];
        state.deeds[index].ownerId = player.id;
        player.properties.push(index);
      }
    }
  }

  let contenders = [...players];
  while (contenders.length > 1) {
    const starts = contenders.map((player) => ({ player, roll: rollDice(state) }));
    const high = Math.max(...starts.map(({ roll }) => roll[0] + roll[1]));
    contenders = starts.filter(({ roll }) => roll[0] + roll[1] === high).map(({ player }) => player);
  }
  state.currentPlayerIndex = players.indexOf(contenders[0]);
  addEvent(state, "system", "game-created", {
    mode: state.mode,
    playerOrder: players.map((player) => player.id),
    startingPlayerId: currentPlayer(state).id,
  });
  assertStateIntegrity(state);
  return state;
}

export function assertStateIntegrity(state: GameState) {
  if (state.schemaVersion !== GAME_SCHEMA_VERSION || state.rulesVersion !== RULES_VERSION) throw new Error("Unsupported game state version.");
  if (state.players.length !== 4) throw new Error("Game must retain four player records.");
  if (state.bank.houses < 0 || state.bank.houses > 32 || state.bank.hotels < 0 || state.bank.hotels > 12) throw new Error("Bank building inventory is invalid.");
  const propertyLists = state.players.flatMap((player) => player.properties.map((index) => `${player.id}:${index}`));
  if (new Set(propertyLists.map((entry) => entry.split(":")[1])).size !== propertyLists.length) throw new Error("A deed appears in more than one player inventory.");
  for (const index of DEED_INDEXES) {
    const deed = state.deeds[index];
    if (!deed || deed.buildings < 0 || deed.buildings > 5) throw new Error(`Invalid deed state at ${index}.`);
    if (deed.ownerId && !getPlayer(state, deed.ownerId).properties.includes(index)) throw new Error(`Deed ${index} owner inventory mismatch.`);
    if (!deed.ownerId && deed.buildings !== 0) throw new Error(`Unowned deed ${index} has buildings.`);
    if (deed.mortgaged && deed.buildings > 0) throw new Error(`Mortgaged deed ${index} has buildings.`);
  }
  for (const indexes of Object.values(GROUPS)) {
    const levels = indexes.map((index) => state.deeds[index].buildings === 5 ? (state.mode === "short" ? 4 : 5) : state.deeds[index].buildings);
    if (Math.max(...levels) - Math.min(...levels) > 1) throw new Error(`Uneven building state in group ${indexes.join(",")}.`);
  }
  if (!state.pendingDebt && state.players.some((player) => !player.bankrupt && player.cash < 0)) throw new Error("Solvent player has negative cash outside debt resolution.");
  if (state.phase === "game-over" && !state.winnerId) throw new Error("Finished game has no winner.");
  return true;
}

export function replayGame(initial: GameState, events: Array<{ actorId: string; action: GameAction }>) {
  return events.reduce((state, event) => applyAction(state, event.actorId, event.action), structuredClone(initial));
}
