import type { AgentDecision, AgentId, ArenaScenario, PublicGameState } from "./types.ts";

const agentFactors: Record<AgentId, string[]> = {
  builder: ["Set completion", "Rent acceleration"],
  risk: ["Cash after action", "One-turn downside"],
  dealmaker: ["Counterparty leverage", "Future exchange value"],
  balanced: ["Expected position", "Opponent denial"],
};

function decision(
  agentId: AgentId,
  probabilities: Record<string, number>,
  confidence: number,
): AgentDecision {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return {
    agentId,
    choice,
    confidence,
    probabilities,
    factors: agentFactors[agentId],
    source: "recorded-jev",
    latencyMs: 118 + Object.keys(probabilities).length * 7 + agentId.length,
  };
}

function baseState(overrides: Partial<PublicGameState> = {}): PublicGameState {
  return {
    round: 14,
    phase: "Decision window",
    activePlayerId: "champion",
    housesRemaining: 24,
    hotelsRemaining: 12,
    recentEvents: ["Opportunist collected $200", "Builder completed the orange set"],
    players: [
      { id: "champion", name: "Champion", token: "π", cash: 620, position: 24, properties: [6, 8, 9, 21, 23] },
      { id: "builder", name: "Builder", token: "▲", cash: 390, position: 15, properties: [16, 18, 19, 26] },
      { id: "risk", name: "Risk", token: "◆", cash: 810, position: 31, properties: [1, 3, 31] },
      { id: "dealer", name: "Dealer", token: "●", cash: 545, position: 7, properties: [11, 13, 14, 37] },
    ],
    propertyState: {
      1: { ownerId: "risk" },
      3: { ownerId: "risk" },
      6: { ownerId: "champion" },
      8: { ownerId: "champion" },
      9: { ownerId: "champion" },
      11: { ownerId: "dealer" },
      13: { ownerId: "dealer" },
      14: { ownerId: "dealer" },
      16: { ownerId: "builder", houses: 2 },
      18: { ownerId: "builder", houses: 2 },
      19: { ownerId: "builder", houses: 1 },
      21: { ownerId: "champion" },
      23: { ownerId: "champion" },
      26: { ownerId: "builder" },
      31: { ownerId: "risk" },
      37: { ownerId: "dealer" },
    },
    ...overrides,
  };
}

