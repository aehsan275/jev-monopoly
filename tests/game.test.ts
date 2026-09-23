import assert from "node:assert/strict";
import test from "node:test";
import { BOARD, assertBoardIntegrity, gridPosition } from "../lib/game/board.ts";
import { combineDecisions, validateDecision } from "../lib/game/policy.ts";
import { SCENARIOS, assertScenarioIntegrity } from "../lib/game/scenarios.ts";

test("board has the canonical 40 unique perimeter positions", () => {
  assert.equal(assertBoardIntegrity(), true);
  const coordinates = BOARD.map((space) => {
    const position = gridPosition(space.index);
    assert.ok(position.row >= 1 && position.row <= 11);
    assert.ok(position.column >= 1 && position.column <= 11);
    assert.ok(position.row === 1 || position.row === 11 || position.column === 1 || position.column === 11);
    return `${position.row}:${position.column}`;
  });
  assert.equal(new Set(coordinates).size, 40);
});

test("all six showcase scenarios expose only valid recorded decisions", () => {
  assert.equal(SCENARIOS.length, 6);
  for (const scenario of SCENARIOS) assert.equal(assertScenarioIntegrity(scenario), true);
});

test("the combined policy always produces a normalized legal decision", () => {
  for (const scenario of SCENARIOS) {
    const champion = combineDecisions(scenario);
    assert.equal(validateDecision(champion, scenario.legalActions), true);
    const sum = Object.values(champion.probabilities).reduce((total, value) => total + value, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  }
});

test("scenario state does not contain impossible property owners", () => {
  for (const scenario of SCENARIOS) {
    const playerIds = new Set(scenario.state.players.map((player) => player.id));
    for (const [spaceIndex, state] of Object.entries(scenario.state.propertyState)) {
      assert.ok(BOARD[Number(spaceIndex)], `unknown board space ${spaceIndex}`);
      assert.ok(playerIds.has(state.ownerId), `unknown owner ${state.ownerId}`);
    }
  }
});
