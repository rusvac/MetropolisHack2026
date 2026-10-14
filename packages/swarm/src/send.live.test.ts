// sends real transactions on monad testnet from swarm accounts 4 to 9, the accounts lane L7 owns.
// it costs gas, so it runs only with LIVE=1 (`bun run test:live`) or SWARM_LIVE=1:
//   SWARM_LIVE=1 bun test packages/swarm/src/send.live.test.ts
import { describe, expect, test } from "bun:test";
import { encodeFunctionData, erc20Abi, formatEther, parseEther } from "viem";
import type { Address } from "viem";
import type { TxRequest } from "@spidereum/core";
import { deriveSwarmAccount } from "./addresses.ts";
import { publicClient, SWARM_CHAINS } from "./chains.ts";
import { correlationScore } from "./correlation/index.ts";
import { directTransferLog, fundAccounts } from "./fund.ts";
import { loadPortfolio } from "./portfolio.ts";
import { sendSlice } from "./send.ts";
import type { SentTx } from "./send.ts";

const live = (process.env.LIVE === "1" || process.env.SWARM_LIVE === "1") && !!process.env.BURNER_MNEMONIC?.trim();

const FUNDER = 4;
const RECEIVERS = [5, 6, 7, 8, 9];
const GAS = parseEther("0.03");
const USDC = SWARM_CHAINS[10143]!.usdc.address;
/** kuru's router on monad testnet, as an approval target. approvals of 0 and 1 move no funds */
const SPENDER: Address = "0x7EFbE105Ca7415dE98F96622173458ac1c054630";
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

const approve = (amount: bigint): TxRequest => ({
  to: USDC,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SPENDER, amount] }),
  value: 0n,
});

const log = (tx: SentTx) => {
  if (tx.status !== "pending") console.log(`  tx ${tx.index} nonce ${tx.nonce} ${tx.status} block ${tx.blockNumber} ${tx.url}`);
};

describe.skipIf(!live)("live on monad testnet", () => {
  test("fundAccounts tops up accounts 5 to 9 from account 4, and counts each transfer", async () => {
    const r = await fundAccounts({
      from: FUNDER,
      transfers: RECEIVERS.map((to) => ({ to, amount: GAS })),
      topUp: true,
      onTx: log,
    });
    if (!r.ok) console.log("  error:", r.error);
    expect(r.ok).toBe(true);
    expect(r.transfers.length + r.skipped.length).toBe(RECEIVERS.length);
    expect(r.directTransfers).toBe(r.transfers.length);
    expect(directTransferLog().length).toBeGreaterThanOrEqual(r.transfers.length);
    for (const t of r.transfers) console.log(`  direct transfer #${t.from.account} -> #${t.to.account} ${formatEther(t.amount)} ${t.symbol} ${t.url}`);

    // consecutive value transfers from one account sit at least 3 blocks apart (monad's reserve rule)
    const blocks = r.txs.map((t) => t.blockNumber!);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i]! - blocks[i - 1]!).toBeGreaterThanOrEqual(3n);

    const client = publicClient(10143);
    const mnemonic = process.env.BURNER_MNEMONIC!.trim();
    for (const i of RECEIVERS) {
      const bal = await client.getBalance({ address: deriveSwarmAccount(mnemonic, 10143, i).address });
      expect(bal).toBeGreaterThanOrEqual(GAS);
    }

    // the funding links the accounts: beat 7 counts it
    const p = await loadPortfolio({ accounts: { 10143: [FUNDER, ...RECEIVERS] }, chains: [10143], prices: { MON: 0.03, USDC: 1 } });
    const score = correlationScore({ portfolio: p, transfers: r.transfers });
    console.log(`  correlation ${score.score} (links ${score.links}, patterns ${score.patterns}): ${score.explanation}`);
    if (r.transfers.length === RECEIVERS.length) expect(score.score).toBe(1);
  }, 180_000);

  test("sendSlice sends a slice's transactions in order from account 5, one receipt at a time", async () => {
    // approve, approve, then a value transfer of 1 wei: the last one must wait out the reserve window
    const r = await sendSlice({ account: 5 }, [approve(0n), approve(1n), { to: DEAD, data: "0x", value: 1n }], { onTx: log });
    if (!r.ok) console.log("  error:", r.error);
    expect(r.ok).toBe(true);
    expect(r.txs).toHaveLength(3);
    expect(r.txs.every((t) => t.status === "success")).toBe(true);
    expect(r.txs.map((t) => t.nonce)).toEqual([r.txs[0]!.nonce, r.txs[0]!.nonce + 1, r.txs[0]!.nonce + 2]);
    expect(r.txs[1]!.blockNumber!).toBeGreaterThan(r.txs[0]!.blockNumber!);
    expect(r.txs[2]!.blockNumber! - r.txs[1]!.blockNumber!).toBeGreaterThanOrEqual(3n);
    for (const t of r.txs) expect(t.url).toStartWith("https://testnet.monadexplorer.com/tx/0x");
  }, 120_000);

  test("two slices from account 6 at once get distinct nonces, in order", async () => {
    const [a, b] = await Promise.all([
      sendSlice({ account: 6 }, [approve(2n)], { onTx: log }),
      sendSlice({ account: 6 }, [approve(3n)], { onTx: log }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(b.txs[0]!.nonce).toBe(a.txs[0]!.nonce + 1);
  }, 120_000);

  test("a reverting transaction stops the slice and reports it", async () => {
    // transfer 1 USDC from account 7, which holds none: the estimate fails, so nothing more is sent
    const r = await sendSlice(
      { account: 7 },
      [
        { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [DEAD, 1_000_000n] }), value: 0n },
        approve(4n),
      ],
      { onTx: log },
    );
    console.log("  error:", r.error);
    expect(r.ok).toBe(false);
    expect(r.error).toStartWith("tx 0");
    expect(r.txs).toHaveLength(0);
  }, 60_000);
});
