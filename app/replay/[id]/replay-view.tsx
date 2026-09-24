"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight, LoaderCircle, Play, RotateCcw, ShieldAlert, Trophy } from "lucide-react";
import { GameBoard, GameNav } from "@/app/play-game";
import { applyAction, createGame, netWorth } from "@/lib/monopoly/engine";
import { actionLog } from "@/lib/monopoly/replay-validation";
import type { GameState, PlayerSpec } from "@/lib/monopoly/types";

export default function ReplayView({ id }: { id: string }) {
  const [finalState, setFinalState] = useState<GameState | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [error, setError] = useState("");
  const [step, setStep] = useState(0);

  useEffect(() => {
    void fetch(`/api/replays/${id}`).then(async (response) => {
      const data = await response.json() as { state?: GameState; expiresAt?: number; error?: string };
      if (!response.ok || !data.state) throw new Error(data.error || "Replay could not be loaded.");
      setFinalState(data.state); setExpiresAt(data.expiresAt ?? 0); setStep(actionLog(data.state).length);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Replay could not be loaded."));
  }, [id]);

  const snapshots = useMemo(() => {
    if (!finalState) return [];
    const specs: PlayerSpec[] = finalState.players.map(({ id: playerId, name, token, kind, policy }) => ({ id: playerId, name, token, kind, policy }));
    let state = createGame({ seed: finalState.seed, mode: finalState.mode, players: specs, telemetryEnabled: false, createdAt: finalState.createdAt });
    const result = [state];
    for (const entry of actionLog(finalState)) { state = applyAction(state, entry.actorId, entry.action); result.push(state); }
    return result;
  }, [finalState]);

  const state = snapshots[step];

  if (error) return <main className="replay-shell replay-message"><ShieldAlert /><h1>Replay unavailable</h1><p>{error}</p><Link href="/"><ArrowLeft size={15} /> Return to the game</Link></main>;
  if (!state) return <main className="replay-shell replay-message"><LoaderCircle className="spin" /><p>Rebuilding the deterministic match…</p></main>;
  const ranked = [...state.players].sort((a, b) => Number(a.bankrupt) - Number(b.bankrupt) || netWorth(state, b.id) - netWorth(state, a.id));

  return <main className="replay-shell"><GameNav subtitle={`SHARED REPLAY · EXPIRES ${new Date(expiresAt).toLocaleDateString()}`} />
    <div className="replay-layout"><div><GameBoard state={state} /><div className="replay-controls"><button onClick={() => setStep(0)} aria-label="Restart replay"><RotateCcw size={16} /></button><button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} aria-label="Previous action"><ChevronLeft size={18} /></button><input aria-label="Replay position" type="range" min={0} max={snapshots.length - 1} value={step} onChange={(event) => setStep(Number(event.target.value))} /><button onClick={() => setStep(Math.min(snapshots.length - 1, step + 1))} disabled={step === snapshots.length - 1} aria-label="Next action"><ChevronRight size={18} /></button><button onClick={() => setStep(snapshots.length - 1)} aria-label="Jump to result"><Play size={16} /></button><span>{step} / {snapshots.length - 1}</span></div></div>
      <aside className="replay-rail"><span className="overline">DETERMINISTIC REPLAY</span><h1>{state.phase === "game-over" ? `${state.players.find((player) => player.id === state.winnerId)?.name} won` : `Round ${state.round}`}</h1><p>Every frame is regenerated from the public seed and validated action log. Future deck order was hidden until the match ended.</p><div className="replay-rankings">{ranked.map((player, index) => <div key={player.id}><span>{index + 1}</span><strong>{player.name}</strong><em>${player.cash}</em><small>${netWorth(state, player.id)} net worth</small>{player.id === state.winnerId ? <Trophy size={14} /> : null}</div>)}</div><div className="replay-meta"><span>Rules {state.rulesVersion}</span><span>Policy {state.policyVersion}</span><span>{state.mode === "short" ? "Official Short Game" : "Classic"}</span></div></aside>
    </div>
  </main>;
}
