// beat 4: the plan. the moves as a fan-out, and next to it the naive version with both costs
import { FanOut } from "../components/FanOut.tsx";
import { BeatHeader, Card, Label, NetBadge, SimBadge, VenueChip } from "../components/ui.tsx";
import { accountLabel, amount, pct, seconds, toUnits, usd, venue } from "../lib/format.ts";
import { linkability } from "../lib/linkability.ts";
import { prices, type Move } from "../lib/moves.ts";
import type { BeatProps } from "./context.ts";

/** assumptions for the gas comparison. shown on screen next to the numbers */
const MONAD_GWEI = 100;
const ETH_GWEI = 2;
const ETH_USD = 3500;

function MoveRow({ m }: { m: Move }) {
  const v = venue(m.venue);
  const from = m.account === undefined ? "" : accountLabel(m.chainId, m.account);
  const to = m.toAccount === undefined ? "" : ` → ${accountLabel(m.toChainId ?? 10143, m.toAccount)}`;
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="w-14 shrink-0 font-mono text-[11px] text-faint">+{seconds(m.delayMs)}</span>
      <span className="w-16 shrink-0 font-mono text-xs">{m.kind === "hedge" ? "short" : `${from}${to}`}</span>
      <VenueChip name={v.name} color={v.color} />
      <span className="num ml-auto text-right text-xs text-muted">
        {m.kind === "hedge" ? `${amount(m.amountIn)} ${m.symbolIn}` : `${amount(m.amountIn)} ${m.symbolIn} → ${amount(m.amountOut)} ${m.symbolOut}`}
      </span>
    </li>
  );
}

