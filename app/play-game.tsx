"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import {
  Activity, ArrowRight, Bot, BrainCircuit, Building2, ChevronDown,
  Clock3, Dice5, Eye, Gauge, HelpCircle, History, KeyRound, Landmark, LoaderCircle, Lock,
  Pause, Play, RotateCcw, Scale, ShieldAlert, Sparkles, Trophy, Users, WalletCards, X,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { BOARD, GROUP_COLORS, gridPosition } from "@/lib/game/board";
import { TITLE_DEEDS, deedFor } from "@/lib/monopoly/data";
import { applyAction, assertStateIntegrity, createGame, currentPlayer, isLegalAction, netWorth, stateHash } from "@/lib/monopoly/engine";
import { generateLegalPlans } from "@/lib/monopoly/plans";
import { blendWithLiveJev, chooseLocalPlan } from "@/lib/monopoly/policy-model";
import { buildPublicDecisionState } from "@/lib/monopoly/public-state";
import type { DecisionRecord, GameAction, GameState, LegalPlan, PlayerSpec, PolicyId, TradeOffer } from "@/lib/monopoly/types";

const SAVE_KEY = "uw-monopoly-game-v1";
const ARCHIVE_KEY = "uw-monopoly-incompatible-saves";
const playerColors: Record<string, string> = {
  human: "#f5f3e9", champion: "#f4c430", specialist1: "#ef6f45", specialist2: "#4cb6ab",
};
const specialistOptions: Array<{ id: Exclude<PolicyId, "human" | "champion">; label: string; note: string }> = [
  { id: "builder", label: "Builder", note: "Completes sets and develops rent pressure." },
  { id: "risk", label: "Risk Manager", note: "Protects liquidity and recovery options." },
  { id: "dealmaker", label: "Dealmaker", note: "Values leverage, denial, and exchanges." },
  { id: "balanced", label: "Opportunist", note: "Chases the strongest overall win contribution." },
];

interface LivePlanResponse {
  planId: string;
  probabilities: Record<string, number>;
  confidence: number;
  latencyMs: number;
  specialistProbabilities?: DecisionRecord["specialistProbabilities"];
  credentialSource?: "personal" | "owner-default";
  error?: string;
}

type AiSpeed = "paused" | "normal" | "fast";
interface OwnerStatus { owner: boolean; expiresAt?: number }

interface LastDecision {
  actorId: string;
  actorName: string;
  plan: LegalPlan;
  record: DecisionRecord;
  note: string;
}

function decisionActor(state: GameState) {
  if (state.phase === "auction") return state.auction?.currentBidderId ?? currentPlayer(state).id;
  if (state.phase === "trade-response") return state.pendingTrade?.toId ?? currentPlayer(state).id;
  if (state.phase === "debt") return state.pendingDebt?.debtorId ?? currentPlayer(state).id;
  if (state.phase === "building-placement") return state.pendingBuildingPlacement?.playerId ?? currentPlayer(state).id;
  return currentPlayer(state).id;
}

function phaseLabel(state: GameState) {
  if (state.phase === "pre-roll") return currentPlayer(state).inJail ? "Jail decision" : "Ready to roll";
  if (state.phase === "purchase") return "Property purchase";
  if (state.phase === "auction") return `Auction · $${state.auction?.highBid ?? 0}`;
  if (state.phase === "building-placement") return `Place auctioned ${state.pendingBuildingPlacement?.buildingKind ?? "building"}`;
  if (state.phase === "debt") return `Debt · $${state.pendingDebt?.amount ?? 0}`;
  if (state.phase === "trade-response") return "Trade response";
  if (state.phase === "game-over") return "Final standings";
  return state.extraRoll ? "Extra roll available" : "Manage assets";
}

function eventText(event: GameState["events"][number]) {
  if (event.type === "game-created") return `Game created · ${String(event.payload.mode)} mode`;
  if (event.type === "draw-card") return `${String(event.payload.label)}`;
  if (event.type === "roll") return event.payload.dice && Array.isArray(event.payload.dice) ? `Rolled ${Number(event.payload.dice[0]) + Number(event.payload.dice[1])} and landed on ${String(event.payload.destinationName)}` : "Rolled the dice";
  if (event.type === "buy-property") return event.payload.name ? `Bought ${String(event.payload.name)} for $${String(event.payload.price)}` : "Bought the landed property";
  if (event.type === "decline-property") return "Opened a mandatory auction";
  if (event.type === "auction-bid") return `Bid $${String(event.payload.amount)}`;
  if (event.type === "auction-pass") return "Passed in the auction";
  if (event.type === "build") return `Built on ${deedFor(Number(event.payload.spaceIndex)).name}`;
  if (event.type === "sell-building") return `Sold a building on ${deedFor(Number(event.payload.spaceIndex)).name}`;
  if (event.type === "mortgage") return `Mortgaged ${deedFor(Number(event.payload.spaceIndex)).name}`;
  if (event.type === "unmortgage") return `Unmortgaged ${deedFor(Number(event.payload.spaceIndex)).name}`;
  if (event.type === "propose-trade") return "Proposed a structured trade";
  if (event.type === "accept-trade") return "Accepted the trade";
  if (event.type === "reject-trade") return "Rejected the trade";
  if (event.type === "declare-bankruptcy") return "Declared bankruptcy";
  if (event.type === "pay-jail") return "Paid the jail release fee";
  return event.type.replaceAll("-", " ");
}

