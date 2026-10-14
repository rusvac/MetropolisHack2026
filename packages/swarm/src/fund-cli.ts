// funds swarm accounts on monad testnet from one swarm account, with monad's reserve rule handled.
// run it from the repo root, so bun loads .env:
//   bun packages/swarm/src/fund-cli.ts --from 0 --to 10-19 --mon 0.05 --usdc 0.5 --top-up
// each transfer links two accounts, and the output counts each one as a direct transfer.
// prints public addresses and explorer links only. never prints the seed or a key
import { parseEther, parseUnits } from "viem";
import { SWARM_CHAINS } from "./chains.ts";
import { fundAccounts } from "./fund.ts";
import type { FundTransfer } from "./fund.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** "10-19" or "5,6,9" */
function parseAccounts(s: string): number[] {
  return s.split(",").flatMap((part) => {
    const [a, b] = part.split("-").map(Number);
    if (b === undefined) return [a!];
    return Array.from({ length: b - a! + 1 }, (_, i) => a! + i);
  });
}

if (import.meta.main) {
  const from = Number(arg("from"));
  const to = parseAccounts(arg("to") ?? "");
  const mon = arg("mon");
  const usdc = arg("usdc");
  if (!Number.isInteger(from) || to.length === 0 || (!mon && !usdc)) {
    console.log("usage: bun packages/swarm/src/fund-cli.ts --from 0 --to 10-19 [--mon 0.05] [--usdc 0.5] [--top-up]");
    process.exit(1);
  }
  const transfers: FundTransfer[] = [];
  for (const i of to) {
    if (mon) transfers.push({ to: i, amount: parseEther(mon) });
    if (usdc) transfers.push({ to: i, amount: parseUnits(usdc, 6), token: SWARM_CHAINS[10143]!.usdc.address });
  }
  const r = await fundAccounts({
    from,
    transfers,
    topUp: process.argv.includes("--top-up"),
    onTx: (tx) => tx.status !== "pending" && console.log(`  ${tx.status} ${tx.url}`),
  });
  for (const t of r.transfers) console.log(`#${t.from.account} -> #${t.to.account} ${t.symbol} ${t.amount}`);
  for (const s of r.skipped) console.log(`#${s.to} already holds enough, skipped`);
  console.log(`direct transfers: ${r.directTransfers}${r.ok ? "" : `. error: ${r.error}`}`);
  process.exit(r.ok ? 0 : 1);
}
