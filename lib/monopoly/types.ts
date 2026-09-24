export const GAME_SCHEMA_VERSION = 3;
export const RULES_VERSION = "uw-classic-2026.1";
export const POLICY_VERSION = "experimental-0.2.0";

export type GameMode = "classic" | "short";
export type PlayerKind = "human" | "ai";
export type PolicyId = "human" | "champion" | "builder" | "risk" | "dealmaker" | "balanced";
export type GamePhase =
  | "pre-roll"
  | "purchase"
  | "auction"
  | "building-placement"
  | "debt"
  | "manage"
  | "trade-response"
  | "game-over";

export interface PlayerSpec {
  id: string;
  name: string;
  token: string;
  kind: PlayerKind;
  policy: PolicyId;
}

export interface GamePlayer extends PlayerSpec {
  cash: number;
  position: number;
  properties: number[];
  inJail: boolean;
  jailTurns: number;
  bankrupt: boolean;
  getOutCards: Array<"chance" | "community">;
}

export interface DeedState {
  ownerId: string | null;
  buildings: number;
  mortgaged: boolean;
}

export interface DeckState {
  cards: string[];
}

export interface PendingPurchase {
  playerId: string;
  spaceIndex: number;
}

export interface AuctionState {
  spaceIndex: number;
  activeBidderIds: string[];
  currentBidderId: string;
  highBidderId: string | null;
  highBid: number;
  reason: "declined" | "bankruptcy" | "building-shortage";
  buildingKind?: "house" | "hotel";
}

export interface PendingBuildingPlacement {
  playerId: string;
  buildingKind: "house" | "hotel";
  auctionPrice: number;
}

export interface PendingDebt {
  debtorId: string;
  creditorId: string | "bank";
  amount: number;
  reason: string;
  resumePhase: "manage" | "pre-roll" | "game-over";
}

export interface PendingPayment {
  debtorId: string;
  creditorId: string | "bank";
  amount: number;
  reason: string;
}

export interface TradeAssets {
  cash: number;
  properties: number[];
  getOutCards: Array<"chance" | "community">;
}

export interface TradeOffer {
  id: string;
  fromId: string;
  toId: string;
  offer: TradeAssets;
  request: TradeAssets;
  counterDepth: number;
}

export interface GameEvent {
  sequence: number;
  actorId: string | "bank" | "system";
  type: string;
  payload: Record<string, unknown>;
  rngCursor: number;
  stateHash: string;
  at: number;
}

export interface GameState {
  schemaVersion: typeof GAME_SCHEMA_VERSION;
  rulesVersion: typeof RULES_VERSION;
  policyVersion: string;
  id: string;
  mode: GameMode;
  seed: number;
  rngState: number;
  rngCursor: number;
  round: number;
  phase: GamePhase;
  players: GamePlayer[];
  currentPlayerIndex: number;
  deeds: Record<number, DeedState>;
  bank: { houses: number; hotels: number };
  chance: DeckState;
  community: DeckState;
  doublesInTurn: number;
  extraRoll: boolean;
  lastRoll: [number, number] | null;
  pendingPurchase: PendingPurchase | null;
  auction: AuctionState | null;
  pendingBuildingPlacement: PendingBuildingPlacement | null;
  pendingDebt: PendingDebt | null;
  paymentQueue: PendingPayment[];
  pendingLandingAfterDebt: boolean;
  pendingTrade: TradeOffer | null;
  bankruptcyAuctionQueue: number[];
  bankruptcyResume: { phase: "manage" | "pre-roll"; advanceTurn: boolean } | null;
  postDebtAction: "short-game-over" | "advance-turn" | null;
  winnerId: string | null;
  events: GameEvent[];
  jevCalls: number;
  fallbackDecisions: number;
  telemetryEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type GameAction =
  | { type: "roll" }
  | { type: "pay-jail" }
  | { type: "use-jail-card"; deck: "chance" | "community" }
  | { type: "buy-property" }
  | { type: "decline-property" }
  | { type: "auction-bid"; amount: number }
  | { type: "auction-pass" }
  | { type: "request-building-auction"; buildingKind: "house" | "hotel" }
  | { type: "place-auction-building"; spaceIndex: number }
  | { type: "build"; spaceIndex: number }
  | { type: "sell-building"; spaceIndex: number }
  | { type: "mortgage"; spaceIndex: number }
  | { type: "unmortgage"; spaceIndex: number }
  | { type: "propose-trade"; offer: TradeOffer }
  | { type: "accept-trade" }
  | { type: "reject-trade" }
  | { type: "counter-trade"; offer: TradeOffer }
  | { type: "declare-bankruptcy" }
  | { type: "end-turn" };

export interface LegalPlan {
  id: string;
  label: string;
  description: string;
  actions: GameAction[];
  family: "purchase" | "auction" | "building" | "mortgage" | "trade" | "jail" | "turn" | "debt";
}

export interface DecisionRecord {
  planId: string;
  probabilities: Record<string, number>;
  confidence: number;
  source: "live-jev" | "local-policy";
  latencyMs?: number;
  specialistProbabilities?: Partial<Record<Exclude<PolicyId, "human" | "champion">, Record<string, number>>>;
}
