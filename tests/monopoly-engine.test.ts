import assert from "node:assert/strict";
import test from "node:test";
import { DEED_INDEXES, TITLE_DEEDS } from "../lib/monopoly/data.ts";
import { applyAction, assertStateIntegrity, createGame, isLegalAction, netWorth, replayGame, stateHash } from "../lib/monopoly/engine.ts";
import { generateLegalPlans } from "../lib/monopoly/plans.ts";
import { sanitizeReplay, validateReplay } from "../lib/monopoly/replay-validation.ts";
import { nextRandom } from "../lib/monopoly/rng.ts";
import { simulateGame } from "../lib/monopoly/simulator.ts";
import type { GameState, PlayerSpec, TradeOffer } from "../lib/monopoly/types.ts";

const specs: PlayerSpec[] = [
  { id: "human", name: "Human", token: "H", kind: "human", policy: "human" },
  { id: "champion", name: "Champion", token: "π", kind: "ai", policy: "champion" },
  { id: "builder", name: "Builder", token: "▲", kind: "ai", policy: "builder" },
  { id: "risk", name: "Risk", token: "◆", kind: "ai", policy: "risk" },
];

function game(seed = 1234, mode: "classic" | "short" = "classic") {
  return createGame({ seed, mode, players: specs, createdAt: 1000, telemetryEnabled: false });
}

function makeCurrent(state: GameState, playerId: string) {
  state.currentPlayerIndex = state.players.findIndex((player) => player.id === playerId);
}

function own(state: GameState, playerId: string, indexes: number[]) {
  const player = state.players.find((candidate) => candidate.id === playerId)!;
  for (const index of indexes) {
    const previousOwner = state.deeds[index].ownerId;
    if (previousOwner) {
      const previous = state.players.find((candidate) => candidate.id === previousOwner)!;
      previous.properties = previous.properties.filter((property) => property !== index);
    }
    state.deeds[index].ownerId = playerId;
    if (!player.properties.includes(index)) player.properties.push(index);
  }
  player.properties.sort((a, b) => a - b);
}

function findRng(predicate: (rolls: Array<[number, number]>) => boolean, rollCount: number) {
  for (let seed = 1; seed < 200_000; seed += 1) {
    let value = seed;
    const rolls: Array<[number, number]> = [];
    for (let roll = 0; roll < rollCount; roll += 1) {
      const first = nextRandom(value); value = first.state;
      const second = nextRandom(value); value = second.state;
      rolls.push([Math.floor(first.value * 6) + 1, Math.floor(second.value * 6) + 1]);
    }
    if (predicate(rolls)) return seed;
  }
  throw new Error("Unable to find deterministic roll sequence.");
}

test("canonical board contains 28 complete title deeds", () => {
  assert.equal(DEED_INDEXES.length, 28);
  assert.deepEqual(TITLE_DEEDS[39].rent, [50, 200, 600, 1400, 1700, 2000]);
  assert.equal(TITLE_DEEDS[39].mortgage, 200);
  assert.equal(TITLE_DEEDS[1].houseCost, 50);
});

test("game creation is deterministic for a seed and timestamp", () => {
  assert.deepEqual(game(77), game(77));
  assert.notDeepEqual(game(77).chance.cards, game(78).chance.cards);
});

test("short game deals three unique deeds to every player", () => {
  const state = game(99, "short");
  assert.equal(state.players.every((player) => player.properties.length === 3), true);
  assert.equal(new Set(state.players.flatMap((player) => player.properties)).size, 12);
  assert.equal(assertStateIntegrity(state), true);
});

test("declining an unowned property starts the mandatory auction", () => {
  let state = game();
  makeCurrent(state, "human");
  state.phase = "purchase";
  state.pendingPurchase = { playerId: "human", spaceIndex: 1 };
  state = applyAction(state, "human", { type: "decline-property" });
  assert.equal(state.phase, "auction");
  assert.equal(state.auction?.spaceIndex, 1);
  assert.equal(state.auction?.activeBidderIds.includes("human"), true);
});

test("purchase transfers exact face value and ownership", () => {
  let state = game();
  makeCurrent(state, "human");
  state.phase = "purchase";
  state.pendingPurchase = { playerId: "human", spaceIndex: 39 };
  state = applyAction(state, "human", { type: "buy-property" });
  assert.equal(state.players[0].cash, 1100);
  assert.equal(state.deeds[39].ownerId, "human");
  assert.equal(state.phase, "manage");
});

test("houses must be built and sold evenly", () => {
  let state = game();
  makeCurrent(state, "human");
  state.phase = "manage";
  own(state, "human", [1, 3]);
  state = applyAction(state, "human", { type: "build", spaceIndex: 1 });
  assert.equal(isLegalAction(state, "human", { type: "build", spaceIndex: 1 }), false);
  assert.equal(isLegalAction(state, "human", { type: "build", spaceIndex: 3 }), true);
  state = applyAction(state, "human", { type: "build", spaceIndex: 3 });
  assert.equal(state.bank.houses, 30);
  assert.equal(assertStateIntegrity(state), true);
  assert.equal(isLegalAction(state, "human", { type: "sell-building", spaceIndex: 1 }), true);
});

