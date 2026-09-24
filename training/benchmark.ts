import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyAction, createGame, currentPlayer, getPlayer, netWorth } from "../lib/monopoly/engine.ts";
import { generateLegalPlans } from "../lib/monopoly/plans.ts";
import { chooseLocalPlan, DEFAULT_POLICY_ARTIFACT, type PolicyArtifact } from "../lib/monopoly/policy-model.ts";
import { nextRandom, normalizeSeed } from "../lib/monopoly/rng.ts";
import { POLICY_VERSION, RULES_VERSION, type GameMode, type GameState, type LegalPlan, type PlayerSpec, type PolicyId } from "../lib/monopoly/types.ts";

type CandidatePolicy = "champion" | "builder" | "risk" | "dealmaker" | "balanced";
type Role = "candidate" | "random-legal" | "greedy-development" | "liquidity-conservative";

interface MatchResult {
  completed: boolean;
  winnerRole?: Role;
  candidateSeat: number;
  actionCount: number;
  illegalActions: number;
  finish: Role[];
  failure?: string;
}

interface CandidateResult {
  policy: CandidatePolicy;
  games: number;
  completed: number;
  wins: number;
  winRate: number;
  confidence95: [number, number];
  finishDistribution: Record<string, number>;
  seatWinRates: number[];
  seatSpread: number;
  averageActions: number;
  illegalActions: number;
  pairwiseElo: Record<string, number>;
  failures: string[];
}

export interface BenchmarkArtifact {
  generatedAt: string;
  status: "experimental" | "promoted";
  rulesVersion: string;
  policyVersion: string;
  mode: GameMode;
  requestedGamesPerCandidate: number;
  totalMatches: number;
  seedStart: number;
  competitors: string[];
  champion: CandidateResult;
  specialists: CandidateResult[];
  promotionGate: {
    required: { zeroIllegalActions: boolean; minimumWinRate: number; specialistMargin: number; maximumSeatSpread: number; validationMatches: number };
    observed: { strongestSpecialistWinRate: number; winRateMargin: number };
    checks: Record<string, boolean>;
    passed: boolean;
  };
  manifest: { artifact: string; router: string; externalLabelsUsed: number; note: string };
}

const baselineRoles: Role[] = ["random-legal", "greedy-development", "liquidity-conservative"];

function parseArg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function players(candidateSeat: number, candidatePolicy: CandidatePolicy) {
  const roles: Role[] = ["candidate", ...baselineRoles];
  const rotated = roles.map((_, index) => roles[(index - candidateSeat + roles.length) % roles.length]);
  const specs: PlayerSpec[] = rotated.map((role, seat) => ({
    id: `seat-${seat}`,
    name: role,
    token: ["π", "●", "▲", "◆"][seat],
    kind: "ai",
    policy: role === "candidate" ? candidatePolicy : role === "greedy-development" ? "builder" : role === "liquidity-conservative" ? "risk" : "balanced",
  }));
  return { roles: Object.fromEntries(specs.map((spec, index) => [spec.id, rotated[index]])) as Record<string, Role>, specs };
}

function actorId(state: GameState) {
  if (state.phase === "auction") return state.auction!.currentBidderId;
  if (state.phase === "trade-response") return state.pendingTrade!.toId;
  if (state.phase === "debt") return state.pendingDebt!.debtorId;
  return currentPlayer(state).id;
}

function chooseBaseline(state: GameState, id: string, plans: LegalPlan[], role: Role, artifact: PolicyArtifact, randomValue: number) {
  if (role === "random-legal") return plans[Math.min(plans.length - 1, Math.floor(randomValue * plans.length))];
  const policy: Exclude<PolicyId, "human"> = role === "candidate"
    ? getPlayer(state, id).policy as Exclude<PolicyId, "human">
    : role === "greedy-development" ? "builder" : "risk";
  const decision = chooseLocalPlan(state, id, plans, policy, artifact);
  return plans.find((plan) => plan.id === decision.planId) ?? plans[0];
}

export function runMatch(seed: number, mode: GameMode, candidatePolicy: CandidatePolicy, candidateSeat: number, artifact = DEFAULT_POLICY_ARTIFACT, maxActions = 20_000): MatchResult {
  const roster = players(candidateSeat, candidatePolicy);
  let state = createGame({ seed, mode, players: roster.specs, telemetryEnabled: false, createdAt: 0 });
  let selectionRng = normalizeSeed(seed ^ 0x51f15e);
  let illegalActions = 0;
  let actionCount = 0;
  try {
    for (let count = 0; count < maxActions && state.phase !== "game-over"; count += 1) {
      const id = actorId(state);
      const plans = generateLegalPlans(state, id);
      if (!plans.length) throw new Error(`No legal plan for ${id} during ${state.phase}.`);
      const next = nextRandom(selectionRng); selectionRng = next.state;
      const selected = chooseBaseline(state, id, plans, roster.roles[id], artifact, next.value);
      for (const action of selected.actions) {
        try {
          state = applyAction(state, id, action);
          actionCount += 1;
          if (state.events.length > 64) state.events = state.events.slice(-64);
        }
        catch (error) { illegalActions += 1; throw error; }
      }
    }
  } catch (error) {
    return { completed: false, candidateSeat, actionCount, illegalActions, finish: [], failure: error instanceof Error ? error.message : String(error) };
  }
  const finish = [...state.players]
    .sort((a, b) => Number(a.bankrupt) - Number(b.bankrupt) || netWorth(state, b.id) - netWorth(state, a.id))
    .map((player) => roster.roles[player.id]);
  return { completed: state.phase === "game-over", winnerRole: state.winnerId ? roster.roles[state.winnerId] : undefined, candidateSeat, actionCount, illegalActions, finish, failure: state.phase === "game-over" ? undefined : `Reached ${maxActions} action cap.` };
}

