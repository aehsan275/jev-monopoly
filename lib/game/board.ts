import type { BoardSpace } from "./types.ts";

export const BOARD: BoardSpace[] = [
  { index: 0, name: "Start of Term", shortName: "START", kind: "corner" },
  { index: 1, name: "Columbia Icefield", shortName: "CIF", kind: "property", group: "brown", price: 60 },
  { index: 2, name: "Co-op Opportunity", shortName: "CO-OP", kind: "event" },
  { index: 3, name: "Physical Activities Complex", shortName: "PAC", kind: "property", group: "brown", price: 60 },
  { index: 4, name: "Tuition Due", shortName: "TUITION", kind: "fee" },
  { index: 5, name: "University of Waterloo ION", shortName: "ION", kind: "transit", price: 200 },
  { index: 6, name: "Ron Eydt Village", shortName: "REV", kind: "property", group: "light-blue", price: 100 },
  { index: 7, name: "Goose Encounter", shortName: "GOOSE", kind: "event" },
  { index: 8, name: "Student Village 1", shortName: "V1", kind: "property", group: "light-blue", price: 100 },
  { index: 9, name: "Mackenzie King Village", shortName: "MKV", kind: "property", group: "light-blue", price: 120 },
  { index: 10, name: "Goose Jail / Visiting", shortName: "JAIL", kind: "corner" },
  { index: 11, name: "Arts Lecture Hall", shortName: "AL", kind: "property", group: "pink", price: 140 },
  { index: 12, name: "Central Plant", shortName: "PLANT", kind: "utility", price: 150 },
  { index: 13, name: "Modern Languages", shortName: "ML", kind: "property", group: "pink", price: 140 },
  { index: 14, name: "Hagey Hall", shortName: "HH", kind: "property", group: "pink", price: 160 },
  { index: 15, name: "Davis Centre Bus Stops", shortName: "DC BUS", kind: "transit", price: 200 },
  { index: 16, name: "B.C. Matthews Hall", shortName: "BMH", kind: "property", group: "orange", price: 180 },
  { index: 17, name: "Co-op Opportunity", shortName: "CO-OP", kind: "event" },
  { index: 18, name: "Lyle Hallman Institute", shortName: "LHI", kind: "property", group: "orange", price: 180 },
  { index: 19, name: "Health Expansion", shortName: "EXP", kind: "property", group: "orange", price: 200 },
  { index: 20, name: "Lot C", shortName: "LOT C", kind: "corner" },
  { index: 21, name: "Environment 1", shortName: "EV1", kind: "property", group: "red", price: 220 },
  { index: 22, name: "Goose Encounter", shortName: "GOOSE", kind: "event" },
  { index: 23, name: "Environment 2", shortName: "EV2", kind: "property", group: "red", price: 220 },
  { index: 24, name: "Environment 3", shortName: "EV3", kind: "property", group: "red", price: 240 },
  { index: 25, name: "Ring Road", shortName: "RING RD", kind: "transit", price: 200 },
  { index: 26, name: "Engineering 5", shortName: "E5", kind: "property", group: "yellow", price: 260 },
  { index: 27, name: "Engineering 6", shortName: "E6", kind: "property", group: "yellow", price: 260 },
  { index: 28, name: "Campus Wi-Fi", shortName: "EDUROAM", kind: "utility", price: 150 },
  { index: 29, name: "Engineering 7", shortName: "E7", kind: "property", group: "yellow", price: 280 },
  { index: 30, name: "Sent to Goose Jail", shortName: "GO TO JAIL", kind: "corner" },
  { index: 31, name: "Mathematics 3", shortName: "M3", kind: "property", group: "green", price: 300 },
  { index: 32, name: "Mathematics & Computer", shortName: "MC", kind: "property", group: "green", price: 300 },
  { index: 33, name: "Co-op Opportunity", shortName: "CO-OP", kind: "event" },
  { index: 34, name: "Davis Centre", shortName: "DC", kind: "property", group: "green", price: 320 },
  { index: 35, name: "FedBus Stop", shortName: "FEDBUS", kind: "transit", price: 200 },
  { index: 36, name: "Goose Encounter", shortName: "GOOSE", kind: "event" },
  { index: 37, name: "Quantum-Nano Centre", shortName: "QNC", kind: "property", group: "navy", price: 350 },
  { index: 38, name: "Textbook Bill", shortName: "BOOKS", kind: "fee" },
  { index: 39, name: "Dana Porter Library", shortName: "DP", kind: "property", group: "navy", price: 400 },
];

export const GROUP_COLORS: Record<string, string> = {
  brown: "#8b5a3c",
  "light-blue": "#7cc7e8",
  pink: "#d96aa7",
  orange: "#f07c32",
  red: "#d63a3a",
  yellow: "#f1c936",
  green: "#3b9b62",
  navy: "#3154a4",
};

export function gridPosition(index: number) {
  if (index <= 10) return { row: 11, column: 11 - index };
  if (index < 20) return { row: 21 - index, column: 1 };
  if (index === 20) return { row: 1, column: 1 };
  if (index < 30) return { row: 1, column: index - 19 };
  if (index === 30) return { row: 1, column: 11 };
  return { row: index - 29, column: 11 };
}

export function assertBoardIntegrity(board = BOARD) {
  if (board.length !== 40) throw new Error("Board must contain exactly 40 spaces.");
  const indexes = new Set(board.map((space) => space.index));
  if (indexes.size !== 40 || !board.every((space, index) => space.index === index)) {
    throw new Error("Board indexes must be unique and contiguous from 0 to 39.");
  }
  const propertyCount = board.filter((space) => space.kind === "property").length;
  if (propertyCount !== 22) throw new Error("Board must contain exactly 22 colored properties.");
  return true;
}
