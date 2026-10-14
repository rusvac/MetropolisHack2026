// beat 7: what an observer can link. the largest single move, the correlation score, and the
// count of direct transfers between swarm accounts
import { Meter } from "../components/Meter.tsx";
import { BeatHeader, Card, Label, NetBadge, SimBadge, VenueChip } from "../components/ui.tsx";
import { accountLabel, pct, usd, venue } from "../lib/format.ts";
import { linkability } from "../lib/linkability.ts";
import type { BeatProps } from "./context.ts";

export function ObserverBeat(p: BeatProps) {
  const link = linkability(p.plan, p.moves);
  const m = link.largest.move;
  const what = !m
    ? "no move"
    : m.kind === "bridge"
      ? `bridge ${accountLabel(m.chainId, m.account ?? 0)} → ${accountLabel(10143, m.toAccount ?? 0)}`
      : `slice from ${accountLabel(m.chainId, m.account ?? 0)}`;

  return (
    <section>
      <BeatHeader
        n={7}
        title="What an observer can link"
        lede="Linkability is a number, not a yes or no. Your size is your business: no single transaction shows the full size."
      />

      <Card tone="accent" className="mb-4">
        <div className="flex items-center justify-between">
          <Label>largest single move</Label>
          <div className="flex gap-1.5">
            {m ? <NetBadge chainId={m.quoteChainId} /> : null}
            <SimBadge simulated={m?.simulated ?? true} live="live quotes" />
          </div>
        </div>
        <div className="mt-2 flex items-end gap-4">
          <div>
            <div className="num text-5xl font-semibold tracking-tight text-accent">{pct(link.largest.share, 0)}</div>
            <div className="mt-1 text-xs text-muted">of the {usd(link.total, { cents: false })} {link.totalLabel}</div>
          </div>
          <div className="pb-1">
            <div className="num text-2xl font-semibold text-faint line-through decoration-bad/70">{pct(link.naiveLargest.share, 0)}</div>
            <div className="mt-1 text-xs text-faint">as {link.naiveLargest.label}</div>
          </div>
        </div>
        {m ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-muted">
            <span>{what}</span>
            <VenueChip name={venue(m.venue).name} color={venue(m.venue).color} />
            <span className="num ml-auto">{usd(m.usd, { cents: false })}</span>
          </div>
        ) : null}
      </Card>

      <Card className="mb-4">
        <div className="flex items-center justify-between">
          <Label>correlation score</Label>
          <SimBadge simulated={link.scoreSimulated} live="analyzer" />
        </div>
        <div className="mt-3 space-y-4">
          {link.scores.map((s) => (
            <Meter key={s.label} label={s.label} score={s.score} />
          ))}
        </div>
        <p className="mt-3 text-[11px] text-faint">
          0 to 100. Higher means an observer can tie the accounts together more easily.
          {p.plan.linkability || p.plan.correlation
            ? ` From ${link.scoreSource ?? "the correlation analyzer"}.`
            : " The browser estimates this score from the plan. The server's analyzer replaces it."}
        </p>
      </Card>

      <Card className="mb-4">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className={`num text-3xl font-semibold ${link.directTransfers === 0 ? "text-good" : "text-warn"}`}>{link.directTransfers}</div>
            <Label className="mt-1">direct transfers</Label>
          </div>
          <div>
            <div className="num text-3xl font-semibold">{link.accounts}</div>
            <Label className="mt-1">accounts</Label>
          </div>
          <div>
            <div className="num text-3xl font-semibold">{link.transactions}</div>
            <Label className="mt-1">transactions</Label>
          </div>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          A direct transfer is a transfer from one swarm account straight to another. The planner never plans one. A gas top-up from account 0 counts here.
        </p>
        {link.gasTopUps.length ? (
          <p className="mt-2 text-[13px] text-warn">
            Gas top-ups from m0 to {link.gasTopUps.map((a) => accountLabel(10143, a)).join(", ")}.
          </p>
        ) : null}
      </Card>

      <Card tone="warn">
        <Label className="text-warn">the question</Label>
        <p className="mt-2 text-[15px] font-semibold leading-snug">“If one account funds the swarm, is every account linked onchain?”</p>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">
          No. Funds enter each Monad account through Aurora Intents solvers, not from a swarm account. The one exception is gas: if a Monad account gets
          MON for gas from account 0, that transfer links the two accounts, and the count above includes it.
        </p>
      </Card>
    </section>
  );
}
