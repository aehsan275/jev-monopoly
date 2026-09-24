import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { applyAction, createGame, currentPlayer, getPlayer } from "../lib/monopoly/engine.ts";
import { generateLegalPlans } from "../lib/monopoly/plans.ts";
import { buildPublicDecisionState } from "../lib/monopoly/public-state.ts";
import { chooseLocalPlan, DEFAULT_POLICY_ARTIFACT, extractFeatures, type FeatureName, type PolicyArtifact } from "../lib/monopoly/policy-model.ts";
import { nextRandom, normalizeSeed } from "../lib/monopoly/rng.ts";
import { simulationPlayers } from "../lib/monopoly/simulator.ts";
import type { GameState, LegalPlan, PolicyId } from "../lib/monopoly/types.ts";

type Specialist = Exclude<PolicyId, "human" | "champion">;
const specialists: Specialist[] = ["builder", "risk", "dealmaker", "balanced"];
const families: LegalPlan["family"][] = ["purchase", "auction", "building", "mortgage", "trade", "jail", "turn", "debt"];
const featureNames: FeatureName[] = ["bias", "cash", "netWorth", "propertyCount", "monopolies", "buildings", "mortgaged", "rentPower", "liquidityRisk", "opponentDenial", "tradeLeverage", "endTurn", "jailSafety"];

interface CollectedState { seed: number; split: "train" | "validation" | "test"; family: LegalPlan["family"]; actorId: string; entropy: number; novelty: string; state: GameState; plans: LegalPlan[]; }
interface LabelledState extends CollectedState { answers: Record<Specialist, Record<string, number>>; labelledAt: string; }

function arg(name: string, fallback: string) { const prefix = `--${name}=`; return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback; }
function split(seed: number): CollectedState["split"] { const bucket = Math.abs(Math.imul(seed ^ 0x9e3779b9, 2654435761)) % 100; return bucket < 70 ? "train" : bucket < 85 ? "validation" : "test"; }
function decisionActor(state: GameState) { return state.phase === "auction" ? state.auction!.currentBidderId : state.phase === "trade-response" ? state.pendingTrade!.toId : state.phase === "debt" ? state.pendingDebt!.debtorId : currentPlayer(state).id; }
function entropy(probabilities: Record<string, number>) { return -Object.values(probabilities).reduce((sum, value) => sum + (value > 0 ? value * Math.log(value) : 0), 0); }
function sample(probabilities: Record<string, number>, random: number) { let cursor = 0; for (const [id, probability] of Object.entries(probabilities)) { cursor += probability; if (random <= cursor) return id; } return Object.keys(probabilities).at(-1)!; }

function collect(target: number, seedStart: number) {
  const perFamily = target >= 960 ? 120 : Math.max(1, Math.floor(target / families.length));
  const buckets = Object.fromEntries(families.map((family) => [family, [] as CollectedState[]])) as Record<LegalPlan["family"], CollectedState[]>;
  const novelty = new Set<string>();
  for (let gameIndex = 0; gameIndex < 5_000 && Object.values(buckets).reduce((sum, values) => sum + values.length, 0) < target; gameIndex += 1) {
    const seed = seedStart + gameIndex;
    let state = createGame({ seed, mode: gameIndex % 4 === 0 ? "classic" : "short", players: simulationPlayers(["champion", "builder", "risk", "dealmaker"]), telemetryEnabled: false, createdAt: 0 });
    let policyRng = normalizeSeed(seed ^ 0xc001d00d);
    for (let actionIndex = 0; actionIndex < 6_000 && state.phase !== "game-over"; actionIndex += 1) {
      const actorId = decisionActor(state); const actor = getPlayer(state, actorId); const plans = generateLegalPlans(state, actorId);
      if (!plans.length) break;
      const decision = chooseLocalPlan(state, actorId, plans, actor.policy);
      const family = plans[0].family;
      const signature = `${family}:${Math.min(4, Math.floor(state.round / 8))}:${Math.min(5, Math.floor(actor.cash / 300))}:${plans.length}:${actor.properties.length}:${state.bank.houses < 8}`;
      const underQuota = buckets[family].length < perFamily;
      if ((underQuota || !novelty.has(signature)) && buckets[family].length < Math.ceil(target / families.length) + 15) {
        const compact = structuredClone(state); compact.events = compact.events.slice(-12);
        buckets[family].push({ seed, split: split(seed), family, actorId, entropy: entropy(decision.probabilities), novelty: signature, state: compact, plans });
        novelty.add(signature);
      }
      const random = nextRandom(policyRng); policyRng = random.state;
      const selectedId = sample(decision.probabilities, random.value);
      const selected = plans.find((plan) => plan.id === selectedId) ?? plans[0];
      try { for (const action of selected.actions) state = applyAction(state, actorId, action); }
      catch { break; }
      if (state.events.length > 48) state.events = state.events.slice(-48);
    }
  }
  const selected: CollectedState[] = [];
  for (const family of families) selected.push(...buckets[family].sort((a, b) => b.entropy - a.entropy).slice(0, perFamily));
  const remainder = Object.values(buckets).flat().filter((candidate) => !selected.includes(candidate)).sort((a, b) => b.entropy - a.entropy);
  selected.push(...remainder.slice(0, Math.max(0, target - selected.length)));
  return selected.slice(0, target);
}