function wilson(wins: number, games: number): [number, number] {
  if (!games) return [0, 0];
  const z = 1.96; const p = wins / games; const denominator = 1 + z * z / games;
  const center = (p + z * z / (2 * games)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * games)) / games) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function eloFromRate(rate: number) {
  const bounded = Math.max(.01, Math.min(.99, rate));
  return Math.round(400 * Math.log10(bounded / (1 - bounded)));
}

function summarize(policy: CandidatePolicy, results: MatchResult[]): CandidateResult {
  const completed = results.filter((result) => result.completed);
  const wins = completed.filter((result) => result.winnerRole === "candidate").length;
  const seatWinRates = [0, 1, 2, 3].map((seat) => {
    const games = completed.filter((result) => result.candidateSeat === seat);
    return games.length ? games.filter((result) => result.winnerRole === "candidate").length / games.length : 0;
  });
  const finishes = Object.fromEntries([1, 2, 3, 4].map((place) => [String(place), completed.filter((result) => result.finish.indexOf("candidate") === place - 1).length]));
  const pairwiseElo = Object.fromEntries(baselineRoles.map((role) => {
    const comparisons = completed.map((result) => result.finish.indexOf("candidate") < result.finish.indexOf(role));
    const rate = comparisons.length ? comparisons.filter(Boolean).length / comparisons.length : .5;
    return [role, eloFromRate(rate)];
  }));
  return {
    policy, games: results.length, completed: completed.length, wins,
    winRate: completed.length ? wins / completed.length : 0,
    confidence95: wilson(wins, completed.length), finishDistribution: finishes,
    seatWinRates, seatSpread: Math.max(...seatWinRates) - Math.min(...seatWinRates),
    averageActions: completed.length ? completed.reduce((sum, result) => sum + result.actionCount, 0) / completed.length : 0,
    illegalActions: results.reduce((sum, result) => sum + result.illegalActions, 0),
    pairwiseElo,
    failures: [...new Set(results.flatMap((result) => result.failure ? [result.failure] : []))].slice(0, 8),
  };
}

export function runBenchmark(options: { gamesPerCandidate: number; seedStart: number; mode: GameMode; output?: string; maxActions?: number }) {
  const candidates: CandidatePolicy[] = ["champion", "builder", "risk", "dealmaker", "balanced"];
  const summaries = candidates.map((policy) => {
    const results: MatchResult[] = [];
    for (let game = 0; game < options.gamesPerCandidate; game += 1) {
      const seat = game % 4;
      results.push(runMatch(options.seedStart + game, options.mode, policy, seat, DEFAULT_POLICY_ARTIFACT, options.maxActions ?? 6_000));
    }
    console.error(`benchmarked ${policy}: ${results.length} matches`);
    return summarize(policy, results);
  });
  const champion = summaries[0]; const specialists = summaries.slice(1);
  const strongestSpecialistWinRate = Math.max(...specialists.map((result) => result.winRate));
  const checks = {
    validationVolume: options.gamesPerCandidate >= 10_000,
    zeroIllegalActions: champion.illegalActions === 0,
    minimumWinRate: champion.winRate > .35,
    specialistMargin: champion.winRate - strongestSpecialistWinRate >= .05,
    seatBalance: champion.seatSpread <= .03,
    completeMatches: champion.completed === champion.games,
  };
  const passed = Object.values(checks).every(Boolean);
  const artifact: BenchmarkArtifact = {
    generatedAt: new Date().toISOString(), status: passed ? "promoted" : "experimental",
    rulesVersion: RULES_VERSION, policyVersion: POLICY_VERSION, mode: options.mode,
    requestedGamesPerCandidate: options.gamesPerCandidate, totalMatches: options.gamesPerCandidate * summaries.length,
    seedStart: options.seedStart, competitors: ["candidate", ...baselineRoles], champion, specialists,
    promotionGate: {
      required: { zeroIllegalActions: true, minimumWinRate: .35, specialistMargin: .05, maximumSeatSpread: .03, validationMatches: 10_000 },
      observed: { strongestSpecialistWinRate, winRateMargin: champion.winRate - strongestSpecialistWinRate }, checks, passed,
    },
    manifest: {
      artifact: DEFAULT_POLICY_ARTIFACT.version,
      router: "contextual geometric mixture of four specialist softmax policies",
      externalLabelsUsed: 0,
      note: "Pre-release local benchmark. The 1,000-state JEV label collection and 10,000-match promotion tournament have not completed.",
    },
  };
  if (options.output) { const path = resolve(options.output); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`); }
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const artifact = runBenchmark({
    gamesPerCandidate: Math.max(1, Number.parseInt(parseArg("games", "40"), 10)),
    seedStart: Number.parseInt(parseArg("seed", "240901"), 10),
    mode: parseArg("mode", "short") === "classic" ? "classic" : "short",
    output: parseArg("output", "lib/monopoly/artifacts/benchmark.json"),
    maxActions: Math.max(100, Number.parseInt(parseArg("max-actions", "6000"), 10)),
  });
  console.log(JSON.stringify({ status: artifact.status, totalMatches: artifact.totalMatches, champion: artifact.champion, gate: artifact.promotionGate }, null, 2));
}
