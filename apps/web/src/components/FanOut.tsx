// beat 4 and 5: the plan as a fan-out. one intent on the left, the venues in the middle,
// the swarm accounts on the right. one strand per move. adapted from spidereum-viz NetworkGraph
import { useEffect, useMemo, useRef, useState } from "react";
import type { VenueId } from "@spidereum/core";
import { accountLabel, usdCompact, venue as venueInfo, venueOrder } from "../lib/format.ts";
import type { Move } from "../lib/moves.ts";
import type { MoveStatus } from "../lib/types.ts";

const W = 360;
const X_SRC = 28;
const X_VENUE = 168;
const X_DST = 318;
const GAP = 36;
const PAD = 30;
const MONAD = "#8b7bff";
const BASE = "#3b82f6";


interface P {
  x: number;
  y: number;
}

interface Strand {
  id: string;
  moveId: string;
  from: P;
  to: P;
  bend: number;
  /** an explicit control point, for the gas arcs between two accounts */
  c?: P;
  color: string;
  width: number;
  keys: string[];
  /** when this strand lights up in the loop, 0 to 1 */
  phase: number;
}

function ctrl(a: P, b: P, bend: number, c?: P): P {
  return c ?? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + bend };
}

function pathD(a: P, b: P, bend: number, cp?: P): string {
  const c = ctrl(a, b, bend, cp);
  return `M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`;
}