test("an improved color group cannot be mortgaged", () => {
  let state = game();
  makeCurrent(state, "human");
  state.phase = "manage";
  own(state, "human", [1, 3]);
  state = applyAction(state, "human", { type: "build", spaceIndex: 1 });
  assert.equal(isLegalAction(state, "human", { type: "mortgage", spaceIndex: 3 }), false);
});

test("railroad and utility rent count mortgaged sister deeds as owned", () => {
  const rollFive = findRng((rolls) => rolls[0][0] + rolls[0][1] === 5 && rolls[0][0] !== rolls[0][1], 1);

  let transitState = game();
  makeCurrent(transitState, "human");
  own(transitState, "champion", [5, 15]);
  transitState.deeds[15].mortgaged = true;
  transitState.rngState = rollFive;
  transitState = applyAction(transitState, "human", { type: "roll" });
  assert.equal(transitState.players[0].cash, 1450);
  assert.equal(transitState.players[1].cash, 1550);

  let utilityState = game();
  makeCurrent(utilityState, "human");
  own(utilityState, "champion", [12, 28]);
  utilityState.deeds[28].mortgaged = true;
  utilityState.players[0].position = 7;
  utilityState.rngState = rollFive;
  utilityState = applyAction(utilityState, "human", { type: "roll" });
  assert.equal(utilityState.players[0].cash, 1450);
  assert.equal(utilityState.players[1].cash, 1550);
});

test("three consecutive doubles send the player directly to jail", () => {
  let state = game();
  makeCurrent(state, "human");
  own(state, "human", DEED_INDEXES);
  state.rngState = findRng((rolls) => rolls.every(([a, b]) => a === b), 3);
  state.rngCursor = 0;
  for (let index = 0; index < 3; index += 1) {
    state = applyAction(state, "human", { type: "roll" });
    if (index < 2) state = applyAction(state, "human", { type: "end-turn" });
  }
  const human = state.players[0];
  assert.equal(human.inJail, true);
  assert.equal(human.position, 10);
  assert.equal(state.extraRoll, false);
});

test("third failed jail roll charges the fee, moves, and grants no extra roll", () => {
  let state = game();
  makeCurrent(state, "human");
  own(state, "human", DEED_INDEXES);
  state.players[0].position = 10;
  state.players[0].inJail = true;
  state.players[0].jailTurns = 2;
  state.rngState = findRng((rolls) => rolls[0][0] !== rolls[0][1], 1);
  state = applyAction(state, "human", { type: "roll" });
  assert.equal(state.players[0].inJail, false);
  assert.equal(state.players[0].cash, 1450);
  assert.notEqual(state.players[0].position, 10);
  assert.equal(state.extraRoll, false);
});

test("Short Game forces jail release on the next turn", () => {
  const state = game(55, "short");
  makeCurrent(state, "human");
  state.players[0].inJail = true;
  state.players[0].position = 10;
  const plans = generateLegalPlans(state, "human");
  assert.equal(plans.some((candidate) => candidate.id === "jail:roll"), false);
  assert.equal(plans.some((candidate) => candidate.id === "jail:pay"), true);
  assert.equal(isLegalAction(state, "human", { type: "roll" }), false);
});

test("card movement resolves the destination rather than stopping at the card", () => {
  let state = game();
  makeCurrent(state, "human");
  state.chance.cards = ["back-three", ...state.chance.cards.filter((card) => card !== "back-three")];
  state.rngState = findRng((rolls) => rolls[0][0] + rolls[0][1] === 7, 1);
  state = applyAction(state, "human", { type: "roll" });
  assert.equal(state.players[0].position, 4);
  assert.equal(state.players[0].cash, 1300);
  assert.equal(state.events.some((event) => event.type === "draw-card" && event.payload.card === "back-three"), true);
});

test("bankruptcy to another player transfers deeds", () => {
  let state = game();
  makeCurrent(state, "human");
  own(state, "human", [1]);
  state.players[0].cash = 0;
  state.phase = "debt";
  state.pendingDebt = { debtorId: "human", creditorId: "champion", amount: 500, reason: "rent", resumePhase: "manage" };
  assert.equal(isLegalAction(state, "human", { type: "declare-bankruptcy" }), true);
  state = applyAction(state, "human", { type: "declare-bankruptcy" });
  assert.equal(state.players[0].bankrupt, true);
  assert.equal(state.deeds[1].ownerId, "champion");
  assert.equal(state.players[1].properties.includes(1), true);
});

