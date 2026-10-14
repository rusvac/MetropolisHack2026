// live balances of the swarm accounts, valued in dollars from prices the caller gives
import { erc20Abi, formatUnits } from "viem";
import type { Address, PublicClient } from "viem";
import type { Holding, Portfolio, Token } from "@spidereum/core";
import { deriveSwarmAccount } from "./addresses.ts";
import { mnemonicFromEnv, publicClient, swarmChain } from "./chains.ts";

/** account indexes: a count (0..n-1) or a list */
export type AccountSet = number | number[];

export interface LoadPortfolioOptions {
  /** usd per whole token, by symbol, for example { MON: 0.03, ETH: 4000, USDC: 1 }. a missing symbol values at 0 */
  prices: Record<string, number>;
  /** accounts per chain: one set for every chain, or one set per chain id. default 10 */
  accounts?: AccountSet | Record<number, AccountSet>;
  /** default: monad testnet (10143) and base sepolia (84532) */
  chains?: number[];
  /** erc-20 tokens to read beside the native token and USDC, per chain id */
  tokens?: Record<number, Token[]>;
  /** keep holdings with a zero balance. default false */
  includeZero?: boolean;
  mnemonic?: string;
  rpcUrls?: Record<number, string>;
  /** tests inject clients here */
  clients?: Record<number, PublicClient>;
}

export const DEFAULT_CHAINS = [10143, 84532];

const multicall3Abi = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

export function accountList(set: AccountSet): number[] {
  return typeof set === "number" ? Array.from({ length: set }, (_, i) => i) : [...set];
}

function accountsFor(chainId: number, accounts: LoadPortfolioOptions["accounts"]): number[] {
  if (accounts === undefined) return accountList(10);
  if (typeof accounts === "number" || Array.isArray(accounts)) return accountList(accounts);
  return accountList(accounts[chainId] ?? 0);
}

/** usd value of an atomic amount */
export function valueUsd(amount: bigint, token: Token, prices: Record<string, number>): number {
  const price = prices[token.symbol] ?? 0;
  if (price === 0 || amount === 0n) return 0;
  return Number(formatUnits(amount, token.decimals)) * price;
}

/** builds the `Portfolio` from raw balances. pure, so the valuation has a unit test */
export function toPortfolio(
  rows: { account: number; token: Token; amount: bigint }[],
  prices: Record<string, number>,
  opts: { includeZero?: boolean; at?: number } = {},
): Portfolio {
  const holdings: Holding[] = rows
    .filter((r) => opts.includeZero || r.amount > 0n)
    .map((r) => ({ account: r.account, token: r.token, amount: r.amount, usd: valueUsd(r.amount, r.token, prices) }));
  const totalUsd = holdings.reduce((s, h) => s + h.usd, 0);
  return { holdings, totalUsd, at: opts.at ?? Date.now() };
}

/** reads one chain in one multicall: the native balance and each token balance of each account */
async function readChain(
  client: PublicClient,
  chainId: number,
  accounts: { index: number; address: Address }[],
  tokens: Token[],
): Promise<{ account: number; token: Token; amount: bigint }[]> {
  const c = swarmChain(chainId);
  const multicall3 = c.chain.contracts?.multicall3?.address;
  if (!multicall3) throw new Error(`${c.name} has no multicall3`);
  const contracts = accounts.flatMap((a) => [
    { address: multicall3, abi: multicall3Abi, functionName: "getEthBalance", args: [a.address] } as const,
    ...tokens.map((t) => ({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [a.address] }) as const),
  ]);
  const results = await client.multicall({ contracts, allowFailure: false });
  const per = 1 + tokens.length;
  return accounts.flatMap((a, i) => [
    { account: a.index, token: c.native, amount: results[i * per] as bigint },
    ...tokens.map((t, j) => ({ account: a.index, token: t, amount: results[i * per + 1 + j] as bigint })),
  ]);
}

/**
 * live balances for the swarm accounts on each chain: the native token and Circle's USDC.
 * every number comes from a live balance. the dollar values come from `prices`
 */
export async function loadPortfolio(opts: LoadPortfolioOptions): Promise<Portfolio> {
  const mnemonic = mnemonicFromEnv(opts.mnemonic);
  const chains = opts.chains ?? DEFAULT_CHAINS;
  const perChain = await Promise.all(
    chains.map(async (chainId) => {
      const c = swarmChain(chainId);
      const accounts = accountsFor(chainId, opts.accounts).map((index) => ({
        index,
        address: deriveSwarmAccount(mnemonic, chainId, index).address,
      }));
      if (accounts.length === 0) return [];
      const client = opts.clients?.[chainId] ?? publicClient(chainId, opts.rpcUrls?.[chainId]);
      try {
        return await readChain(client, chainId, accounts, [c.usdc, ...(opts.tokens?.[chainId] ?? [])]);
      } catch (e) {
        throw new Error(`could not read balances on ${c.name}: ${(e as Error).message.split("\n")[0]}`);
      }
    }),
  );
  return toPortfolio(perChain.flat(), opts.prices, { includeZero: opts.includeZero });
}

/** the swarm addresses per chain, for screens and explorer links. public data only */
export function swarmAddresses(
  accounts: AccountSet,
  chains: number[] = DEFAULT_CHAINS,
  mnemonic?: string,
): { chainId: number; account: number; address: Address }[] {
  const m = mnemonicFromEnv(mnemonic);
  return chains.flatMap((chainId) =>
    accountList(accounts).map((account) => ({ chainId, account, address: deriveSwarmAccount(m, chainId, account).address })),
  );
}

/** one swarm account's address, for `SpotVenue.build` and explorer links. default chain: monad testnet */
export function swarmAddress(account: number, chainId = 10143, mnemonic?: string): Address {
  return deriveSwarmAccount(mnemonicFromEnv(mnemonic), chainId, account).address;
}
