// beat 3: the intent. target weights, the hedge ratio, and the privacy weight, in one sentence
import type { RebalanceIntent } from "@spidereum/core";
import { BeatHeader, Button, Card, Label, NetBadge, SimBadge } from "../components/ui.tsx";
import { pct, usd } from "../lib/format.ts";
import { symbolTotals } from "../lib/moves.ts";
import type { BeatProps } from "./context.ts";

function words(i: RebalanceIntent): string {
  const mon = Math.round((i.targets.find((t) => t.symbol === "MON")?.weight ?? 0) * 100);
  const h = i.hedgeRatio ?? 0;
  const hedge = h === 0 ? "" : h === 0.5 ? ", with half the MON hedged" : h === 1 ? ", with all the MON hedged" : `, with ${Math.round(h * 100)}% of the MON hedged`;
  return `Get me to ${mon}% MON and ${100 - mon}% USDC${hedge}.`;
}

function Slider({
  label,
  value,
  onChange,
  left,
  right,
  shown,
  color = "#8b7bff",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  left: string;
  right: string;
  shown: string;
  color?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium">{label}</div>
        <div className="num text-lg font-semibold" style={{ color }}>
          {shown}
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        style={{ ["--fill" as string]: `${value * 100}%`, ["--track-fill" as string]: color }}
        aria-label={label}
      />
      <div className="flex justify-between text-[11px] text-faint">
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}

export function IntentBeat(p: BeatProps) {
  const i = p.intent;
  const mon = i.targets.find((t) => t.symbol === "MON")?.weight ?? 0.7;
  const setMon = (w: number) =>
    p.setIntent({
      ...i,
      targets: [
        { symbol: "MON", weight: w },
        { symbol: "USDC", weight: Math.round((1 - w) * 100) / 100 },
      ],
    });
  const total = p.plan.before.totalUsd;
  const monNow = symbolTotals(p.plan.before).MON ?? 0;
  const need = total * mon - monNow;
  const hedgeUsd = total * mon * (i.hedgeRatio ?? 0);

  return (
    <section>
      <BeatHeader n={3} title="The intent" lede="One sentence. The spider turns it into target weights, a hedge, and a privacy weight." />
      <Card tone="accent" className="mb-4">
        <Label>you say</Label>
        <p className="mt-2 text-[22px] font-semibold leading-snug tracking-tight">“{words(i)}”</p>
      </Card>

      <Card className="space-y-5">
        <Slider label="MON target" value={mon} onChange={setMon} left="0% MON" right="100% MON" shown={`${pct(mon, 0)} / ${pct(1 - mon, 0)}`} />
        <Slider
          label="Hedge"
          value={i.hedgeRatio ?? 0}
          onChange={(v) => p.setIntent({ ...i, hedgeRatio: v })}
          left="no short"
          right="short all the MON"
          shown={pct(i.hedgeRatio ?? 0, 0)}
          color="#fbbf24"
        />
        <Slider
          label="Privacy weight"
          value={i.privacyWeight}
          onChange={(v) => p.setIntent({ ...i, privacyWeight: v })}
          left="cheapest plan"
          right="smallest largest slice"
          shown={i.privacyWeight.toFixed(2)}
          color="#34d3b4"
        />
      </Card>

      <Card className="mt-4">
        <Label>what that means</Label>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <NetBadge chainId={10143} />
          <NetBadge chainId={84532} />
          <SimBadge simulated={p.balancesSimulated} live="live balances" />
        </div>
        <ul className="mt-3 space-y-2 text-[15px]">
          <li className="flex justify-between gap-3">
            <span className="text-muted">MON now</span>
            <span className="num">
              {usd(monNow, { cents: false })} · {pct(monNow / (total || 1), 0)}
            </span>
          </li>
          <li className="flex justify-between gap-3">
            <span className="text-muted">MON to buy</span>
            <span className="num font-semibold text-accent">{usd(Math.max(0, need), { cents: false })}</span>
          </li>
          <li className="flex justify-between gap-3">
            <span className="text-muted">Short on Perpl</span>
            <span className="num font-semibold text-warn">{usd(hedgeUsd, { cents: false })}</span>
          </li>
        </ul>
      </Card>

      <Button className="mt-5 w-full" onClick={p.replan} disabled={p.planning}>
        {p.planning ? "Routing…" : "Route it"}
      </Button>
      <p className="mt-2 text-center text-xs text-faint">quotes come from Monad and Base mainnet, read-only. execution runs on testnet.</p>
    </section>
  );
}
