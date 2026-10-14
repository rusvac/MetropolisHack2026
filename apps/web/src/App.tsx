// spidereum: one intent, routed as slices over monad venues and the swarm's accounts.
// seven beats, one per screen. the data is one RebalancePlan from apps/server (or the fixture)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RebalanceIntent, VenueId } from "@spidereum/core";
import { AfterBeat } from "./beats/After.tsx";
import type { BeatProps } from "./beats/context.ts";
import { ExecuteBeat } from "./beats/Execute.tsx";
import { IntentBeat } from "./beats/Intent.tsx";
import { NowBeat } from "./beats/Now.tsx";
import { ObserverBeat } from "./beats/Observer.tsx";
import { PlanBeat } from "./beats/Plan.tsx";
import { SwarmBeat } from "./beats/Swarm.tsx";
import { Button, Card } from "./components/ui.tsx";
import { execute, getPlan, sourcePref, type PlanResult, type RunHandle, type SourcePref } from "./lib/client.ts";
import { defaultIntent } from "./lib/fixture.ts";
import { planMoves } from "./lib/moves.ts";
import { IDLE, reduce, startState, type RunState } from "./lib/run.ts";
import type { Address } from "./lib/types.ts";

const BEATS = [
  { n: 1, name: "swarm", View: SwarmBeat },
  { n: 2, name: "now", View: NowBeat },
  { n: 3, name: "intent", View: IntentBeat },
  { n: 4, name: "plan", View: PlanBeat },
  { n: 5, name: "execute", View: ExecuteBeat },
  { n: 6, name: "after", View: AfterBeat },
  { n: 7, name: "observer", View: ObserverBeat },
] as const;

function beatFromHash(): number {
  const n = Number(location.hash.replace("#", ""));
  return n >= 1 && n <= 7 ? n : 1;
}

function Logo() {
  return (
    <svg viewBox="0 0 64 64" className="h-7 w-7" aria-hidden>
      <g fill="none" stroke="#8b7bff" strokeWidth="2.5" strokeLinecap="round">
        <circle cx="32" cy="32" r="7" />
        <circle cx="32" cy="32" r="15" opacity=".7" />
        <circle cx="32" cy="32" r="23" opacity=".4" />
        <path d="M32 5v54M5 32h54M13 13l38 38M51 13 13 51" opacity=".55" />
      </g>
      <circle cx="32" cy="32" r="4" fill="#8b7bff" />
    </svg>
  );
}

