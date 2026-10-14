import { describe, expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi, parseUnits } from "viem";
import { english, generateMnemonic } from "viem/accounts";
import { deriveSwarmAccount } from "./addresses.ts";
import { NATIVE, SWARM_CHAINS, txUrl } from "./chains.ts";
import { fundAccounts, fundTx } from "./fund.ts";
import { swarmAddresses, toPortfolio } from "./portfolio.ts";
import { pickNonce, withAccountLock } from "./send.ts";

// a throwaway seed, made fresh per run. never the swarm's seed
const mnemonic = generateMnemonic(english);

describe("accounts", () => {
  test("no address appears on both chains", () => {
    const rows = swarmAddresses(10, [10143, 84532], mnemonic);
    const monad = new Set(rows.filter((r) => r.chainId === 10143).map((r) => r.address));
    const base = rows.filter((r) => r.chainId === 84532).map((r) => r.address);
    expect(monad.size).toBe(10);
    for (const a of base) expect(monad.has(a)).toBe(false);
  });

  test("testnet and mainnet share a path", () => {
    expect(deriveSwarmAccount(mnemonic, 10143, 3).address).toBe(deriveSwarmAccount(mnemonic, 143, 3).address);
    expect(deriveSwarmAccount(mnemonic, 84532, 3).address).toBe(deriveSwarmAccount(mnemonic, 8453, 3).address);
  });
});

describe("toPortfolio", () => {
  const { native, usdc } = SWARM_CHAINS[10143]!;
  const rows = [
    { account: 0, token: native, amount: parseUnits("2.5", 18) },
    { account: 0, token: usdc, amount: parseUnits("20", 6) },
    { account: 1, token: usdc, amount: 0n },
  ];

  test("values each holding from the price of its symbol", () => {
    const p = toPortfolio(rows, { MON: 0.04, USDC: 1 }, { at: 1 });
    expect(p.holdings).toHaveLength(2);
    expect(p.holdings[0]!.usd).toBeCloseTo(0.1, 9);
    expect(p.holdings[1]!.usd).toBe(20);
    expect(p.totalUsd).toBeCloseTo(20.1, 9);
  });

  test("a symbol with no price values at 0", () => {
    expect(toPortfolio(rows, { USDC: 1 }).totalUsd).toBe(20);
  });

  test("includeZero keeps empty holdings", () => {
    expect(toPortfolio(rows, {}, { includeZero: true }).holdings).toHaveLength(3);
  });
});

describe("transactions", () => {
  test("a native transfer carries the value", () => {
    const to = deriveSwarmAccount(mnemonic, 10143, 5).address;
    expect(fundTx(to, 7n)).toEqual({ to, data: "0x", value: 7n });
    expect(fundTx(to, 7n, NATIVE)).toEqual({ to, data: "0x", value: 7n });
  });

  test("a token transfer calls transfer on the token", () => {
    const to = deriveSwarmAccount(mnemonic, 10143, 5).address;
    const usdc = SWARM_CHAINS[10143]!.usdc.address;
    const tx = fundTx(to, 1_000_000n, usdc);
    expect(tx.to).toBe(usdc);
    expect(tx.value).toBe(0n);
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(call.functionName).toBe("transfer");
    expect(call.args).toEqual([to, 1_000_000n]);
  });

  test("explorer links", () => {
    expect(txUrl(10143, "0xabc")).toBe("https://testnet.monadexplorer.com/tx/0xabc");
    expect(txUrl(84532, "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
  });

  test("fundAccounts refuses a transfer to the sender", async () => {
    await expect(fundAccounts({ mnemonic, from: 4, transfers: [{ to: 4, amount: 1n }] })).rejects.toThrow("cannot fund itself");
  });
});

describe("nonces", () => {
  test("the next nonce never goes back", () => {
    expect(pickNonce(5, undefined)).toBe(5);
    expect(pickNonce(5, 7)).toBe(7); // the rpc lags behind this process
    expect(pickNonce(9, 7)).toBe(9); // another process sent from the account
  });

  test("one account's sends run one after another, in call order", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) =>
      withAccountLock("test:acct", async () => {
        log.push(`${name} start`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name} end`);
      });
    await Promise.all([job("a", 30), job("b", 1), job("c", 10)]);
    expect(log).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
  });

  test("two accounts do not wait for each other", async () => {
    const log: string[] = [];
    const job = (key: string, ms: number) =>
      withAccountLock(key, async () => {
        await new Promise((r) => setTimeout(r, ms));
        log.push(key);
      });
    await Promise.all([job("test:slow", 30), job("test:fast", 1)]);
    expect(log).toEqual(["test:fast", "test:slow"]);
  });
});
