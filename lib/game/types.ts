export type AgentId = "builder" | "risk" | "dealmaker" | "balanced";

export type DecisionFamily =
  | "purchase"
  | "auction"
  | "building"
  | "mortgage"
  | "trade"
  | "jail";

export type SpaceKind =
  | "corner"
  | "property"
  | "transit"
  | "utility"
  | "event"
  | "fee";

export type ColorGroup =
  | "brown"
  | "light-blue"
  | "pink"
  | "orange"
  | "red"
  | "yellow"
  | "green"
  | "navy";

export interface BoardSpace {
  index: number;
  name: string;
  shortName: string;
  kind: SpaceKind;
  group?: ColorGroup;
  price?: number;
}

export interface PlayerState {
  id: string;
  name: string;
  token: string;
  cash: number;
  position: number;
  inJail?: boolean;
  properties: number[];
}

export interface PropertyState {
  ownerId: string;
  houses?: number;
  mortgaged?: boolean;
}

export interface PublicGameState {
  round: number;
  phase: string;
  activePlayerId: string;
  players: PlayerState[];
  propertyState: Record<number, PropertyState>;
  housesRemaining: number;
  hotelsRemaining: number;
  recentEvents: string[];
}

export interface LegalAction {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  kind: string;
}

export interface AgentDecision {
  agentId: AgentId | "champion";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  factors: string[];
  source: "recorded-jev" | "live-jev" | "combined-policy";
  latencyMs?: number;
}

export interface ArenaScenario {
  id: string;
  order: number;
  family: DecisionFamily;
  eyebrow: string;
  title: string;
  prompt: string;
  insight: string;
  state: PublicGameState;
  legalActions: LegalAction[];
  decisions: Record<AgentId, AgentDecision>;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
}

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export interface JevGatewayResponse {
  code: number;
  message: string;
  data: {
    answers: Record<string, JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer>;
  } | null;
}