export function App() {
  const [beat, setBeat] = useState(beatFromHash);
  const [pref, setPref] = useState<SourcePref>(sourcePref);
  const [intent, setIntent] = useState<RebalanceIntent>(defaultIntent);
  const [res, setRes] = useState<PlanResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<RunState>(IDLE);
  const handle = useRef<RunHandle | null>(null);

  const go = useCallback((n: number) => {
    const b = Math.min(7, Math.max(1, n));
    setBeat(b);
    if (location.hash !== `#${b}`) history.replaceState(null, "", `#${b}`);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  const load = useCallback(
    async (i: RebalanceIntent, p: SourcePref, next?: number) => {
      setPlanning(true);
      setError(null);
      try {
        const r = await getPlan(i, p);
        handle.current?.stop();
        setRun(IDLE);
        setRes(r);
        if (next) go(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPlanning(false);
      }
    },
    [go],
  );

  useEffect(() => {
    void load(intent, pref);
    // the first plan only. later plans come from the intent screen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onHash = () => setBeat(beatFromHash());
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
      if (e.key === "ArrowRight") go(beatFromHash() + 1);
      if (e.key === "ArrowLeft") go(beatFromHash() - 1);
    };
    addEventListener("hashchange", onHash);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
    };
  }, [go]);

  useEffect(() => () => handle.current?.stop(), []);

  // swipe left and right between beats, on a phone
  const touch = useRef<{ x: number; y: number; skip: boolean } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const el = e.target as HTMLElement;
    touch.current = t ? { x: t.clientX, y: t.clientY, skip: !!el.closest("input, svg, a, button, details") } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current;
    const t = e.changedTouches[0];
    touch.current = null;
    if (!s || !t || s.skip) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) go(beat + (dx < 0 ? 1 : -1));
  };

  const plan = res?.plan;
  const moves = useMemo(() => (plan ? planMoves(plan) : []), [plan]);
  const addressOf = useCallback(
    (chainId: number, index: number): Address | undefined => {
      const c = chainId === 143 ? 10143 : chainId === 8453 ? 84532 : chainId;
      return plan?.accounts?.find((a) => a.chainId === c && a.index === index)?.address;
    },
    [plan],
  );

  const startRun = useCallback(
    (dropVenue?: VenueId) => {
      if (!plan || !res) return;
      handle.current?.stop();
      setRun(startState(moves));
      handle.current = execute(plan, res.source, { dropVenue }, (e) => setRun((s) => reduce(s, e)));
    },
    [plan, res, moves],
  );

  const stopRun = useCallback(() => {
    handle.current?.stop();
    handle.current = null;
    setRun((s) => (s.status === "running" ? { ...s, status: "error", endedAt: Date.now() } : IDLE));
  }, []);

  const venueOffNow = useCallback((v: VenueId) => handle.current?.venueOff(v), []);

  const switchSource = () => {
    const next: SourcePref = res?.source === "server" ? "fixture" : "server";
    setPref(next);
    const url = new URL(location.href);
    url.searchParams.set("source", next);
    history.replaceState(null, "", url);
    void load(intent, next);
  };

  const current = BEATS[beat - 1]!;
  const props: BeatProps | null =
    plan && res
      ? {
          plan,
          moves,
          source: res.source,
          balancesSimulated: res.source === "fixture" || plan.balancesSimulated === true,
          addressOf,
          intent,
          setIntent,
          planning,
          replan: () => void load(intent, pref, 4),
          run,
          startRun,
          stopRun,
          venueOffNow,
          go,
        }
      : null;

  return (
    <div className="mx-auto flex min-h-dvh max-w-[520px] flex-col">
      <header className="web-bg sticky top-0 z-20 border-b border-line bg-bg/85 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3 backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Logo />
            <span className="text-[17px] font-semibold tracking-tight">spidereum</span>
          </div>
          <button
            type="button"
            onClick={switchSource}
            title="switch between the server and the browser fixture"
            className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium ${
              res?.source === "server" ? "border-good/40 bg-good/10 text-good" : "border-warn/40 bg-warn/10 text-warn"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${res?.source === "server" ? "bg-good" : "bg-warn"}`} />
            {res ? (res.source === "server" ? "server" : "fixture · simulated") : "loading"}
          </button>
        </div>
        <nav className="no-scrollbar mt-3 flex gap-1 overflow-x-auto" aria-label="beats">
          {BEATS.map((b) => (
            <button
              key={b.n}
              type="button"
              onClick={() => go(b.n)}
              className={`group flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1 ${b.n === beat ? "text-ink" : "text-faint"}`}
              aria-current={b.n === beat ? "step" : undefined}
            >
              <span className={`h-1 w-full rounded-full transition ${b.n === beat ? "bg-accent" : b.n < beat ? "bg-accent/40" : "bg-line"}`} />
              <span className="text-[10px] font-medium">{b.name}</span>
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1 px-4 pt-5 pb-28" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {res?.note ? (
          <div className="mb-4 rounded-xl border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
            Showing the browser fixture: every number is simulated. {res.note}.
          </div>
        ) : null}
        {error ? (
          <Card tone="warn" className="mb-4">
            <div className="text-sm text-warn">{error}</div>
            <div className="mt-3 flex gap-2">
              <Button variant="ghost" className="h-10 text-sm" onClick={() => void load(intent, pref)}>
                Try again
              </Button>
              <Button variant="ghost" className="h-10 text-sm" onClick={() => { setPref("fixture"); void load(intent, "fixture"); }}>
                Use the fixture
              </Button>
            </div>
          </Card>
        ) : null}
        {props ? <current.View {...props} /> : !error ? <div className="py-20 text-center text-muted">Routing…</div> : null}
      </main>

      <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[520px] items-center gap-3 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          <Button variant="ghost" className="w-14 px-0" onClick={() => go(beat - 1)} disabled={beat === 1}>
            ←
          </Button>
          <Button className="flex-1" onClick={() => go(beat + 1)} disabled={beat === 7}>
            {beat === 7 ? "The end" : `${BEATS[beat]!.n}. ${BEATS[beat]!.name} →`}
          </Button>
        </div>
      </footer>
    </div>
  );
}
