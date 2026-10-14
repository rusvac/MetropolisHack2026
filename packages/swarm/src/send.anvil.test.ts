// sendSlice and fundAccounts against a local anvil chain with monad testnet's chain id. no network, no real seed.
// anvil does not apply monad's reserve rule, so the test checks the 3-block gap instead. runs with SWARM_ANVIL=1:
//   SWARM_ANVIL=1 bun test packages/swarm/src/send.anvil.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestClient, http, parseEther } from "viem";
import type { Address, Hex } from "viem";
import type { TxRequest } from "@spidereum/core";
import { english, generateMnemonic } from "viem/accounts";
import { monadTestnet } from "@spidereum/core";
import { deriveSwarmAccount } from "./addresses.ts";
import { publicClient } from "./chains.ts";
import { correlationScore } from "./correlation/index.ts";
import { fundAccounts } from "./fund.ts";
import { sendSlice } from "./send.ts";

const enabled = process.env.SWARM_ANVIL === "1";
const PORT = 18545;
const rpcUrl = `http://127.0.0.1:${PORT}`;
const mnemonic = generateMnemonic(english);
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
let anvil: ReturnType<typeof Bun.spawn> | undefined;

describe.skipIf(!enabled)("send on anvil", () => {
  beforeAll(async () => {
    anvil = Bun.spawn(["anvil", "--port", String(PORT), "--chain-id", "10143", "--block-time", "1"], { stdout: "ignore", stderr: "ignore" });
    const test = createTestClient({ mode: "anvil", chain: monadTestnet, transport: http(rpcUrl) });
    for (let i = 0; i < 50; i++) {
      try {
        await test.setBalance({ address: deriveSwarmAccount(mnemonic, 10143, 4).address, value: parseEther("1") });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("anvil did not start");
  });
  afterAll(() => anvil?.kill());

  test("fundAccounts sends each transfer, 3 blocks apart, and counts each one", async () => {
    const r = await fundAccounts({ mnemonic, rpcUrl, from: 4, transfers: [5, 6, 7].map((to) => ({ to, amount: parseEther("0.1") })) });
    expect(r.ok).toBe(true);
    expect(r.directTransfers).toBe(3);
    expect(r.txs.map((t) => t.nonce)).toEqual([0, 1, 2]);
    for (let i = 1; i < 3; i++) expect(r.txs[i]!.blockNumber! - r.txs[i - 1]!.blockNumber!).toBeGreaterThanOrEqual(3n);
    const bal = await publicClient(10143, rpcUrl).getBalance({ address: deriveSwarmAccount(mnemonic, 10143, 6).address });
    expect(bal).toBe(parseEther("0.1"));
    const score = correlationScore({ transfers: r.transfers });
    expect(score.links).toBe(1);
    expect(score.clusters[0]).toHaveLength(4);
  }, 60_000);

  test("topUp skips an account that already holds enough", async () => {
    const r = await fundAccounts({ mnemonic, rpcUrl, from: 4, topUp: true, transfers: [{ to: 5, amount: parseEther("0.1") }, { to: 8, amount: parseEther("0.05") }] });
    expect(r.ok).toBe(true);
    expect(r.skipped.map((s) => s.to)).toEqual([5]);
    expect(r.transfers.map((t) => t.to.account)).toEqual([8]);
  }, 60_000);

  test("two slices from one account at once: distinct nonces, in call order, one receipt at a time", async () => {
    const tx = (n: number): TxRequest => ({ to: DEAD, data: `0x${n.toString(16).padStart(8, "0")}` as Hex, value: 0n });
    const [a, b] = await Promise.all([
      sendSlice({ account: 5 }, [tx(1), tx(2)], { mnemonic, rpcUrl }),
      sendSlice({ account: 5 }, [tx(3)], { mnemonic, rpcUrl }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect([...a.txs, ...b.txs].map((t) => t.nonce)).toEqual([0, 1, 2]);
    expect(a.txs[1]!.blockNumber!).toBeGreaterThan(a.txs[0]!.blockNumber!);
  }, 60_000);

  test("a transaction that cannot pay stops the slice", async () => {
    const r = await sendSlice({ account: 9 }, [{ to: DEAD, data: "0x", value: 1n }], { mnemonic, rpcUrl });
    expect(r.ok).toBe(false);
    expect(r.error).toStartWith("tx 0 not sent");
  }, 30_000);
});
