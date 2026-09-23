"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { Activity, ArrowRight, BrainCircuit, Check, Clock3, KeyRound, LoaderCircle, RotateCcw, ShieldCheck, Sparkles, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BOARD, GROUP_COLORS, gridPosition } from "@/lib/game/board";
import { AGENTS, combineDecisions } from "@/lib/game/policy";
import { SCENARIOS } from "@/lib/game/scenarios";
import type { AgentDecision, AgentId, BoardSpace, PlayerState, PropertyState } from "@/lib/game/types";

type Decisions = Record<AgentId, AgentDecision>;
interface LiveResponse { decisions: Decisions; champion: AgentDecision; latencyMs: number; error?: string }

const playerColors: Record<string, string> = {
  champion: "#f4c430", builder: "#ef6f45", risk: "#4cb6ab", dealer: "#8c7ee8",
};

function percentage(value: number) { return `${Math.round(value * 100)}%`; }

function SpaceTile({ space, players, propertyState }: { space: BoardSpace; players: PlayerState[]; propertyState: Record<number, PropertyState> }) {
  const position = gridPosition(space.index);
  const occupants = players.filter((player) => player.position === space.index);
  const owner = propertyState[space.index]?.ownerId;
  return (
    <div className={`board-space board-space--${space.kind} ${space.kind === "corner" ? "board-space--corner" : ""}`} style={{ gridRow: position.row, gridColumn: position.column } as CSSProperties} title={`${space.index}. ${space.name}${space.price ? ` · $${space.price}` : ""}`}>
      {space.group ? <span className="property-band" style={{ background: GROUP_COLORS[space.group] }} /> : null}
      <span className="space-index">{String(space.index).padStart(2, "0")}</span>
      <span className="space-name">{space.shortName}</span>
      {space.price ? <span className="space-price">${space.price}</span> : null}
      {owner ? <span className="owner-pip" style={{ background: playerColors[owner] ?? "#111" }} /> : null}
      {occupants.length ? <span className="token-stack" aria-label={`${occupants.map((player) => player.name).join(", ")} on ${space.name}`}>
        {occupants.map((player) => <span key={player.id} className="player-token" style={{ background: playerColors[player.id] ?? "#111" }}>{player.token}</span>)}
      </span> : null}
    </div>
  );
}

function CampusBoard({ scenarioIndex }: { scenarioIndex: number }) {
  const scenario = SCENARIOS[scenarioIndex];
  return (
    <section className="board-frame" aria-label="University of Waterloo themed strategy board">
      <div className="board-grid">
        {BOARD.map((space) => <SpaceTile key={space.index} space={space} players={scenario.state.players} propertyState={scenario.state.propertyState} />)}
        <div className="board-center">
          <div className="board-watermark" aria-hidden="true">W</div>
          <p className="overline">JEV strategy lab · scenario {scenario.order}/6</p>
          <h1>University of Waterloo<br /><span>Monopoly Arena</span></h1>
          <p className="board-thesis">Four minds. One decision.</p>
          <div className="turn-card"><span>Round {scenario.state.round}</span><strong>{scenario.state.phase}</strong><span>{scenario.eyebrow}</span></div>
          <div className="player-ledger" aria-label="Player cash">
            {scenario.state.players.map((player) => <span key={player.id}><i style={{ background: playerColors[player.id] }} />{player.name} <strong>${player.cash}</strong></span>)}
          </div>
        </div>
      </div>
    </section>
  );
}

function ProbabilityBars({ decision, actions }: { decision: AgentDecision; actions: { id: string; shortLabel: string }[] }) {
  return <div className="probability-list">{actions.map((action) => {
    const probability = decision.probabilities[action.id] ?? 0;
    return <div className="probability-row" key={action.id}><span>{action.shortLabel}</span><span className="probability-track"><i style={{ width: percentage(probability) }} /></span><strong>{percentage(probability)}</strong></div>;
  })}</div>;
}

function AgentCard({ id, decision, scenarioIndex }: { id: AgentId; decision: AgentDecision; scenarioIndex: number }) {
  const agent = AGENTS[id];
  const scenario = SCENARIOS[scenarioIndex];
  const selected = scenario.legalActions.find((action) => action.id === decision.choice);
  return <article className="agent-card" style={{ "--agent": agent.color } as CSSProperties}>
    <div className="agent-card__head"><span className="agent-glyph"><BrainCircuit size={16} /></span><span><strong>{agent.name}</strong><small>{agent.role}</small></span><span className="confidence">{percentage(decision.confidence)} conviction</span></div>
    <div className="agent-choice"><small>SELECTS</small><strong>{selected?.shortLabel ?? decision.choice}</strong></div>
    <ProbabilityBars decision={decision} actions={scenario.legalActions} />
    <p>{decision.factors.join(" · ")}</p>
  </article>;
}

