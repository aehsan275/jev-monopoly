import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_POLICY_ARTIFACT, type FeatureName, type PolicyArtifact, type RouterFeatureName } from "../lib/monopoly/policy-model.ts";
import { normalizeSeed, nextRandom } from "../lib/monopoly/rng.ts";
import { runMatch } from "./benchmark.ts";

const specialists = ["builder", "risk", "dealmaker", "balanced"] as const;
const expertFeatures: FeatureName[] = ["bias", "cash", "netWorth", "propertyCount", "monopolies", "buildings", "mortgaged", "rentPower", "liquidityRisk", "opponentDenial", "tradeLeverage", "endTurn", "jailSafety"];
const routerFeatures: RouterFeatureName[] = ["gameStage", "liquidityPressure", "monopolyPressure", "relativeNetWorth", "buildingScarcity"];

function arg(name: string, fallback: string) { const prefix = `--${name}=`; return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback; }
function gaussian(state: number) { const one = nextRandom(state); const two = nextRandom(one.state); return { state: two.state, value: Math.sqrt(-2 * Math.log(Math.max(one.value, 1e-8))) * Math.cos(2 * Math.PI * two.value) }; }

function parameters(artifact: PolicyArtifact) {
  const refs: Array<{ get: () => number; set: (value: number) => void }> = [];
  for (const specialist of specialists) for (const name of expertFeatures) refs.push({ get: () => artifact.expertWeights[specialist][name], set: (value) => { artifact.expertWeights[specialist][name] = value; } });
  artifact.routerContextWeights ??= structuredClone(DEFAULT_POLICY_ARTIFACT.routerContextWeights!);
  for (const specialist of specialists) for (const name of routerFeatures) refs.push({ get: () => artifact.routerContextWeights![specialist][name], set: (value) => { artifact.routerContextWeights![specialist][name] = value; } });
  return refs;
}

function perturbed(base: PolicyArtifact, noise: number[], scale: number) {
  const result = structuredClone(base); const refs = parameters(result);
  refs.forEach((ref, index) => ref.set(Math.max(-6, Math.min(6, ref.get() + scale * noise[index]))));
  return result;
}

function score(artifact: PolicyArtifact, seeds: number[]) {
  const seatScores = [0, 0, 0, 0]; const seatCounts = [0, 0, 0, 0]; let total = 0;
  for (let index = 0; index < seeds.length; index += 1) {
    const seat = index % 4; const result = runMatch(seeds[index], index % 5 === 0 ? "classic" : "short", "champion", seat, artifact, 10_000);
    const placement = result.finish.indexOf("candidate") + 1;
    const value = !result.completed ? -2 : placement === 1 ? 1 : placement === 2 ? .45 : placement === 3 ? .15 : 0;
    const adjusted = value - result.illegalActions * 10; total += adjusted; seatScores[seat] += adjusted; seatCounts[seat] += 1;
  }
  const rates = seatScores.map((value, seat) => value / Math.max(1, seatCounts[seat]));
  return total / seeds.length - (Math.max(...rates) - Math.min(...rates)) * .2;
}

function main() {
  const input = resolve(arg("input", "lib/monopoly/artifacts/policy-candidate.json"));
  const output = resolve(arg("output", "lib/monopoly/artifacts/policy-refined.json"));
  const matchBudget = Math.max(80, Number.parseInt(arg("matches", "50000"), 10));
  const pairs = Math.max(2, Number.parseInt(arg("pairs", "4"), 10));
  const gamesPerCandidate = Math.max(4, Number.parseInt(arg("games-per-candidate", "16"), 10));
  const matchesPerGeneration = pairs * 2 * gamesPerCandidate;
  const generations = Math.max(1, Math.floor(matchBudget / matchesPerGeneration));
  const artifact = existsSync(input) ? JSON.parse(readFileSync(input, "utf8")) as PolicyArtifact : structuredClone(DEFAULT_POLICY_ARTIFACT);
  artifact.artifactSchemaVersion = 2; artifact.version = `refined-${new Date().toISOString().slice(0, 10)}`;
  let rng = normalizeSeed(Number.parseInt(arg("seed", "880001"), 10)); const sigma = .16; const learningRate = .055;
  mkdirSync(dirname(output), { recursive: true });
  for (let generation = 0; generation < generations; generation += 1) {
    const refs = parameters(artifact); const gradient = Array(refs.length).fill(0) as number[];
    const seeds = Array.from({ length: gamesPerCandidate }, (_, index) => 910000 + generation * gamesPerCandidate + index);
    for (let pair = 0; pair < pairs; pair += 1) {
      const noise = refs.map(() => { const sample = gaussian(rng); rng = sample.state; return sample.value; });
      const plus = score(perturbed(artifact, noise, sigma), seeds); const minus = score(perturbed(artifact, noise, -sigma), seeds);
      noise.forEach((value, index) => { gradient[index] += (plus - minus) * value; });
    }
    refs.forEach((ref, index) => ref.set(Math.max(-6, Math.min(6, ref.get() + learningRate * gradient[index] / (pairs * 2 * sigma)))));
    writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
    console.error(`refinement ${generation + 1}/${generations} · ${Math.min(matchBudget, (generation + 1) * matchesPerGeneration)} matches`);
  }
  console.log(JSON.stringify({ artifact: artifact.version, matchBudget, generations, output }, null, 2));
}

main();