function turnSummaries(state: GameState) {
  const summaries: Array<{ key: number; sequence: string; actor: string; text: string }> = [];
  let group: GameState["events"] = [];
  const flush = () => {
    if (!group.length) return;
    const first = group[0]; const last = group.at(-1)!;
    const actor = state.players.find((player) => player.id === first.actorId)?.name ?? first.actorId;
    const phrases = group.map((event) => {
      const text = eventText(event);
      return text.charAt(0).toLowerCase() + text.slice(1);
    });
    const text = phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}`;
    summaries.push({ key: last.sequence, sequence: first.sequence === last.sequence ? String(last.sequence).padStart(3, "0") : `${String(first.sequence).padStart(3, "0")}–${String(last.sequence).padStart(3, "0")}`, actor, text });
    group = [];
  };
  for (const event of state.events) {
    if (group.length && group[0].actorId !== event.actorId) flush();
    group.push(event);
    if (event.type === "end-turn" || event.type === "declare-bankruptcy" || event.type === "game-created") flush();
  }
  flush();
  return summaries.reverse().slice(0, 10);
}

function SpaceTile({ state, index }: { state: GameState; index: number }) {
  const space = BOARD[index];
  const position = gridPosition(index);
  const deed = state.deeds[index];
  const occupants = state.players.filter((player) => !player.bankrupt && player.position === index);
  const activeActorId = decisionActor(state);
  return <div
    className={`board-space board-space--${space.kind} ${space.kind === "corner" ? "board-space--corner" : ""} ${occupants.some((player) => player.id === activeActorId) ? "is-active-destination" : ""}`}
    style={{ gridRow: position.row, gridColumn: position.column } as CSSProperties}
    title={`${space.index}. ${space.name}${space.price ? ` · $${space.price}` : ""}`}
  >
    {space.group ? <span className="property-band" style={{ background: GROUP_COLORS[space.group] }} /> : null}
    <span className="space-index">{String(index).padStart(2, "0")}</span>
    <span className="space-name">{space.shortName}</span>
    {space.price ? <span className="space-price">${space.price}</span> : null}
    {deed?.mortgaged ? <span className="deed-state">M</span> : deed?.buildings ? <span className="deed-state">{deed.buildings === 5 ? "HOTEL" : `H${deed.buildings}`}</span> : null}
    {deed?.ownerId ? <span className="owner-pip" style={{ background: playerColors[deed.ownerId] ?? "#111" }} /> : null}
    {occupants.length ? <span className="token-stack" aria-label={`${occupants.map((player) => player.name).join(", ")} on ${space.name}`}>
      {occupants.map((player) => <span key={player.id} className={`player-token ${player.id === activeActorId ? "is-active" : ""}`} style={{ background: playerColors[player.id] ?? "#111" }}>{player.token}</span>)}
    </span> : null}
  </div>;
}

export function GameBoard({ state }: { state: GameState }) {
  const actor = state.players.find((player) => player.id === decisionActor(state));
  return <section className="board-frame game-board" aria-label="Waterloo Monopoly board">
    <div className="board-grid">
      {BOARD.map((space) => <SpaceTile key={space.index} state={state} index={space.index} />)}
      <div className="board-center game-board-center">
        <div className="board-watermark" aria-hidden="true">W</div>
        <p className="overline">{state.mode === "short" ? "Official short game" : "Classic game"} · round {state.round}</p>
        <h1>Waterloo<br /><span>Monopoly</span></h1>
        <div className="live-turn">
          <span style={{ background: playerColors[actor?.id ?? ""] }}>{actor?.token}</span>
          <div><small>{actor?.name}</small><strong>{phaseLabel(state)}</strong></div>
        </div>
        {state.lastRoll ? <div className="dice-readout" aria-label={`Last roll ${state.lastRoll[0]} and ${state.lastRoll[1]}`}><Dice5 size={15} /> {state.lastRoll[0]} + {state.lastRoll[1]}</div> : null}
        <div className="bank-supply"><span>{state.bank.houses} houses</span><span>{state.bank.hotels} hotels</span></div>
      </div>
    </div>
  </section>;
}

function HowToPlay() {
  return <Dialog><DialogTrigger asChild><button type="button" className="nav-button"><HelpCircle size={15} /> How to play</button></DialogTrigger><DialogContent className="how-dialog"><DialogHeader><DialogTitle>How a turn works</DialogTitle><DialogDescription>The rules engine presents only legal actions. You choose; it resolves movement, rent, debt, and ownership automatically.</DialogDescription></DialogHeader><ol><li><strong>Roll</strong><span>Move, resolve cards or taxes, and collect $200 when passing Start.</span></li><li><strong>Buy or auction</strong><span>Purchase an unowned deed or decline it; every declined deed must be auctioned.</span></li><li><strong>Manage</strong><span>Build evenly, mortgage eligible deeds, trade, or end your turn.</span></li><li><strong>Jail and debt</strong><span>Choose a legal release option or liquidate assets before bankruptcy.</span></li></ol></DialogContent></Dialog>;
}

export function GameNav({ subtitle = "WATERLOO STRATEGY LAB", onNewGame }: { subtitle?: string; onNewGame?: () => void }) {
  return <header className="game-topbar"><Link className="brand-lockup" href="/"><span className="brand-mark">J</span><span><strong>JEV / MONOPOLY</strong><small>{subtitle}</small></span></Link><nav className="primary-nav"><Link className="nav-button nav-button--primary" href="/">Play</Link><Link className="nav-button" href="/arena">Decision arena</Link><Link className="nav-button" href="/benchmarks">Benchmarks</Link><HowToPlay />{onNewGame ? <button type="button" className="nav-button" onClick={onNewGame}>New game</button> : null}</nav></header>;
}

function SetupScreen({ onStart, resumed, onResume, owner, onUnlock, onLock }: { onStart: (options: { mode: "classic" | "short"; name: string; policies: [PolicyId, PolicyId]; telemetry: boolean; apiKey: string }) => void; resumed: GameState | null; onResume: () => void; owner: OwnerStatus; onUnlock: (code: string) => Promise<string>; onLock: () => Promise<void> }) {
  const [mode, setMode] = useState<"classic" | "short">("short");
  const [name, setName] = useState("You");
  const [first, setFirst] = useState<PolicyId>("builder");
  const [second, setSecond] = useState<PolicyId>("dealmaker");
  const [telemetry, setTelemetry] = useState(true);
  const [apiKey, setApiKey] = useState(() => typeof window === "undefined" ? "" : window.sessionStorage.getItem("jev-api-key") ?? "");
  const [ownerCode, setOwnerCode] = useState("");
  const [ownerMessage, setOwnerMessage] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const distinctSecond = second === first ? specialistOptions.find((option) => option.id !== first)!.id : second;

  return <main className="game-shell setup-shell">
    <GameNav />
    <div className="mobile-gate"><ShieldAlert size={30} /><h1>Use a larger screen to play</h1><p>The complete board and asset controls require a tablet or desktop. Your saved game remains on this device.</p><div className="mobile-links"><a href="/arena">Decision arena</a><a href="/benchmarks">Benchmarks</a><a href="/privacy">Privacy</a></div></div>
    <section className="setup-grid game-desktop">
      <div className="setup-intro"><span className="overline">PLAY THE AGENTS</span><h1>Your table<br />is ready.</h1><p>Face the experimental Champion and two specialists. The rules engine controls every legal move; JEV supplies strategy when live access is available.</p>
        <div className="launch-actions"><a className="launch-action" href="#game-setup"><Sparkles size={17} /> Set up a game</a><a className="launch-action" href="/arena"><BrainCircuit size={17} /> Decision arena</a><a className="launch-action" href="/benchmarks"><Trophy size={17} /> Agent results</a></div>
        <div className="rule-chips"><span>Mandatory auctions</span><span>Finite buildings</span><span>Jail & mortgages</span><span>Structured trades</span></div>
      </div>
      <form id="game-setup" className="setup-panel" onSubmit={(event) => { event.preventDefault(); onStart({ mode, name: name.trim() || "You", policies: [first, distinctSecond], telemetry, apiKey: apiKey.trim() }); }}>
        {resumed ? <button type="button" className="resume-card" onClick={onResume}><RotateCcw size={19} /><span><strong>Resume round {resumed.round}</strong><small>{resumed.mode === "short" ? "Short Game" : "Classic"} · {resumed.events.length} recorded events</small></span><ArrowRight size={18} /></button> : null}
        <fieldset><legend>Game format</legend><div className="mode-cards">
          <label className={mode === "short" ? "selected" : ""}><input type="radio" checked={mode === "short"} onChange={() => setMode("short")} /><Clock3 /><span><strong>Short Game</strong><small>First bankruptcy ends the match; net worth decides. Best first game.</small></span></label>
          <label className={mode === "classic" ? "selected" : ""}><input type="radio" checked={mode === "classic"} onChange={() => setMode("classic")} /><Landmark /><span><strong>Classic</strong><small>Continue until only one player remains solvent.</small></span></label>
        </div></fieldset>
        <label className="field-label">Your name<input value={name} maxLength={32} onChange={(event) => setName(event.target.value)} /></label>
        <fieldset><legend>Choose two opponents</legend><div className="opponent-selects">
          {[{ value: first, set: setFirst }, { value: distinctSecond, set: setSecond }].map((selector, index) => <label key={index}><span>Specialist {index + 1}</span><select value={selector.value} onChange={(event) => selector.set(event.target.value as PolicyId)}>{specialistOptions.filter((option) => index === 0 || option.id !== first).map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select><ChevronDown size={16} /></label>)}
        </div></fieldset>
        <details className="agent-access" open={owner.owner}><summary><KeyRound size={16} /><span>Agent access</span><em className={owner.owner ? "is-live" : ""}>{apiKey ? "Personal key" : owner.owner ? "Owner JEV ready" : "Local policy"}</em></summary><div>
          {owner.owner ? <div className="owner-ready"><span><strong>Owner access unlocked</strong><small>All three AI agents will use the protected default JEV key with immediate local fallback.</small></span><button type="button" onClick={() => void onLock()}><Lock size={14} /> Lock</button></div> : <div className="owner-unlock"><label className="field-label"><span>Owner access code</span><input type="password" autoComplete="off" value={ownerCode} onChange={(event) => setOwnerCode(event.target.value)} placeholder="Owner only" /></label><button type="button" disabled={unlocking || ownerCode.length < 16} onClick={async () => { setUnlocking(true); const message = await onUnlock(ownerCode); setOwnerMessage(message); setUnlocking(false); if (!message) setOwnerCode(""); }}>{unlocking ? "Unlocking…" : "Unlock owner JEV"}</button>{ownerMessage ? <small className="access-error" role="alert">{ownerMessage}</small> : null}</div>}
          <label className="field-label"><span>Personal JevAI key <em>optional override</em></span><div className="key-field"><KeyRound size={16} /><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Use your own key for this browser session" /></div><small>Personal key takes priority. Live calls time out after eight seconds and fall back locally without retrying.</small></label>
        </div></details>
        <label className="check-row"><input type="checkbox" checked={telemetry} onChange={(event) => setTelemetry(event.target.checked)} /><span><strong>Share anonymous match events</strong><small>No key, account, stable device identifier, fingerprint, or free-form text.</small></span></label>
        <button className="start-button" type="submit"><Sparkles size={18} /> Start game <ArrowRight size={18} /></button>
        <p className="experimental-note"><ShieldAlert size={14} /> Agent is experimental until it passes the published promotion gate.</p>
      </form>
    </section>
  </main>;
}

function Standings({ state }: { state: GameState }) {
  const ranked = [...state.players].sort((a, b) => Number(a.bankrupt) - Number(b.bankrupt) || netWorth(state, b.id) - netWorth(state, a.id));
  return <section className="game-card standings-card"><div className="card-title"><Trophy size={16} /><span>Standings</span></div>{ranked.map((player, index) => <div className={`standing ${player.bankrupt ? "is-bankrupt" : ""}`} key={player.id}><span className="rank">{index + 1}</span><span className="standing-token" style={{ background: playerColors[player.id] }}>{player.token}</span><span><strong>{player.name}</strong><small>{player.inJail ? "In jail · " : ""}{player.properties.length} deeds</small></span><span><strong>${player.cash}</strong><small>${netWorth(state, player.id)} worth</small></span></div>)}</section>;
}

function PropertyManager({ state, onAction }: { state: GameState; onAction: (action: GameAction) => void }) {
  const human = state.players.find((player) => player.id === "human")!;
  return <section className="game-card property-card"><div className="card-title"><Building2 size={16} /><span>Your deeds</span><em>{human.properties.length}</em></div>
    {!human.properties.length ? <p className="empty-copy">Properties you buy appear here with mortgage and building controls.</p> : <div className="deed-list">{human.properties.map((index) => {
      const deed = TITLE_DEEDS[index]; const status = state.deeds[index];
      const controls: Array<{ label: string; action: GameAction }> = [
        { label: "Build", action: { type: "build", spaceIndex: index } },
        { label: "Sell", action: { type: "sell-building", spaceIndex: index } },
        { label: status.mortgaged ? "Unmortgage" : "Mortgage", action: status.mortgaged ? { type: "unmortgage", spaceIndex: index } : { type: "mortgage", spaceIndex: index } },
      ];
      return <div className="deed-row" key={index}><i style={{ background: deed.group ? GROUP_COLORS[deed.group] : "#82877e" }} /><span><strong>{deed.name}</strong><small>{status.mortgaged ? `Mortgaged · $${deed.mortgage}` : status.buildings === 5 ? "Hotel" : status.buildings ? `${status.buildings} house${status.buildings > 1 ? "s" : ""}` : deed.kind}</small></span><div>{controls.map(({ label, action }) => <button type="button" key={label} disabled={!isLegalAction(state, "human", action)} onClick={() => onAction(action)}>{label}</button>)}</div></div>;
    })}</div>}
  </section>;
}

function TradeBuilder({ state, onAction, onClose }: { state: GameState; onAction: (action: GameAction) => void; onClose: () => void }) {
  const human = state.players.find((player) => player.id === "human")!;
  const opponents = state.players.filter((player) => player.id !== "human" && !player.bankrupt);
  const [targetId, setTargetId] = useState(opponents[0]?.id ?? "");
  const target = state.players.find((player) => player.id === targetId) ?? opponents[0];
  const [giveCash, setGiveCash] = useState(0); const [askCash, setAskCash] = useState(0);
  const [giveProperties, setGiveProperties] = useState<number[]>([]); const [askProperties, setAskProperties] = useState<number[]>([]);
  const [giveCards, setGiveCards] = useState<Array<"chance" | "community">>([]); const [askCards, setAskCards] = useState<Array<"chance" | "community">>([]);
  const toggle = <T,>(list: T[], item: T, setter: (value: T[]) => void) => setter(list.includes(item) ? list.filter((value) => value !== item) : [...list, item]);
  function submit() {
    if (!target) return;
    const offer: TradeOffer = { id: `trade-human-${target.id}-${state.events.length}`, fromId: "human", toId: target.id, offer: { cash: giveCash, properties: giveProperties, getOutCards: giveCards }, request: { cash: askCash, properties: askProperties, getOutCards: askCards }, counterDepth: 0 };
    onAction({ type: "propose-trade", offer });
  }
  return <div className="sheet-backdrop" role="presentation"><section className="trade-sheet" role="dialog" aria-modal="true" aria-label="Build a trade"><header><div><span className="overline">STRUCTURED NEGOTIATION</span><h2>Build a trade</h2></div><button type="button" onClick={onClose} aria-label="Close trade builder"><X /></button></header>
    <label className="field-label">Trade with<select value={target?.id} onChange={(event) => { setTargetId(event.target.value); setAskProperties([]); setAskCards([]); }}>{opponents.map((player) => <option value={player.id} key={player.id}>{player.name}</option>)}</select></label>
    <div className="trade-columns"><div><h3>You give</h3><label className="field-label">Cash<input type="number" min={0} max={human.cash} value={giveCash} onChange={(event) => setGiveCash(Math.max(0, Number(event.target.value)))} /></label><AssetChecks title="Deeds" indexes={human.properties} selected={giveProperties} onToggle={(index) => toggle(giveProperties, index, setGiveProperties)} /><CardChecks cards={human.getOutCards} selected={giveCards} onToggle={(card) => toggle(giveCards, card, setGiveCards)} /></div>
      <div><h3>You receive</h3><label className="field-label">Cash<input type="number" min={0} max={target?.cash ?? 0} value={askCash} onChange={(event) => setAskCash(Math.max(0, Number(event.target.value)))} /></label><AssetChecks title="Deeds" indexes={target?.properties ?? []} selected={askProperties} onToggle={(index) => toggle(askProperties, index, setAskProperties)} /><CardChecks cards={target?.getOutCards ?? []} selected={askCards} onToggle={(card) => toggle(askCards, card, setAskCards)} /></div></div>
    <button className="start-button" type="button" onClick={submit}>Send offer <ArrowRight size={17} /></button><p className="experimental-note">Improved color groups cannot be traded. Mortgaged deeds charge the recipient 10% interest immediately.</p>
  </section></div>;
}

function AssetChecks({ title, indexes, selected, onToggle }: { title: string; indexes: number[]; selected: number[]; onToggle: (index: number) => void }) {
  return <fieldset className="asset-checks"><legend>{title}</legend>{indexes.length ? indexes.map((index) => <label key={index}><input type="checkbox" checked={selected.includes(index)} onChange={() => onToggle(index)} /><span>{deedFor(index).name}</span></label>) : <small>None available</small>}</fieldset>;
}

function CardChecks({ cards, selected, onToggle }: { cards: Array<"chance" | "community">; selected: Array<"chance" | "community">; onToggle: (card: "chance" | "community") => void }) {
  return <fieldset className="asset-checks"><legend>Amnesty cards</legend>{cards.length ? cards.map((card) => <label key={card}><input type="checkbox" checked={selected.includes(card)} onChange={() => onToggle(card)} /><span>{card} card</span></label>) : <small>None available</small>}</fieldset>;
}

function DecisionPanel({ state, plans, thinking, liveAccess, lastDecision, onPlan, onOpenTrade, onShare, shareUrl, shareStatus, speed, onSpeed, onStep }: { state: GameState; plans: LegalPlan[]; thinking: boolean; liveAccess: boolean; lastDecision: LastDecision | null; onPlan: (plan: LegalPlan) => void; onOpenTrade: () => void; onShare: () => void; shareUrl: string; shareStatus: string; speed: AiSpeed; onSpeed: (speed: AiSpeed) => void; onStep: () => void }) {
  const actorId = decisionActor(state); const actor = state.players.find((player) => player.id === actorId)!;
  const humanDecision = actorId === "human" && state.phase !== "game-over";
  return <section className="game-card decision-card action-dock" aria-live="polite"><div className="decision-head"><span className="overline">{humanDecision ? "YOUR DECISION" : thinking ? liveAccess ? "ASKING JEV" : "LOCAL POLICY THINKING" : speed === "paused" && actor.kind === "ai" ? "AGENTS PAUSED" : "TABLE STATUS"}</span><h2>{state.phase === "game-over" ? `${state.players.find((player) => player.id === state.winnerId)?.name} wins` : phaseLabel(state)}</h2><p>{state.phase === "debt" ? `${actor.name} must raise $${state.pendingDebt?.amount}.` : state.phase === "auction" ? `${actor.name} acts next. High bid: $${state.auction?.highBid}.` : `${actor.name} acts now.`}</p></div>
    <div className="pace-controls" aria-label="Agent playback speed"><button type="button" className={speed === "paused" ? "selected" : ""} onClick={() => onSpeed("paused")}><Pause size={14} /> Pause</button><button type="button" className={speed === "normal" ? "selected" : ""} onClick={() => onSpeed("normal")}><Play size={14} /> Normal</button><button type="button" className={speed === "fast" ? "selected" : ""} onClick={() => onSpeed("fast")}><Gauge size={14} /> Fast</button>{speed === "paused" && actor.kind === "ai" ? <button type="button" className="step-agent" onClick={onStep}>Step agent <ArrowRight size={14} /></button> : null}</div>
    {thinking ? <div className="thinking-line"><LoaderCircle className="spin" /><span><strong>{actor.name} is choosing</strong><small>Every option was generated and validated by the rules engine.</small></span></div> : null}
    {humanDecision ? <div className="plan-stack">{plans.map((plan) => <button type="button" key={plan.id} onClick={() => onPlan(plan)}><span><strong>{plan.label}</strong><small>{plan.description}</small></span><ArrowRight size={17} /></button>)}{state.phase === "manage" ? <button type="button" onClick={onOpenTrade}><span><strong>Build a custom trade</strong><small>Exchange cash, deeds, or amnesty cards with an opponent.</small></span><Users size={17} /></button> : null}</div> : null}
    {state.phase === "game-over" ? <div className="winner-card"><Trophy /><strong>Winner: {state.players.find((player) => player.id === state.winnerId)?.name}</strong><span>Seed {state.seed} · {state.events.length} deterministic events</span>{shareUrl ? <a href={shareUrl}>Open shared replay <ArrowRight size={14} /></a> : <button type="button" onClick={onShare} disabled={shareStatus === "sharing"}>{shareStatus === "sharing" ? "Creating replay…" : "Share 30-day replay"}</button>}{shareStatus && shareStatus !== "sharing" && !shareUrl ? <small>{shareStatus}</small> : null}</div> : null}
    {lastDecision ? <details className="explain-drawer"><summary><Eye size={15} /> Last agent explanation</summary><div><strong>{lastDecision.actorName}: {lastDecision.plan.label}</strong><p>{lastDecision.note}</p><div className="probability-list">{Object.entries(lastDecision.record.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, value]) => <div className="probability-row" key={id}><span>{id.split(":")[0]}</span><span className="probability-track"><i style={{ width: `${Math.round(value * 100)}%` }} /></span><strong>{Math.round(value * 100)}%</strong></div>)}</div></div></details> : null}
  </section>;
}

function TurnStrip({ state, thinking, liveAccess, lastDecision }: { state: GameState; thinking: boolean; liveAccess: boolean; lastDecision: LastDecision | null }) {
  const actor = state.players.find((player) => player.id === decisionActor(state));
  const latest = state.events.at(-1);
  const status = thinking ? liveAccess ? "Asking JEV…" : "Running the trained local policy…" : lastDecision ? `${lastDecision.actorName}: ${lastDecision.plan.label}` : latest ? `${state.players.find((player) => player.id === latest.actorId)?.name ?? latest.actorId}: ${eventText(latest)}` : "Game ready";
  const source = lastDecision?.record.source === "live-jev" ? "Live JEV decision" : lastDecision?.note.startsWith("Local fallback") ? "Local fallback" : lastDecision ? "Trained local decision" : "Rules engine";
  return <section className="turn-strip" aria-live="polite"><span className="turn-token" style={{ background: playerColors[actor?.id ?? ""] }}>{actor?.token}</span><div><small>NOW PLAYING · ROUND {state.round}</small><strong>{actor?.name} · {phaseLabel(state)}</strong></div><div className="turn-event"><small>{source}</small><strong>{status}</strong></div>{state.lastRoll ? <div className="turn-dice"><Dice5 size={16} /><strong>{state.lastRoll[0]} + {state.lastRoll[1]}</strong></div> : null}</section>;
}

export default function PlayGame() {
  const [game, setGame] = useState<GameState | null>(null);
  const [savedGame, setSavedGame] = useState<GameState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [apiKey, setApiKey] = useState(() => typeof window === "undefined" ? "" : window.sessionStorage.getItem("jev-api-key") ?? "");
  const [lastDecision, setLastDecision] = useState<LastDecision | null>(null);
  const [error, setError] = useState("");
  const [tradeOpen, setTradeOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [shareStatus, setShareStatus] = useState("");
  const [owner, setOwner] = useState<OwnerStatus>({ owner: false });
  const [speed, setSpeed] = useState<AiSpeed>(() => typeof window === "undefined" ? "normal" : (window.localStorage.getItem("uwm-ai-speed") as AiSpeed | null) ?? "normal");
  const [stepRequested, setStepRequested] = useState(false);
  useEffect(() => {
    queueMicrotask(() => {
      const serialized = window.localStorage.getItem(SAVE_KEY);
      if (serialized) {
        try {
          const parsed = JSON.parse(serialized) as GameState;
          assertStateIntegrity(parsed);
          setSavedGame(parsed);
        } catch {
          const archives = JSON.parse(window.localStorage.getItem(ARCHIVE_KEY) ?? "[]") as unknown[];
          archives.push({ archivedAt: Date.now(), serialized });
          window.localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archives.slice(-3)));
          window.localStorage.removeItem(SAVE_KEY);
        }
      }
      setHydrated(true);
    });
    void fetch("/api/owner/session", { cache: "no-store" }).then(async (response) => await response.json() as OwnerStatus).then((status) => setOwner(status)).catch(() => setOwner({ owner: false }));
  }, []);

  useEffect(() => { window.localStorage.setItem("uwm-ai-speed", speed); }, [speed]);

  useEffect(() => {
    if (!game) return;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(game));
  }, [game]);

  useEffect(() => {
    if (!game || game.phase !== "game-over" || !game.telemetryEnabled) return;
    const marker = `uw-monopoly-telemetry-${game.id}-${game.events.length}`;
    if (window.localStorage.getItem(marker)) return;
    window.localStorage.setItem(marker, "pending");
    void fetch("/api/replays", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: game, share: false }) })
      .then((response) => { if (!response.ok) throw new Error("upload failed"); window.localStorage.setItem(marker, "stored"); })
      .catch(() => window.localStorage.removeItem(marker));
  }, [game]);

  const actorId = game ? decisionActor(game) : "";
  const plans = useMemo(() => game && game.phase !== "game-over" ? generateLegalPlans(game, actorId) : [], [game, actorId]);

  useEffect(() => {
    if (!game || game.phase === "game-over") return;
    const actor = game.players.find((player) => player.id === decisionActor(game));
    if (!actor || actor.kind !== "ai") return;
    if (speed === "paused" && !stepRequested) { queueMicrotask(() => setThinking(false)); return; }
    const captured = game;
    const capturedHash = stateHash(captured);
    const candidates = generateLegalPlans(captured, actor.id);
    if (!candidates.length) { queueMicrotask(() => setError(`No legal plan exists for ${actor.name}.`)); return; }
    queueMicrotask(() => setThinking(true));
    const timer = window.setTimeout(async () => {
      let record = chooseLocalPlan(captured, actor.id, candidates, actor.policy);
      let note = "Chosen by the trained local policy. This policy remains available if the live service is unavailable.";
      let usedLive = false;
      if (apiKey || owner.owner) {
        try {
          const response = await fetch("/api/jev/turn-plan", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(apiKey ? { "x-jev-api-key": apiKey } : {}) },
            body: JSON.stringify({
              rulesVersion: captured.rulesVersion,
              policyId: actor.policy,
              decisionType: candidates[0].family,
              publicState: buildPublicDecisionState(captured, actor.id, candidates),
              legalPlans: candidates.map(({ id, label, description }) => ({ id, label, description })),
            }),
          });
          const live = await response.json() as LivePlanResponse;
          if (!response.ok || live.error) throw new Error(live.error || "Live decision failed.");
          if (Object.keys(live.probabilities).some((id) => !candidates.some((plan) => plan.id === id))) throw new Error("JEV returned a stale plan.");
          record = { ...blendWithLiveJev(record, live.probabilities, candidates[0].family), latencyMs: live.latencyMs, specialistProbabilities: live.specialistProbabilities };
          note = `${live.credentialSource === "owner-default" ? "Owner-default" : "Personal-key"} JEV probabilities were calibrated with the local policy in ${live.latencyMs} ms.`;
          usedLive = true;
        } catch (reason) {
          note = `Local fallback used immediately: ${reason instanceof Error ? reason.message : "live decision unavailable"}`;
        }
      }
      const selected = candidates.find((plan) => plan.id === record.planId) ?? candidates[0];
      setGame((current) => {
        if (!current || stateHash(current) !== capturedHash) return current;
        try {
          const next = selected.actions.reduce((state, action) => applyAction(state, actor.id, action), current);
          if (usedLive) next.jevCalls += 1;
          else next.fallbackDecisions += 1;
          return next;
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "The agent decision could not be applied.");
          return current;
        }
      });
      setLastDecision({ actorId: actor.id, actorName: actor.name, plan: selected, record, note });
      setThinking(false);
      setStepRequested(false);
    }, speed === "fast" ? 120 : 900);
    return () => window.clearTimeout(timer);
  }, [game, apiKey, owner.owner, speed, stepRequested]);

  async function unlockOwner(code: string) {
    try {
      const response = await fetch("/api/owner/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const result = await response.json() as OwnerStatus & { error?: string };
      if (!response.ok || !result.owner) return result.error ?? "Owner access could not be unlocked.";
      setOwner(result); return "";
    } catch { return "Owner access could not be unlocked."; }
  }

  async function lockOwner() {
    await fetch("/api/owner/session/lock", { method: "POST" }).catch(() => undefined);
    setOwner({ owner: false });
  }

  function start(options: { mode: "classic" | "short"; name: string; policies: [PolicyId, PolicyId]; telemetry: boolean; apiKey: string }) {
    const specs: PlayerSpec[] = [
      { id: "human", name: options.name, token: "H", kind: "human", policy: "human" },
      { id: "champion", name: "Champion", token: "π", kind: "ai", policy: "champion" },
      { id: "specialist1", name: specialistOptions.find((option) => option.id === options.policies[0])?.label ?? "Builder", token: "▲", kind: "ai", policy: options.policies[0] },
      { id: "specialist2", name: specialistOptions.find((option) => option.id === options.policies[1])?.label ?? "Dealmaker", token: "◆", kind: "ai", policy: options.policies[1] },
    ];
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    if (options.apiKey) window.sessionStorage.setItem("jev-api-key", options.apiKey); else window.sessionStorage.removeItem("jev-api-key");
    setApiKey(options.apiKey); setError(""); setLastDecision(null); setGame(createGame({ seed, mode: options.mode, players: specs, telemetryEnabled: options.telemetry }));
  }

  function applyHumanAction(action: GameAction) {
    if (!game) return;
    try { setError(""); setGame(applyAction(game, "human", action)); setTradeOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "That action is not legal now."); }
  }
  function applyHumanPlan(plan: LegalPlan) {
    if (!game) return;
    try { setError(""); setGame(plan.actions.reduce((state, action) => applyAction(state, "human", action), game)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "That plan is no longer legal."); }
  }

  async function shareReplay() {
    if (!game || game.phase !== "game-over") return;
    setShareStatus("sharing");
    try {
      const response = await fetch("/api/replays", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: game, share: true }) });
      const data = await response.json() as { id?: string; error?: string };
      if (!response.ok || !data.id) throw new Error(data.error || "Replay could not be created.");
      setShareUrl(`${window.location.origin}/replay/${data.id}`); setShareStatus("");
    } catch (reason) { setShareStatus(reason instanceof Error ? reason.message : "Replay could not be created."); }
  }

  if (!hydrated) return <main className="game-shell loading-shell"><LoaderCircle className="spin" /><span>Loading game engine…</span></main>;
  if (!game) return <SetupScreen onStart={start} resumed={savedGame} onResume={() => savedGame && setGame(savedGame)} owner={owner} onUnlock={unlockOwner} onLock={lockOwner} />;

  return <main className="game-shell active-game-shell">
    <GameNav subtitle="LIVE TABLE" onNewGame={() => { setSavedGame(game); setGame(null); setTradeOpen(false); }} />
    <div className="mobile-gate"><ShieldAlert size={30} /><h1>Use a larger screen to continue</h1><p>Your game is safely saved on this device. Interactive play requires a tablet or desktop.</p><div className="mobile-links"><a href="/arena">Decision arena</a><a href="/benchmarks">Benchmarks</a><a href="/privacy">Privacy</a></div></div>
    <div className="game-desktop"><TurnStrip state={game} thinking={thinking} liveAccess={Boolean(apiKey || owner.owner)} lastDecision={lastDecision} /></div>
    <div className="game-workspace game-desktop">
      <div className="board-column"><GameBoard state={game} />{error ? <div className="game-error" role="alert"><ShieldAlert size={16} />{error}<button onClick={() => setError("")}><X size={15} /></button></div> : null}<div className="runtime-strip"><span><Activity size={14} />{game.jevCalls} live JEV calls</span><span><Bot size={14} />{game.fallbackDecisions} local decisions</span><span><Scale size={14} />Rules {game.rulesVersion}</span><span><WalletCards size={14} />Autosaved</span></div></div>
      <aside className="game-sidebar"><DecisionPanel state={game} plans={plans} thinking={thinking} liveAccess={Boolean(apiKey || owner.owner)} lastDecision={lastDecision} onPlan={applyHumanPlan} onOpenTrade={() => setTradeOpen(true)} onShare={shareReplay} shareUrl={shareUrl} shareStatus={shareStatus} speed={speed} onSpeed={setSpeed} onStep={() => setStepRequested(true)} /><div className="secondary-panels"><Standings state={game} /><PropertyManager state={game} onAction={applyHumanAction} /><section className="game-card history-card"><div className="card-title"><History size={16} /><span>Turn history</span><em>{game.events.length} events</em></div><div className="history-list">{turnSummaries(game).map((summary) => <div key={summary.key}><span>{summary.sequence}</span><p><strong>{summary.actor}</strong>{summary.text}</p></div>)}</div></section></div></aside>
    </div>
    {tradeOpen ? <TradeBuilder state={game} onAction={applyHumanAction} onClose={() => setTradeOpen(false)} /> : null}
  </main>;
}