function pointAt(a: P, b: P, bend: number, t: number, cp?: P): P {
  const c = ctrl(a, b, bend, cp);
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

export interface FanOutProps {
  moves: Move[];
  /** live status per move id, during a run */
  status?: Record<string, MoveStatus | undefined>;
  /** venues that turned off during the run */
  off?: VenueId[];
  /** loop the particles. off during a run: the run drives the strands */
  animate?: boolean;
}

export function FanOut({ moves, status, off = [], animate = true }: FanOutProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const raf = useRef<number | null>(null);

  const layout = useMemo(() => {
    const venues = [...new Set(moves.filter((m) => m.kind !== "gas").map((m) => m.venue))].sort((a, b) => venueOrder(a) - venueOrder(b));
    const base = [...new Set(moves.filter((m) => m.kind === "bridge" && m.account !== undefined).map((m) => m.account!))].sort((a, b) => a - b);
    const monad = [
      ...new Set(
        moves
          .flatMap((m) => (m.kind === "bridge" ? [m.toAccount] : m.kind === "swap" ? [m.account] : m.kind === "gas" ? [m.account, m.toAccount] : []))
          .filter((x): x is number => x !== undefined),
      ),
    ].sort((a, b) => a - b);
    const hasHedge = moves.some((m) => m.kind === "hedge");
    const rightRows = monad.length + (hasHedge ? 1 : 0);
    const leftRows = 1 + base.length;
    const rows = Math.max(rightRows, leftRows, venues.length, 4);
    const H = PAD * 2 + (rows - 1) * GAP + 10;

    const spread = (n: number, i: number) => (n <= 1 ? H / 2 : PAD + 5 + (i * (H - 2 * PAD - 10)) / (n - 1));
    const intentP: P = { x: X_SRC, y: PAD + 8 };
    const baseTop = PAD + 8 + GAP * 1.6;
    const baseStep = base.length <= 1 ? 0 : Math.min(GAP * 1.8, (H - PAD - baseTop) / (base.length - 1));
    const baseP = new Map(base.map((a, i) => [a, { x: X_SRC, y: baseTop + i * baseStep }]));
    const venueP = new Map(venues.map((v, i) => [v, { x: X_VENUE, y: spread(venues.length, i) }]));
    const monadP = new Map(monad.map((a, i) => [a, { x: X_DST, y: PAD + 5 + i * GAP }]));
    const hedgeP: P = { x: X_DST, y: PAD + 5 + monad.length * GAP };

    const venueUsd = new Map<VenueId, number>();
    const venueCount = new Map<VenueId, number>();
    for (const m of moves) {
      if (m.kind === "gas") continue;
      venueUsd.set(m.venue, (venueUsd.get(m.venue) ?? 0) + m.usd);
      venueCount.set(m.venue, (venueCount.get(m.venue) ?? 0) + 1);
    }
    const maxUsd = Math.max(1, ...venueUsd.values());
    const maxDelay = Math.max(1, ...moves.map((m) => m.delayMs));

    const strands: Strand[] = [];
    // the trunk: intent to each venue, as wide as the dollars it routes
    for (const v of venues) {
      if (venueInfo(v).kind === "bridge") continue;
      const info = venueInfo(v);
      strands.push({
        id: `trunk-${v}`,
        moveId: "",
        from: intentP,
        to: venueP.get(v)!,
        bend: 0,
        color: info.color,
        width: 1.5 + 7 * ((venueUsd.get(v) ?? 0) / maxUsd),
        keys: ["intent", `v:${v}`],
        phase: -1,
      });
    }
    const pairCount = new Map<string, number>();
    for (const m of moves) {
      const info = venueInfo(m.venue);
      const phase = m.delayMs / maxDelay;
      if (m.kind === "gas") {
        // a direct transfer between two swarm accounts: an arc outside the account column
        const a = monadP.get(m.account!);
        const b = monadP.get(m.toAccount!);
        if (a && b) {
          const c = { x: X_DST + 14 + Math.min(40, Math.abs(a.y - b.y) / 3), y: (a.y + b.y) / 2 };
          strands.push({ id: m.id, moveId: m.id, from: a, to: b, bend: 0, c, color: "#f87171", width: 1.3, keys: [`a:${m.account}`, `a:${m.toAccount}`], phase });
        }
        continue;
      }
      const vp = venueP.get(m.venue)!;
      if (m.kind === "bridge") {
        const bp = baseP.get(m.account!)!;
        const dp = monadP.get(m.toAccount!)!;
        strands.push({ id: `${m.id}-in`, moveId: m.id, from: bp, to: vp, bend: 0, color: BASE, width: 1.4, keys: [`b:${m.account}`, `v:${m.venue}`, `a:${m.toAccount}`], phase });
        strands.push({ id: `${m.id}-out`, moveId: m.id, from: vp, to: dp, bend: 0, color: info.color, width: 1.4, keys: [`b:${m.account}`, `v:${m.venue}`, `a:${m.toAccount}`], phase });
      } else if (m.kind === "swap") {
        const dp = monadP.get(m.account!)!;
        const pair = `${m.venue}:${m.account}`;
        const k = pairCount.get(pair) ?? 0;
        pairCount.set(pair, k + 1);
        const bend = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 7;
        strands.push({ id: m.id, moveId: m.id, from: vp, to: dp, bend, color: info.color, width: 1.2, keys: [`v:${m.venue}`, `a:${m.account}`], phase });
      } else if (m.kind === "hedge") {
        strands.push({ id: m.id, moveId: m.id, from: vp, to: hedgeP, bend: 0, color: info.color, width: 1.6, keys: [`v:${m.venue}`, "hedge"], phase });
      }
    }
    return { H, venues, base, monad, hasHedge, intentP, baseP, venueP, monadP, hedgeP, venueUsd, venueCount, strands };
  }, [moves]);

  useEffect(() => {
    if (!animate) return;
    if (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let last = 0;
    const loop = (now: number) => {
      if (now - last > 33) {
        setTick(now);
        last = now;
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [animate]);

  const CYCLE = 7000;
  const t = (tick % CYCLE) / CYCLE;
  const lit = (s: Strand) => !selected || s.keys.includes(selected);
  const isOff = (v: VenueId) => off.includes(v);

  const strandStyle = (s: Strand) => {
    const st = s.moveId ? status?.[s.moveId] : undefined;
    let opacity = s.moveId ? 0.42 : 0.22;
    let color = s.color;
    let dash: string | undefined;
    if (status && s.moveId) {
      if (st === "confirmed" || st === "quoted") opacity = 0.95;
      else if (st === "sent") opacity = 0.8;
      else if (st === "failed") color = "#f87171";
      else opacity = 0.18;
      if (st === "quoted") dash = "3 3";
    }
    if (!lit(s)) opacity = 0.06;
    return { opacity, color, dash };
  };

  const particles: { key: string; p: P; color: string }[] = [];
  if (animate && !status) {
    for (const s of layout.strands) {
      if (s.phase < 0 || !lit(s)) continue;
      const start = s.phase * 0.7;
      const isIn = s.id.endsWith("-in");
      const offset = isIn ? -0.12 : 0;
      const local = (t - start - offset) / 0.16;
      if (local >= 0 && local <= 1) particles.push({ key: s.id, p: pointAt(s.from, s.to, s.bend, local, s.c), color: s.color });
    }
  }
  if (status) {
    for (const s of layout.strands) {
      if (!s.moveId || status[s.moveId] !== "sent") continue;
      const local = ((tick % 900) / 900);
      particles.push({ key: s.id, p: pointAt(s.from, s.to, s.bend, local, s.c), color: s.color });
    }
  }

  const sel = (key: string) => () => setSelected((cur) => (cur === key ? null : key));

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${layout.H}`} className="block w-full select-none" role="img" aria-label="the plan as a fan-out of moves over venues and accounts">
        <defs>
          <pattern id="fan-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#ffffff08" strokeWidth="0.6" />
          </pattern>
          <filter id="fan-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect width={W} height={layout.H} fill="url(#fan-grid)" onClick={() => setSelected(null)} />

        <text x={X_SRC} y={12} textAnchor="middle" className="fill-[#6c6c82] text-[8.5px] uppercase tracking-wider">from</text>
        <text x={X_VENUE} y={12} textAnchor="middle" className="fill-[#6c6c82] text-[8.5px] uppercase tracking-wider">venue</text>
        <text x={X_DST} y={12} textAnchor="middle" className="fill-[#6c6c82] text-[8.5px] uppercase tracking-wider">account</text>

        {layout.strands.map((s) => {
          const st = strandStyle(s);
          return (
            <path
              key={s.id}
              d={pathD(s.from, s.to, s.bend, s.c)}
              fill="none"
              stroke={st.color}
              strokeWidth={s.width}
              strokeOpacity={st.opacity}
              strokeDasharray={st.dash}
              strokeLinecap="round"
              style={{ transition: "stroke-opacity 300ms, stroke 300ms" }}
            />
          );
        })}

        {particles.map((p) => (
          <circle key={p.key} cx={p.p.x} cy={p.p.y} r={2.6} fill={p.color} filter="url(#fan-glow)" />
        ))}

        {/* the intent */}
        <g onClick={sel("intent")} className="cursor-pointer">
          <circle cx={layout.intentP.x} cy={layout.intentP.y} r={17} fill="#8b7bff22" stroke={MONAD} strokeWidth={1.5} filter="url(#fan-glow)" />
          <circle cx={layout.intentP.x} cy={layout.intentP.y} r={4} fill={MONAD} />
          <text x={layout.intentP.x} y={layout.intentP.y + 29} textAnchor="middle" className="fill-[#a1a1b5] text-[9.5px]">intent</text>
        </g>

        {/* base accounts */}
        {layout.base.map((a) => {
          const p = layout.baseP.get(a)!;
          const dim = selected && selected !== `b:${a}` && !layout.strands.some((s) => s.keys.includes(`b:${a}`) && s.keys.includes(selected));
          return (
            <g key={`b${a}`} onClick={sel(`b:${a}`)} className="cursor-pointer" opacity={dim ? 0.3 : 1}>
              <circle cx={p.x} cy={p.y} r={13} fill="#3b82f622" stroke={BASE} strokeWidth={1.4} />
              <text x={p.x} y={p.y + 3} textAnchor="middle" className={`fill-white font-mono font-semibold ${a >= 10 ? "text-[8px]" : "text-[9.5px]"}`}>
                {accountLabel(84532, a)}
              </text>
            </g>
          );
        })}

        {/* venues */}
        {layout.venues.map((v) => {
          const p = layout.venueP.get(v)!;
          const info = venueInfo(v);
          const down = isOff(v);
          const dim = selected && !layout.strands.some((s) => s.keys.includes(`v:${v}`) && s.keys.includes(selected)) && selected !== `v:${v}`;
          return (
            <g key={v} onClick={sel(`v:${v}`)} className="cursor-pointer" opacity={dim ? 0.3 : down ? 0.45 : 1}>
              <rect x={p.x - 60} y={p.y - 18} width={120} height={36} rx={10} fill="#0e0e15" stroke={down ? "#f87171" : info.color} strokeWidth={selected === `v:${v}` ? 2 : 1.2} />
              <circle cx={p.x - 48} cy={p.y} r={3.5} fill={down ? "#f87171" : info.color} />
              <text x={p.x - 40} y={p.y - 2} className="fill-[#ececf3] text-[11px] font-semibold">{info.name.length > 16 ? `${info.name.slice(0, 15)}…` : info.name}</text>
              <text x={p.x - 40} y={p.y + 11} className="fill-[#a1a1b5] text-[9px]">
                {down
                  ? "off · re-routed"
                  : `${layout.venueCount.get(v)} ${info.kind === "bridge" ? "bridges" : info.kind === "perp" ? "short" : "slices"} · ${usdCompact(layout.venueUsd.get(v) ?? 0)}`}
              </text>
              {down ? <line x1={p.x - 60} y1={p.y} x2={p.x + 60} y2={p.y} stroke="#f87171" strokeWidth={1.2} /> : null}
            </g>
          );
        })}

        {/* monad accounts */}
        {layout.monad.map((a) => {
          const p = layout.monadP.get(a)!;
          const dim = selected && selected !== `a:${a}` && !layout.strands.some((s) => s.keys.includes(`a:${a}`) && s.keys.includes(selected));
          return (
            <g key={`m${a}`} onClick={sel(`a:${a}`)} className="cursor-pointer" opacity={dim ? 0.3 : 1}>
              <circle cx={p.x} cy={p.y} r={13} fill="#8b7bff22" stroke={MONAD} strokeWidth={selected === `a:${a}` ? 2 : 1.3} />
              <text x={p.x} y={p.y + 3} textAnchor="middle" className={`fill-white font-mono font-semibold ${a >= 10 ? "text-[8px]" : "text-[9.5px]"}`}>
                {accountLabel(10143, a)}
              </text>
            </g>
          );
        })}
        {layout.hasHedge ? (
          <g onClick={sel("hedge")} className="cursor-pointer">
            <rect x={layout.hedgeP.x - 20} y={layout.hedgeP.y - 11} width={40} height={22} rx={7} fill="#fbbf2422" stroke="#fbbf24" strokeWidth={1.2} />
            <text x={layout.hedgeP.x} y={layout.hedgeP.y + 3} textAnchor="middle" className="fill-[#fbbf24] text-[9.5px] font-semibold">short</text>
          </g>
        ) : null}
      </svg>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: BASE }} /> base account</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: MONAD }} /> monad account</span>
        <span>tap a node to trace it</span>
      </div>
    </div>
  );
}