export function PlanBeat(p: BeatProps) {
  const { plan, moves } = p;
  const link = linkability(plan, moves);
  const px = prices(plan);
  const bridges = moves.filter((m) => m.kind === "bridge");
  const slices = moves.filter((m) => m.kind === "swap");
  const hedge = moves.find((m) => m.kind === "hedge");
  const anySim = moves.some((m) => m.simulated) || plan.swaps.some((s) => s.baseline.simulated);
  const saved = plan.naiveCostUsd - plan.costUsd;
  const quoteChain = plan.swaps[0]?.baseline.sell.chainId ?? 143;

  const gwei = plan.sources?.gas?.gwei ?? MONAD_GWEI;
  const gasUnits = plan.swaps.reduce((s, sw) => s + Number(sw.gasUnits), 0);
  const monadGasUsd = gasUnits * gwei * 1e-9 * (px.MON ?? 0);
  const costs = plan.costs;
  const src = plan.sources;
  const ethGasUsd = gasUnits * ETH_GWEI * 1e-9 * ETH_USD;
  const window = Math.max(0, ...moves.map((m) => m.delayMs));
  const naiveTx = (bridges.length ? 1 : 0) + plan.swaps.length + (hedge ? 1 : 0);

  return (
    <section>
      <BeatHeader
        n={4}
        title="The plan"
        lede={
          <>
            {bridges.length} bridges, {slices.length} slices{hedge ? ", and one short" : ""}. {link.venues} venues, {link.accounts} accounts. Each move has
            an account and a delay.
          </>
        }
      />

      <Card className="mb-4 px-2 pt-3 pb-3">
        <div className="mb-1 flex items-center justify-between px-2">
          <Label>route</Label>
          <div className="flex gap-1.5">
            <NetBadge chainId={quoteChain} />
            <SimBadge simulated={anySim} live="live quotes" />
          </div>
        </div>
        <FanOut moves={moves} />
      </Card>

      <Card tone="good" className="mb-4">
        <div className="flex items-center justify-between">
          <Label>split vs one trade</Label>
          <div className="flex gap-1.5">
            <NetBadge chainId={quoteChain} />
            <SimBadge simulated={anySim} live="live quotes" />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-2.5 text-sm">
          <div />
          <div className="text-right text-xs font-semibold text-accent">split</div>
          <div className="text-right text-xs font-semibold text-muted">one trade</div>

          {plan.swaps.map((s, i) => {
            const split = toUnits(s.expectedOut, s.intent.buy.decimals);
            const one = toUnits(s.baseline.amountOut, s.baseline.buy.decimals);
            return (
              <div key={i} className="contents">
                <div className="text-muted">
                  {s.intent.buy.symbol} out
                  <div className="text-[11px] text-faint">best single venue: {venue(s.baseline.venue).name}</div>
                </div>
                <div className="num text-right font-semibold">{amount(split, 0)}</div>
                <div className="num text-right text-muted">{amount(one, 0)}</div>
              </div>
            );
          })}
          {costs ? (
            <>
              <div className="pl-3 text-[13px] text-faint">bridge fees</div>
              <div className="num text-right text-[13px] text-muted">{usd(costs.split.bridgeUsd)}</div>
              <div className="num text-right text-[13px] text-faint">{usd(costs.naive.bridgeUsd)}</div>
              <div className="pl-3 text-[13px] text-faint">price impact + venue fees</div>
              <div className="num text-right text-[13px] text-muted">{usd(costs.split.swapUsd)}</div>
              <div className="num text-right text-[13px] text-faint">{usd(costs.naive.swapUsd)}</div>
              <div className="pl-3 text-[13px] text-faint">gas</div>
              <div className="num text-right text-[13px] text-muted">{usd(costs.split.gasUsd)}</div>
              <div className="num text-right text-[13px] text-faint">{usd(costs.naive.gasUsd)}</div>
            </>
          ) : null}
          <div className="text-muted">Cost, all in</div>
          <div className="num text-right font-semibold">{usd(plan.costUsd)}</div>
          <div className="num text-right text-muted">{usd(plan.naiveCostUsd)}</div>

          <div className="text-muted">Largest transaction</div>
          <div className="num text-right font-semibold">{pct(link.largest.share, 0)}</div>
          <div className="num text-right text-muted">{pct(link.naiveLargest.share, 0)}</div>

          <div className="text-muted">Transactions</div>
          <div className="num text-right font-semibold">{moves.length}</div>
          <div className="num text-right text-muted">{naiveTx}</div>

          <div className="text-muted">Accounts</div>
          <div className="num text-right font-semibold">{link.accounts}</div>
          <div className="num text-right text-muted">1</div>
        </div>
        <div className={`mt-4 rounded-xl px-3 py-2.5 text-[15px] font-semibold ${saved >= 0 ? "bg-good/10 text-good" : "bg-warn/10 text-warn"}`}>
          {saved >= 0 ? `The split saves ${usd(saved)}` : `The split costs ${usd(-saved)} more`}
          <span className="font-normal text-muted"> after fees and gas</span>
        </div>
        <p className="mt-2 text-[11px] text-faint">Cost = venue fees + price impact + bridge fees + gas, in dollars, from the quotes.</p>
      </Card>

      <Card className="mb-4">
        <div className="flex items-center justify-between">
          <Label>why monad</Label>
          <SimBadge simulated />
        </div>
        {saved > 0 && ethGasUsd > saved ? (
          <p className="mt-2 text-[15px] font-semibold">
            On Ethereum, the gas for {slices.length} slices costs more than the split saves.
          </p>
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
            <div className="text-xs text-muted">{slices.length} slices on Monad</div>
            <div className="num mt-1 text-xl font-semibold text-accent">{usd(monadGasUsd)}</div>
            <div className="text-[11px] text-faint">gas · plan runs in {seconds(window)}</div>
          </div>
          <div className="rounded-xl border border-line bg-raised p-3">
            <div className="text-xs text-muted">the same on Ethereum</div>
            <div className="num mt-1 text-xl font-semibold">{usd(ethGasUsd)}</div>
            <div className="text-[11px] text-faint">gas · 12 s blocks</div>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-faint">
          {gasUnits.toLocaleString("en-US")} gas from the plan. {gwei} gwei on Monad{src?.gas?.note ? ` (${src.gas.note})` : ""}. Assumes {ETH_GWEI} gwei and ETH
          at {usd(ETH_USD, { cents: false })} on Ethereum. 400 ms blocks on Monad.
        </p>
      </Card>

      {src ? (
        <Card className="mb-4">
          <Label>where the numbers come from</Label>
          <ul className="mt-2 space-y-1.5 text-[13px]">
            {(
              [
                ["quotes", src.venues],
                ["prices", src.prices],
                ["balances", src.balances],
                ["execution", src.executor],
              ] as const
            ).map(([k, v]) =>
              v ? (
                <li key={k} className="flex items-start gap-2">
                  <span className="w-[72px] shrink-0 text-faint">{k}</span>
                  <span className="min-w-0 flex-1 text-muted">{v.note}</span>
                  <SimBadge simulated={v.simulated} />
                </li>
              ) : null,
            )}
            {src.planner ? (
              <li className="flex items-start gap-2">
                <span className="w-[72px] shrink-0 text-faint">planner</span>
                <span className="min-w-0 flex-1 text-muted">{src.planner}</span>
              </li>
            ) : null}
          </ul>
        </Card>
      ) : null}

      <Card>
        <details>
          <summary className="flex cursor-pointer list-none items-center justify-between">
            <Label>all {moves.length} moves</Label>
            <span className="text-xs text-accent">show</span>
          </summary>
          <ul className="mt-2 divide-y divide-line">
            {moves.map((m) => (
              <MoveRow key={m.id} m={m} />
            ))}
          </ul>
        </details>
      </Card>
    </section>
  );
}
