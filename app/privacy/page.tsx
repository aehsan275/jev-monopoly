import { Clock3, Database, EyeOff, KeyRound, ShieldCheck } from "lucide-react";
import { GameNav } from "@/app/play-game";

export default function PrivacyPage() {
  return <main className="report-shell privacy-shell"><GameNav subtitle="PRIVACY" />
    <section className="privacy-copy"><span className="overline">PRECISE DATA DISCLOSURE</span><h1>Your key stays in the session.<br />Your game can stay on the device.</h1><p>Gameplay collection is optional and can be disabled before a match. Disabling it does not change the game, the local policy, or live JEV access.</p>
      <div className="privacy-grid"><article><KeyRound /><h2>JevAI access</h2><p>Personal keys stay in browser session storage. Owner access uses a signed, secure cookie while the protected default key remains server-side. Neither key, owner code, nor cookie is written to game data.</p></article><article><Database /><h2>Anonymous match data</h2><p>When enabled, a completed match may store its seed, rules and policy versions, fixed agent roster, structured actions, outcome, timings, and JEV/fallback counts.</p></article><article><EyeOff /><h2>Never stored</h2><p>No API key, owner code, authentication cookie, account identifier, stable device identifier, browser fingerprint, free-form player name, or IP address is placed in application tables.</p></article><article><Clock3 /><h2>Retention</h2><p>Raw match rows and explicit replay links expire after 30 days. Expired rows are deleted during storage activity. Aggregate benchmark statistics can remain without a match-level identifier.</p></article></div>
      <section className="privacy-detail"><ShieldCheck /><div><h2>Replay validation</h2><p>Before any row is accepted, the server recreates the game from its seed and action log. Logs that do not produce the submitted final state are rejected. Shared replay IDs contain 144 bits of cryptographic randomness and reveal only sanitized player labels.</p></div></section>
    </section>
  </main>;
}