function normalize(answer: unknown, planIds: string[]) {
  const value = answer as { type?: string; probabilities?: Record<string, number> };
  if (value?.type !== "choice" || !value.probabilities) throw new Error("JEV returned a malformed choice answer.");
  const raw = Object.fromEntries(planIds.map((id) => [id, Number(value.probabilities?.[id] ?? 0)]));
  if (Object.values(raw).some((number) => !Number.isFinite(number) || number < 0)) throw new Error("JEV returned an invalid probability.");
  const total = Object.values(raw).reduce((sum, number) => sum + number, 0); if (total <= 0) throw new Error("JEV returned an empty distribution.");
  return Object.fromEntries(Object.entries(raw).map(([id, number]) => [id, number / total]));
}

async function labelOne(key: string, sampleState: CollectedState) {
  const criteria = Object.fromEntries(sampleState.plans.map((plan) => [plan.id, `${plan.label}. ${plan.description}`]));
  const questions = Object.fromEntries(specialists.map((specialist) => [
    `${specialist}_plan`,
    { type: "choice", instructions: `Act as the ${specialist} specialist. Choose only a listed plan to maximize eventual win probability while obeying the rules.`, criteria },
  ]));
  const response = await fetch("https://www.jevai.org/api/v1/decisions", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "typesafe-ai/jev", state: buildPublicDecisionState(sampleState.state, sampleState.actorId, sampleState.plans), questions }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 429) throw new Error("RATE_LIMIT");
  if (!response.ok) throw new Error(`JEV HTTP ${response.status}`);
  const result = await response.json() as { code?: number; data?: { answers?: Record<string, unknown> } };
  if (result.code !== 0 || !result.data?.answers) throw new Error("JEV omitted answers.");
  const ids = sampleState.plans.map((plan) => plan.id);
  return Object.fromEntries(specialists.map((specialist) => [specialist, normalize(result.data!.answers![`${specialist}_plan`], ids)])) as LabelledState["answers"];
}

function train(labels: LabelledState[]) {
  const artifact = structuredClone(DEFAULT_POLICY_ARTIFACT) as PolicyArtifact;
  artifact.version = `candidate-${new Date().toISOString().slice(0, 10)}`;
  for (const specialist of specialists) {
    const examples = labels.filter((label) => label.split === "train");
    if (!examples.length) continue;
    for (let epoch = 0; epoch < 180; epoch += 1) {
      const gradient = Object.fromEntries(featureNames.map((name) => [name, 0])) as Record<FeatureName, number>;
      for (const example of examples) {
        const featureRows = Object.fromEntries(example.plans.map((plan) => [plan.id, extractFeatures(example.state, example.actorId, plan)]));
        const scores = Object.fromEntries(example.plans.map((plan) => [plan.id, featureNames.reduce((sum, name) => sum + featureRows[plan.id][name] * artifact.expertWeights[specialist][name], 0)]));
        const maximum = Math.max(...Object.values(scores)); const exponentials = Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, Math.exp(score - maximum)])); const total = Object.values(exponentials).reduce((sum, value) => sum + value, 0);
        for (const plan of example.plans) for (const name of featureNames) gradient[name] += ((exponentials[plan.id] / total) - (example.answers[specialist][plan.id] ?? 0)) * featureRows[plan.id][name];
      }
      const rate = .08 / Math.sqrt(epoch + 1);
      for (const name of featureNames) artifact.expertWeights[specialist][name] -= rate * gradient[name] / examples.length;
    }
  }
  return artifact;
}

async function main() {
  const requestedCalls = Math.max(1, Math.min(1_000, Number.parseInt(arg("calls", "1000"), 10)));
  const checkpointPath = resolve(arg("checkpoint", "training/checkpoints/jev-labels.json"));
  const artifactPath = resolve(arg("artifact", "lib/monopoly/artifacts/policy-candidate.json"));
  const keyFile = resolve(arg("key-file", "../jev api.txt"));
  const key = process.env.JEV_API_KEY?.trim() || (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "");
  if (!key) throw new Error("Set JEV_API_KEY or provide --key-file without committing the credential.");
  const existing = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, "utf8")) as LabelledState[] : [];
  const states = collect(requestedCalls, Number.parseInt(arg("seed", "730001"), 10));
  const labelled = [...existing];
  mkdirSync(dirname(checkpointPath), { recursive: true });
  for (const state of states) {
    if (labelled.length >= requestedCalls || labelled.some((item) => item.seed === state.seed && item.novelty === state.novelty)) continue;
    let attempt = 0;
    while (true) {
      try {
        const answers = await labelOne(key, state); labelled.push({ ...state, answers, labelledAt: new Date().toISOString() });
        writeFileSync(checkpointPath, `${JSON.stringify(labelled, null, 2)}\n`); console.error(`checkpoint ${labelled.length}/${requestedCalls} · ${state.family}`); break;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "RATE_LIMIT" || attempt >= 4) throw error;
        attempt += 1; await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(30_000, 2_000 * 2 ** attempt)));
      }
    }
  }
  const artifact = train(labelled); mkdirSync(dirname(artifactPath), { recursive: true }); writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const counts = Object.fromEntries(families.map((family) => [family, labelled.filter((item) => item.family === family).length]));
  console.log(JSON.stringify({ labelled: labelled.length, cap: 1_000, counts, splits: { train: labelled.filter((item) => item.split === "train").length, validation: labelled.filter((item) => item.split === "validation").length, test: labelled.filter((item) => item.split === "test").length }, candidateArtifact: artifact.version }, null, 2));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