export const SCENARIOS: ArenaScenario[] = [
  {
    id: "premium-purchase",
    order: 1,
    family: "purchase",
    eyebrow: "Liquidity under pressure",
    title: "The QNC decision",
    prompt: "You land on QNC at $350 with $520 cash. Builder owns two orange houses and acts next. Buy, auction, or preserve liquidity?",
    insight: "The champion buys because the denial value outweighs near-term exposure—but refuses to build until it clears one rent cycle.",
    state: baseState({
      round: 12,
      phase: "Unowned property",
      players: [
        { id: "champion", name: "Champion", token: "π", cash: 520, position: 37, properties: [6, 8, 9, 21, 23] },
        { id: "builder", name: "Builder", token: "▲", cash: 390, position: 34, properties: [16, 18, 19, 26] },
        { id: "risk", name: "Risk", token: "◆", cash: 810, position: 31, properties: [1, 3, 31] },
        { id: "dealer", name: "Dealer", token: "●", cash: 545, position: 7, properties: [11, 13, 14] },
      ],
    }),
    legalActions: [
      { id: "buy", label: "Buy QNC for $350", shortLabel: "Buy", description: "Keep $170 and deny a premium deed.", kind: "purchase" },
      { id: "auction", label: "Send QNC to auction", shortLabel: "Auction", description: "Preserve cash but risk a cheap rival purchase.", kind: "auction" },
      { id: "mortgage-buy", label: "Mortgage EV1, then buy", shortLabel: "Finance", description: "Keep a larger reserve by mortgaging a red deed.", kind: "mortgage" },
    ],
    decisions: {
      builder: decision("builder", { buy: 0.66, auction: 0.07, "mortgage-buy": 0.27 }, 0.58),
      risk: decision("risk", { buy: 0.2, auction: 0.57, "mortgage-buy": 0.23 }, 0.42),
      dealmaker: decision("dealmaker", { buy: 0.52, auction: 0.15, "mortgage-buy": 0.33 }, 0.35),
      balanced: decision("balanced", { buy: 0.55, auction: 0.17, "mortgage-buy": 0.28 }, 0.39),
    },
  },
  {
    id: "auction-discipline",
    order: 2,
    family: "auction",
    eyebrow: "Price is not value",
    title: "The E7 auction ceiling",
    prompt: "E7 is at auction. The bid is $245; it completes no set for you but gives Builder two yellows. How far do you push?",
    insight: "The champion raises once to tax Builder’s liquidity, then exits before paying monopoly-completion prices for a non-completing deed.",
    state: baseState({ round: 17, phase: "Open auction", recentEvents: ["E7 entered auction at $10", "Builder bid $245"] }),
    legalActions: [
      { id: "pass", label: "Pass at $245", shortLabel: "Pass", description: "Keep every dollar; Builder gets E7 cheaply.", kind: "auction" },
      { id: "bid-260", label: "Bid $260", shortLabel: "$260", description: "Force another bid while staying below face value.", kind: "auction" },
      { id: "bid-300", label: "Bid $300", shortLabel: "$300", description: "Contest aggressively above face value.", kind: "auction" },
    ],
    decisions: {
      builder: decision("builder", { pass: 0.12, "bid-260": 0.38, "bid-300": 0.5 }, 0.36),
      risk: decision("risk", { pass: 0.46, "bid-260": 0.48, "bid-300": 0.06 }, 0.27),
      dealmaker: decision("dealmaker", { pass: 0.17, "bid-260": 0.7, "bid-300": 0.13 }, 0.6),
      balanced: decision("balanced", { pass: 0.21, "bid-260": 0.68, "bid-300": 0.11 }, 0.57),
    },
  },
  {
    id: "even-building",
    order: 3,
    family: "building",
    eyebrow: "Scarcity as a weapon",
    title: "Five houses, three orange deeds",
    prompt: "You control orange with five houses available and $470 cash. Build evenly now or keep a reserve for the red danger zone?",
    insight: "Three houses spread 2–2–1 creates a steep rent jump while preserving enough cash to survive the most likely opposing hit.",
    state: baseState({
      round: 20,
      phase: "Development window",
      housesRemaining: 5,
      players: [
        { id: "champion", name: "Champion", token: "π", cash: 470, position: 16, properties: [16, 18, 19, 6] },
        { id: "builder", name: "Builder", token: "▲", cash: 310, position: 8, properties: [21, 23, 24] },
        { id: "risk", name: "Risk", token: "◆", cash: 760, position: 29, properties: [1, 3, 31] },
        { id: "dealer", name: "Dealer", token: "●", cash: 610, position: 38, properties: [11, 13, 14] },
      ],
      propertyState: {
        6: { ownerId: "champion" },
        16: { ownerId: "champion" },
        18: { ownerId: "champion" },
        19: { ownerId: "champion" },
        21: { ownerId: "builder", houses: 1 },
        23: { ownerId: "builder", houses: 1 },
        24: { ownerId: "builder", houses: 1 },
      },
    }),
    legalActions: [
      { id: "build-221", label: "Build to 2–2–1", shortLabel: "2–2–1", description: "Spend $300 and keep $170.", kind: "build" },
      { id: "build-111", label: "Build to 1–1–1", shortLabel: "1–1–1", description: "Spend $300 from an undeveloped set baseline.", kind: "build" },
      { id: "hold", label: "Hold cash", shortLabel: "Hold", description: "Keep $470 and leave five houses in the bank.", kind: "hold" },
    ],
    decisions: {
      builder: decision("builder", { "build-221": 0.82, "build-111": 0.12, hold: 0.06 }, 0.74),
      risk: decision("risk", { "build-221": 0.37, "build-111": 0.18, hold: 0.45 }, 0.18),
      dealmaker: decision("dealmaker", { "build-221": 0.59, "build-111": 0.22, hold: 0.19 }, 0.4),
      balanced: decision("balanced", { "build-221": 0.69, "build-111": 0.13, hold: 0.18 }, 0.51),
    },
  },
  {
    id: "mortgage-sequence",
    order: 4,
    family: "mortgage",
    eyebrow: "Survive without surrendering",
    title: "A $450 rent bill",
    prompt: "You owe $450 with $90 cash. Choose which assets to mortgage while protecting the light-blue monopoly and future recovery.",
    insight: "The champion mortgages isolated deeds first, preserving every building and the complete set that can still generate a comeback.",
    state: baseState({ round: 26, phase: "Debt resolution", recentEvents: ["Champion landed on developed EV3", "Rent due: $450"] }),
    legalActions: [
      { id: "mortgage-isolated", label: "Mortgage QNC + transit", shortLabel: "Isolated assets", description: "Raise enough cash without breaking a productive set.", kind: "mortgage" },
      { id: "sell-houses", label: "Sell light-blue houses", shortLabel: "Sell houses", description: "Raise cash but collapse rent production.", kind: "sell" },
      { id: "mortgage-set", label: "Mortgage the light-blue set", shortLabel: "Mortgage set", description: "Protect isolated premium deeds instead.", kind: "mortgage" },
    ],
    decisions: {
      builder: decision("builder", { "mortgage-isolated": 0.58, "sell-houses": 0.34, "mortgage-set": 0.08 }, 0.42),
      risk: decision("risk", { "mortgage-isolated": 0.82, "sell-houses": 0.12, "mortgage-set": 0.06 }, 0.76),
      dealmaker: decision("dealmaker", { "mortgage-isolated": 0.65, "sell-houses": 0.17, "mortgage-set": 0.18 }, 0.48),
      balanced: decision("balanced", { "mortgage-isolated": 0.78, "sell-houses": 0.15, "mortgage-set": 0.07 }, 0.69),
    },
  },
  {
    id: "asymmetric-trade",
    order: 5,
    family: "trade",
    eyebrow: "Not all monopolies are equal",
    title: "Orange for green",
    prompt: "Dealer offers EXP plus $180 for DC. Both sides complete a set. The orange set is cheaper to build and opponents are approaching it.",
    insight: "The champion counters for more cash: orange activates sooner, and the board position makes immediate development unusually valuable.",
    state: baseState({ round: 18, phase: "Trade response", recentEvents: ["Dealer offered EXP + $180 for DC"] }),
    legalActions: [
      { id: "accept", label: "Accept the offer", shortLabel: "Accept", description: "Complete orange now; Dealer completes green.", kind: "trade" },
      { id: "counter-300", label: "Counter for $300", shortLabel: "+$300", description: "Price in orange’s lower build cost and board position.", kind: "trade" },
      { id: "reject", label: "Reject the exchange", shortLabel: "Reject", description: "Keep both sets incomplete.", kind: "trade" },
    ],
    decisions: {
      builder: decision("builder", { accept: 0.57, "counter-300": 0.36, reject: 0.07 }, 0.4),
      risk: decision("risk", { accept: 0.2, "counter-300": 0.48, reject: 0.32 }, 0.22),
      dealmaker: decision("dealmaker", { accept: 0.11, "counter-300": 0.81, reject: 0.08 }, 0.73),
      balanced: decision("balanced", { accept: 0.25, "counter-300": 0.63, reject: 0.12 }, 0.49),
    },
  },
  {
    id: "late-game-jail",
    order: 6,
    family: "jail",
    eyebrow: "Safety can be tempo",
    title: "Stay behind the bars",
    prompt: "Round 31: nearly every property is developed. You are in jail, own no urgent build window, and hold a get-out card. Leave now or wait?",
    insight: "The champion waits. Rent still arrives in jail, while movement exposes it to three dense development zones with little acquisition upside.",
    state: baseState({
      round: 31,
      phase: "Jail decision",
      players: [
        { id: "champion", name: "Champion", token: "π", cash: 690, position: 10, inJail: true, properties: [6, 8, 9, 21, 23] },
        { id: "builder", name: "Builder", token: "▲", cash: 260, position: 34, properties: [16, 18, 19, 26] },
        { id: "risk", name: "Risk", token: "◆", cash: 540, position: 31, properties: [1, 3, 31, 32, 34] },
        { id: "dealer", name: "Dealer", token: "●", cash: 430, position: 7, properties: [11, 13, 14, 37, 39] },
      ],
    }),
    legalActions: [
      { id: "roll", label: "Roll for doubles", shortLabel: "Wait", description: "Remain protected unless doubles release you.", kind: "jail" },
      { id: "card", label: "Use the get-out card", shortLabel: "Use card", description: "Move immediately while preserving cash.", kind: "jail" },
      { id: "pay", label: "Pay $50", shortLabel: "Pay", description: "Move immediately and retain the card.", kind: "jail" },
    ],
    decisions: {
      builder: decision("builder", { roll: 0.42, card: 0.41, pay: 0.17 }, 0.08),
      risk: decision("risk", { roll: 0.87, card: 0.08, pay: 0.05 }, 0.81),
      dealmaker: decision("dealmaker", { roll: 0.69, card: 0.22, pay: 0.09 }, 0.51),
      balanced: decision("balanced", { roll: 0.84, card: 0.11, pay: 0.05 }, 0.77),
    },
  },
];

export function getScenario(id: string) {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? SCENARIOS[0];
}

export function assertScenarioIntegrity(scenario: ArenaScenario) {
  const actionIds = new Set(scenario.legalActions.map((action) => action.id));
  if (actionIds.size !== scenario.legalActions.length || scenario.legalActions.length < 2) {
    throw new Error(`${scenario.id}: actions must be unique and contain at least two options.`);
  }
  if (!scenario.state.players.some((player) => player.id === scenario.state.activePlayerId)) {
    throw new Error(`${scenario.id}: active player is missing.`);
  }
  for (const [agentId, agentDecision] of Object.entries(scenario.decisions)) {
    const probabilityIds = new Set(Object.keys(agentDecision.probabilities));
    if (probabilityIds.size !== actionIds.size || [...actionIds].some((id) => !probabilityIds.has(id))) {
      throw new Error(`${scenario.id}: ${agentId} probabilities do not match legal actions.`);
    }
    const total = Object.values(agentDecision.probabilities).reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 1) > 0.001) throw new Error(`${scenario.id}: ${agentId} probabilities do not total 1.`);
  }
  return true;
}
