// beat 1: the swarm. accounts from one seed, on monad and on base. no address on both chains
import { AccountDot, AddressLink, BeatHeader, Card, Label, NetBadge } from "../components/ui.tsx";
import { accountLabel, network } from "../lib/format.ts";
import type { BeatProps } from "./context.ts";

function involved(p: BeatProps, chainIds: number[]): number[] {
  const set = new Set<number>();
  for (const h of [...p.plan.before.holdings, ...p.plan.after.holdings]) if (chainIds.includes(h.token.chainId)) set.add(h.account);
  for (const m of p.moves) {
    if (m.account !== undefined && chainIds.includes(m.chainId)) set.add(m.account);
    if (m.toAccount !== undefined && m.toChainId !== undefined && chainIds.includes(m.toChainId)) set.add(m.toAccount);
  }
  return [...set].sort((a, b) => a - b);
}

export function SwarmBeat(p: BeatProps) {
  const monad = involved(p, [10143, 143]);
  const base = involved(p, [84532, 8453]);
  const monadAddrs = monad.map((i) => p.addressOf(10143, i)).filter(Boolean) as string[];
  const baseAddrs = base.map((i) => p.addressOf(84532, i)).filter(Boolean) as string[];
  const shared = monadAddrs.filter((a) => baseAddrs.some((b) => b.toLowerCase() === a.toLowerCase())).length;
  const haveAddrs = monadAddrs.length + baseAddrs.length > 0;

  const column = (chainId: number, list: number[]) => (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="font-semibold">{network(chainId).name}</div>
        <NetBadge chainId={chainId} />
      </div>
      <ul className="grid grid-cols-2 gap-2">
        {list.map((i) => {
          const addr = p.addressOf(chainId, i);
          return (
            <li key={i} className="flex min-w-0 items-center gap-2 rounded-xl border border-line bg-raised px-2 py-2">
              <AccountDot label={accountLabel(chainId, i)} color={network(chainId).color} size={30} />
              <div className="min-w-0">
                {addr ? <AddressLink chainId={chainId} address={addr} /> : <span className="text-xs text-faint">account {i}</span>}
                {chainId === 10143 && i === 0 ? <div className="text-[10px] text-faint">treasury, pays gas</div> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );

  return (
    <section>
      <BeatHeader
        n={1}
        title="The swarm"
        lede="One seed derives every account. Monad accounts and Base accounts use different derivation paths, so no address appears on both chains."
      />
      <Card className="mb-4 grid grid-cols-3 gap-3 text-center">
        <div>
          <div className="num text-3xl font-semibold text-accent">{monad.length}</div>
          <Label className="mt-1">monad accounts</Label>
        </div>
        <div>
          <div className="num text-3xl font-semibold text-[#3b82f6]">{base.length}</div>
          <Label className="mt-1">base accounts</Label>
        </div>
        <div>
          <div className={`num text-3xl font-semibold ${shared === 0 ? "text-good" : "text-bad"}`}>{haveAddrs ? shared : "–"}</div>
          <Label className="mt-1">on both chains</Label>
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        {column(10143, monad)}
        {column(84532, base)}
      </div>
      <p className="mt-4 font-mono text-[11px] leading-relaxed text-faint">
        monad m/44'/60'/0'/0/i · base m/44'/60'/1'/0/i. the seed stays on the server. this page sees public addresses only.
      </p>
    </section>
  );
}