export default function Arena() {
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [apiKey, setApiKey] = useState(() =>
    typeof window === "undefined" ? "" : window.sessionStorage.getItem("jev-api-key") ?? "",
  );
  const [decisions, setDecisions] = useState<Decisions>(SCENARIOS[0].decisions);
  const [champion, setChampion] = useState(() => combineDecisions(SCENARIOS[0]));
  const [mode, setMode] = useState<"recorded" | "live">("recorded");
  const [status, setStatus] = useState<"idle" | "loading" | "success">("idle");
  const [error, setError] = useState("");
  const [latency, setLatency] = useState<number | null>(null);
  const [humanChoice, setHumanChoice] = useState<string | null>(null);
  const scenario = SCENARIOS[scenarioIndex];
  const championAction = scenario.legalActions.find((action) => action.id === champion.choice);
  const agreement = useMemo(() => Object.values(decisions).filter((decision) => decision.choice === champion.choice).length, [decisions, champion.choice]);

  function selectScenario(index: number) {
    if (index < 0) return;
    const next = SCENARIOS[index];
    setScenarioIndex(index); setDecisions(next.decisions); setChampion(combineDecisions(next)); setMode("recorded"); setStatus("idle"); setError(""); setLatency(null); setHumanChoice(null);
  }

  async function runLive() {
    if (!apiKey.trim()) { setError("Paste a JevAI key to run this scenario live."); return; }
    setError(""); setStatus("loading"); window.sessionStorage.setItem("jev-api-key", apiKey.trim());
    try {
      const response = await fetch("/api/jev", { method: "POST", headers: { "Content-Type": "application/json", "x-jev-api-key": apiKey.trim() }, body: JSON.stringify({ scenarioId: scenario.id }) });
      const data = (await response.json()) as LiveResponse;
      if (!response.ok || data.error) throw new Error(data.error || "Live decision failed.");
      setDecisions(data.decisions); setChampion(data.champion); setLatency(data.latencyMs); setMode("live"); setStatus("success");
    } catch (reason) { setStatus("idle"); setError(reason instanceof Error ? reason.message : "Live decision failed."); }
  }

  return <main className="arena-shell">
    <header className="topbar">
      <div className="brand-lockup"><span className="brand-mark">J</span><span><strong>JEV / MONOPOLY</strong><small>WATERLOO STRATEGY LAB</small></span></div>
      <div className="run-state"><span className={mode === "live" ? "status-dot status-dot--live" : "status-dot"} /><span>{mode === "live" ? "LIVE JEV RUN" : "RECORDED JEV RUN"}</span>{latency ? <small><Clock3 size={12} /> {latency}ms</small> : null}</div>
      <a className="method-link" href="#method">How it works <ArrowRight size={14} /></a>
    </header>

    <section className="scenario-strip" aria-label="Showcase scenarios"><span className="scenario-label">DECISION TESTS</span><Tabs value={scenario.id} onValueChange={(value) => selectScenario(SCENARIOS.findIndex((item) => item.id === value))}><TabsList className="scenario-tabs">{SCENARIOS.map((item, index) => <TabsTrigger key={item.id} value={item.id} className="scenario-tab"><span>{String(index + 1).padStart(2, "0")}</span>{item.family}</TabsTrigger>)}</TabsList></Tabs></section>

    <div className="arena-grid">
      <CampusBoard scenarioIndex={scenarioIndex} />
      <aside className="decision-rail">
        <div className="rail-heading"><span className="overline">{scenario.eyebrow}</span><h2>{scenario.title}</h2><p>{scenario.prompt}</p></div>
        <div className="your-call"><span>MAKE YOUR CALL</span><div className="action-stack">{scenario.legalActions.map((action) => <button type="button" key={action.id} className={humanChoice === action.id ? "action-option action-option--selected" : "action-option"} onClick={() => setHumanChoice(action.id)}><span>{action.shortLabel}</span><small>{action.description}</small>{humanChoice === action.id ? <Check size={16} /> : <ArrowRight size={16} />}</button>)}</div>{humanChoice ? <p className={humanChoice === champion.choice ? "call-result call-result--match" : "call-result"}>{humanChoice === champion.choice ? "You matched the champion." : `Champion chose ${championAction?.shortLabel}. Compare its logic below.`}</p> : null}</div>
        <article className="champion-card"><div className="champion-topline"><Trophy size={18} /><span>COMBINED CHAMPION</span><em>{agreement}/4 agree</em></div><small>FINAL CALL</small><h3>{championAction?.label ?? champion.choice}</h3><p>{scenario.insight}</p><ProbabilityBars decision={champion} actions={scenario.legalActions} /><div className="champion-meta"><ShieldCheck size={15} /> Policy-weighted geometric consensus</div></article>
      </aside>
    </div>

    <section className="agent-section" id="method"><div className="section-heading"><div><span className="overline">SPECIALIST PANEL</span><h2>Same state. Different instincts.</h2></div><p>Each specialist receives the same public state and legal actions. Their probability distributions are combined with weights tuned to the decision family.</p></div><div className="agent-grid">{(Object.keys(AGENTS) as AgentId[]).map((id) => <AgentCard key={id} id={id} decision={decisions[id]} scenarioIndex={scenarioIndex} />)}</div></section>

    <section className="live-lab"><div className="live-lab__copy"><span className="live-icon"><Sparkles size={22} /></span><div><span className="overline">BRING YOUR OWN KEY</span><h2>Rerun the panel live.</h2><p>The key is sent only with this request, held in session storage, and never logged by this app.</p></div></div><div className="key-console"><label htmlFor="jev-key"><KeyRound size={15} /> JevAI API key</label><div className="key-row"><Input id="jev-key" type="password" autoComplete="off" placeholder="Paste key for a live decision" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /><Button onClick={runLive} disabled={status === "loading"}>{status === "loading" ? <LoaderCircle className="spin" size={17} /> : status === "success" ? <RotateCcw size={17} /> : <Activity size={17} />}{status === "loading" ? "Thinking…" : mode === "live" ? "Run again" : "Run live"}</Button></div>{error ? <p className="key-error" role="alert">{error}</p> : null}</div></section>

    <footer><span>Built as an independent strategy experiment.</span><span>Unofficial · Not affiliated with the University of Waterloo or Hasbro.</span><span>JEV output is evaluated only against legal actions.</span></footer>
  </main>;
}