test("mortgage interest from bankruptcy opens debt resolution for a cash-poor creditor", () => {
  let state = game();
  makeCurrent(state, "human");
  own(state, "human", [39]);
  state.deeds[39].mortgaged = true;
  state.players[0].cash = 0;
  state.players[1].cash = 0;
  state.phase = "debt";
  state.pendingDebt = { debtorId: "human", creditorId: "champion", amount: 500, reason: "rent", resumePhase: "manage" };
  state = applyAction(state, "human", { type: "declare-bankruptcy" });
  assert.equal(state.deeds[39].ownerId, "champion");
  assert.equal(state.players[1].cash, 0);
  assert.equal(state.pendingDebt?.debtorId, "champion");
  assert.equal(state.pendingDebt?.amount, 20);
  assert.equal(state.phase, "debt");
  assert.equal(assertStateIntegrity(state), true);
});

test("bankruptcy to the bank returns deeds and begins creditor auctions", () => {
  let state = game();
  makeCurrent(state, "human");
  own(state, "human", [1, 3]);
  state.players[0].cash = 0;
  state.phase = "debt";
  state.pendingDebt = { debtorId: "human", creditorId: "bank", amount: 500, reason: "tax", resumePhase: "manage" };
  state = applyAction(state, "human", { type: "declare-bankruptcy" });
  assert.equal(state.players[0].bankrupt, true);
  assert.equal(state.deeds[1].ownerId, null);
  assert.equal(state.deeds[3].ownerId, null);
  assert.equal(state.phase, "auction");
  assert.equal(state.auction?.reason, "bankruptcy");
  assert.equal(state.bankruptcyAuctionQueue.length, 1);
});

test("accepting a mortgaged deed charges immediate ten-percent interest", () => {
  let state = game();
  makeCurrent(state, "champion");
  state.phase = "manage";
  own(state, "human", [1]);
  state.deeds[1].mortgaged = true;
  const offer: TradeOffer = {
    id: "mortgage-transfer",
    fromId: "champion",
    toId: "human",
    offer: { cash: 100, properties: [], getOutCards: [] },
    request: { cash: 0, properties: [1], getOutCards: [] },
    counterDepth: 0,
  };
  state = applyAction(state, "champion", { type: "propose-trade", offer });
  state = applyAction(state, "human", { type: "accept-trade" });
  assert.equal(state.deeds[1].ownerId, "champion");
  assert.equal(state.players[1].cash, 1397);
});

test("net worth includes deeds and buildings", () => {
  let state = game();
  makeCurrent(state, "human");
  state.phase = "manage";
  own(state, "human", [1, 3]);
  state = applyAction(state, "human", { type: "build", spaceIndex: 1 });
  assert.equal(netWorth(state, "human"), 1500 - 50 + 60 + 60 + 50);
});

test("an action log deterministically recreates the same state", () => {
  const initial = game(31415);
  makeCurrent(initial, "human");
  own(initial, "human", DEED_INDEXES);
  initial.rngState = findRng((rolls) => rolls[0][0] + rolls[0][1] === 10 && rolls[0][0] !== rolls[0][1], 1);
  const actions = [
    { actorId: "human", action: { type: "roll" } as const },
    { actorId: "human", action: { type: "end-turn" } as const },
  ];
  const played = actions.reduce((state, event) => applyAction(state, event.actorId, event.action), structuredClone(initial));
  const replayed = replayGame(initial, actions);
  assert.equal(stateHash(replayed), stateHash(played));
  assert.deepEqual(replayed.players, played.players);
  assert.equal(replayed.events.at(-1)?.stateHash, played.events.at(-1)?.stateHash);
});

test("a seeded short-game simulation reaches a valid winner", () => {
  const result = simulateGame({ seed: 8128, mode: "short", maxActions: 20_000, sampleActions: true });
  assert.equal(result.failure, undefined);
  assert.equal(result.completed, true);
  assert.ok(result.state.winnerId);
  assert.equal(assertStateIntegrity(result.state), true);
  assert.equal(result.state.players.find((player) => player.id === result.state.winnerId)?.bankrupt, false);
  assert.equal(validateReplay(result.state), true);
  result.state.players[0].name = "A free-form player name";
  result.state.players[0].kind = "human";
  result.state.players[0].policy = "human";
  assert.equal(sanitizeReplay(result.state).players[0].name, "Human");
  const tampered = structuredClone(result.state);
  tampered.players[0].cash += 1;
  assert.throws(() => validateReplay(tampered), /does not reproduce/);
});

test("a seeded classic simulation reaches a valid winner", () => {
  const result = simulateGame({ seed: 101, mode: "classic", maxActions: 30_000, sampleActions: true });
  assert.equal(result.failure, undefined);
  assert.equal(result.completed, true);
  assert.ok(result.state.winnerId);
  assert.equal(assertStateIntegrity(result.state), true);
  assert.equal(result.state.players.find((player) => player.id === result.state.winnerId)?.bankrupt, false);
  assert.equal(validateReplay(result.state), true);
});
