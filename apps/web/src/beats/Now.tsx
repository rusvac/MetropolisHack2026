// beat 2: the portfolio now. holdings per account and per chain, in dollars
import type { Holding } from "@spidereum/core";
import { AllocationBar, Legend, symbolColor } from "../components/Bars.tsx";
import { AccountDot, AddressLink, BeatHeader, Card, Label, NetBadge, SimBadge } from "../components/ui.tsx";
import { accountLabel, amount, network, pct, toUnits, usd } from "../lib/format.ts";
import { chainTotals, symbolTotals } from "../lib/moves.ts";
import type { BeatProps } from "./context.ts";

export function NowBeat(p: BeatProps) {
  const before = p.plan.before;
  const bySym = symbolTotals(before);
  const byChain = chainTotals(before);
  const groups = new Map<string, Holding[]>();
  for (const h of before.holdings) {
    if (h.usd <= 0 && h.amount === 0n) continue;
    const key = `${h.token.chainId}:${h.account}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const accounts = [...groups.entries()]
    .map(([key, hs]) => ({ key, chainId: hs[0]!.token.chainId, account: hs[0]!.account, hs, usd: hs.reduce((s, h) => s + h.usd, 0) }))
    .sort((a, b) => b.usd - a.usd);
  const sim = p.balancesSimulated;

  return (
    <section>
      <BeatHeader n={2} title="The portfolio now" lede="Holdings per account and per chain, in dollars. The funds start as USDC on Base and a little MON on Monad." />
      <Card tone="accent" className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label>total</Label>
            <div className="num mt-1 text-4xl font-semibold tracking-tight">{usd(before.totalUsd, { cents: false })}</div>
          </div>
          <SimBadge simulated={sim} live="live balances" />
        </div>
        <div className="mt-4">
          <AllocationBar parts={bySym} total={before.totalUsd} />
          <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted">
            {Object.entries(bySym).map(([s, v]) => (
              <span key={s} className="num inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: symbolColor(s) }} />
                {s} {usd(v, { cents: false })} · {pct(v / (before.totalUsd || 1), 0)}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {Object.entries(byChain).map(([c, v]) => (
            <div key={c} className="rounded-xl border border-line bg-raised px-3 py-2">
              <NetBadge chainId={Number(c)} />
              <div className="num mt-1 text-lg font-semibold">{usd(v, { cents: false })}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="mb-2 flex items-center justify-between">
        <Label>per account</Label>
        <Legend symbols={Object.keys(bySym)} />
      </div>
      <div className="space-y-3">
        {[...new Set(accounts.map((a) => a.chainId))].map((chainId) => {
          const list = accounts.filter((a) => a.chainId === chainId);
          return (
            <Card key={chainId} className="p-3">
              <div className="mb-2 flex items-center justify-between px-1">
                <NetBadge chainId={chainId} />
                <span className="num text-sm font-semibold">{usd(byChain[chainId] ?? 0, { cents: false })}</span>
              </div>
              <ul className="grid grid-cols-2 gap-2">
                {list.map((a) => {
                  const addr = p.addressOf(a.chainId, a.account);
                  return (
                    <li key={a.key} className="min-w-0 rounded-xl border border-line bg-raised p-2.5">
                      <div className="flex items-center gap-2">
                        <AccountDot label={accountLabel(a.chainId, a.account)} color={network(a.chainId).color} size={26} />
                        <div className="num min-w-0 truncate text-[15px] font-semibold">{usd(a.usd, { cents: a.usd < 100 })}</div>
                      </div>
                      <div className="mt-1.5 space-y-0.5">
                        {a.hs.map((h) => (
                          <div key={h.token.symbol} className="num flex items-center gap-1.5 text-xs text-muted">
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: symbolColor(h.token.symbol) }} />
                            {amount(toUnits(h.amount, h.token.decimals))} {h.token.symbol}
                          </div>
                        ))}
                      </div>
                      {addr ? (
                        <div className="mt-1 truncate">
                          <AddressLink chainId={a.chainId} address={addr} />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          );
        })}
      </div>
      {sim ? (
        <p className="mt-3 text-xs text-warn">
          These balances are simulated{p.plan.sources?.balances?.note ? `: ${p.plan.sources.balances.note}` : ""}. Live balances come from Monad testnet and Base
          Sepolia.
        </p>
      ) : (
        <p className="mt-3 text-xs text-faint">Balances read live from Monad testnet and Base Sepolia. Dollar values use mainnet prices.</p>
      )}
    </section>
  );
}
