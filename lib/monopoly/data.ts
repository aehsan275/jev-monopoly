import { BOARD } from "../game/board.ts";
import type { ColorGroup } from "../game/types.ts";

export interface TitleDeed {
  index: number;
  name: string;
  kind: "property" | "transit" | "utility";
  price: number;
  mortgage: number;
  group?: ColorGroup;
  rent?: [number, number, number, number, number, number];
  houseCost?: number;
}

const property = (
  index: number,
  mortgage: number,
  rent: TitleDeed["rent"],
  houseCost: number,
): TitleDeed => {
  const space = BOARD[index];
  return { index, name: space.name, kind: "property", price: space.price!, mortgage, group: space.group, rent, houseCost };
};

const deeds: TitleDeed[] = [
  property(1, 30, [2, 10, 30, 90, 160, 250], 50),
  property(3, 30, [4, 20, 60, 180, 320, 450], 50),
  { index: 5, name: BOARD[5].name, kind: "transit", price: 200, mortgage: 100 },
  property(6, 50, [6, 30, 90, 270, 400, 550], 50),
  property(8, 50, [6, 30, 90, 270, 400, 550], 50),
  property(9, 60, [8, 40, 100, 300, 450, 600], 50),
  property(11, 70, [10, 50, 150, 450, 625, 750], 100),
  { index: 12, name: BOARD[12].name, kind: "utility", price: 150, mortgage: 75 },
  property(13, 70, [10, 50, 150, 450, 625, 750], 100),
  property(14, 80, [12, 60, 180, 500, 700, 900], 100),
  { index: 15, name: BOARD[15].name, kind: "transit", price: 200, mortgage: 100 },
  property(16, 90, [14, 70, 200, 550, 750, 950], 100),
  property(18, 90, [14, 70, 200, 550, 750, 950], 100),
  property(19, 100, [16, 80, 220, 600, 800, 1000], 100),
  property(21, 110, [18, 90, 250, 700, 875, 1050], 150),
  property(23, 110, [18, 90, 250, 700, 875, 1050], 150),
  property(24, 120, [20, 100, 300, 750, 925, 1100], 150),
  { index: 25, name: BOARD[25].name, kind: "transit", price: 200, mortgage: 100 },
  property(26, 130, [22, 110, 330, 800, 975, 1150], 150),
  property(27, 130, [22, 110, 330, 800, 975, 1150], 150),
  { index: 28, name: BOARD[28].name, kind: "utility", price: 150, mortgage: 75 },
  property(29, 140, [24, 120, 360, 850, 1025, 1200], 150),
  property(31, 150, [26, 130, 390, 900, 1100, 1275], 200),
  property(32, 150, [26, 130, 390, 900, 1100, 1275], 200),
  property(34, 160, [28, 150, 450, 1000, 1200, 1400], 200),
  { index: 35, name: BOARD[35].name, kind: "transit", price: 200, mortgage: 100 },
  property(37, 175, [35, 175, 500, 1100, 1300, 1500], 200),
  property(39, 200, [50, 200, 600, 1400, 1700, 2000], 200),
];

export const TITLE_DEEDS: Record<number, TitleDeed> = Object.fromEntries(
  deeds.map((deed) => [deed.index, deed]),
);

export const DEED_INDEXES = Object.keys(TITLE_DEEDS).map(Number);

export const GROUPS: Record<ColorGroup, number[]> = {
  brown: [1, 3],
  "light-blue": [6, 8, 9],
  pink: [11, 13, 14],
  orange: [16, 18, 19],
  red: [21, 23, 24],
  yellow: [26, 27, 29],
  green: [31, 32, 34],
  navy: [37, 39],
};

export const TRANSIT_INDEXES = [5, 15, 25, 35];
export const UTILITY_INDEXES = [12, 28];

export const CHANCE_CARD_IDS = [
  "advance-dp", "advance-start", "advance-ev3", "advance-al", "nearest-transit-a", "nearest-transit-b",
  "nearest-utility", "coop-dividend", "jail-free", "back-three", "go-jail", "general-repairs",
  "parking-fine", "trip-ion", "club-chair", "research-grant",
] as const;

export const COMMUNITY_CARD_IDS = [
  "advance-start", "bank-error", "health-fee", "stock-sale", "jail-free", "go-jail", "coop-bonus",
  "tax-refund", "birthday", "insurance", "hospital", "school-fee", "consulting", "street-repairs",
  "design-prize", "inheritance",
] as const;

export const CARD_LABELS: Record<string, string> = {
  "advance-dp": "All-nighter at Dana Porter — advance to DP.",
  "advance-start": "New term begins — advance to Start.",
  "advance-ev3": "Field study — advance to EV3.",
  "advance-al": "Guest lecture — advance to AL.",
  "nearest-transit-a": "Catch the next campus transit; pay double fare if owned.",
  "nearest-transit-b": "Catch the next campus transit; pay double fare if owned.",
  "nearest-utility": "Connect to the nearest utility; pay ten times the dice if owned.",
  "coop-dividend": "Co-op dividend pays $50.",
  "jail-free": "Goose Amnesty — keep this card until needed or traded.",
  "back-three": "Construction detour — move back three spaces.",
  "go-jail": "Geese escort you directly to Goose Jail.",
  "general-repairs": "Lab inspection: pay $25 per house and $100 per hotel.",
  "parking-fine": "Parking citation: pay $15.",
  "trip-ion": "Take the ION — advance to the Waterloo ION stop.",
  "club-chair": "Elected club chair: pay every player $50.",
  "research-grant": "Research grant matures: collect $150.",
  "bank-error": "WatCard accounting error in your favour: collect $200.",
  "health-fee": "Campus health fee: pay $50.",
  "stock-sale": "Sell old textbooks: collect $50.",
  "coop-bonus": "Co-op performance bonus: collect $100.",
  "tax-refund": "Tuition tax refund: collect $20.",
  "birthday": "Birthday bubble tea: collect $10 from every player.",
  "insurance": "Student insurance matures: collect $100.",
  "hospital": "Clinic bill: pay $100.",
  "school-fee": "Course materials fee: pay $50.",
  "consulting": "Consulting side project: collect $25.",
  "street-repairs": "Residence repairs: pay $40 per house and $115 per hotel.",
  "design-prize": "Design showcase prize: collect $10.",
  "inheritance": "Alumni gift: collect $100.",
};

export function deedFor(index: number) {
  return TITLE_DEEDS[index];
}

export function groupFor(index: number) {
  const deed = deedFor(index);
  return deed?.group ? GROUPS[deed.group] : [];
}
