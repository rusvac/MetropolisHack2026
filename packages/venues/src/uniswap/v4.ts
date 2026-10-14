// uniswap v4 on monad mainnet (143): read-only quotes from the v4 Quoter. no build, so a quote-only venue.
// addresses from https://developers.uniswap.org/docs/protocols/v4/deployments.md (Monad: 143)
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { monad, type QuoteRequest, type SpotVenue, type Token } from "@spidereum/core";

export const UNISWAP_V4_MONAD = {
  chainId: 143,
  poolManager: "0x188d586ddcf52439676ca21a244753fa19f9ea8e",
  quoter: "0xa222dd357a9076d1091ed6aa2e16c9742dd26891",
  stateView: "0x77395f3b2e73ae90843717371294fa97cc419d64",
  universalRouter: "0x0d97dc33264bfc1c226207428a79b26757fb9dc3",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const satisfies Record<string, Address | number>;

/** circle's USDC and wrapped MON on monad mainnet. v4 pools use native MON (address 0) */
export const MONAD_MAINNET_TOKENS = {
  MON: { chainId: 143, symbol: "MON", address: zeroAddress, decimals: 18 },
  USDC: { chainId: 143, symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 },
  WMON: { chainId: 143, symbol: "WMON", address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", decimals: 18 },
} as const satisfies Record<string, Token>;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  /** lp fee in hundredths of a bip: 500 = 0.05% */
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** the standard v4 fee tiers, each with its usual tick spacing, no hooks */
export const STANDARD_TIERS: readonly { fee: number; tickSpacing: number }[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];

/**
 * the MON/USDC pool with the most liquidity on monad mainnet, found on 13 oct 2026 by a scan of
 * hookless keys through StateView: liquidity 8.12e18, 1 MON = 0.0244 USDC, 1,000 USDC in = 40,936 MON out.
 * pool id 0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954
 */
export const MON_USDC_POOL: PoolKey = {
  currency0: zeroAddress,
  currency1: MONAD_MAINNET_TOKENS.USDC.address,
  fee: 500,
  tickSpacing: 10,
  hooks: zeroAddress,
};

export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

export const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

/**
 * the v4 currency for a token. MON and WMON map to native MON (address 0), because the deep pools are native.
 * USDC maps to circle's USDC on mainnet, whatever chain the token comes from. any other token on chain 143
 * keeps its address
 */
export function v4Currency(token: Token): Address {
  const sym = token.symbol.toUpperCase();
  if (sym === "MON" || sym === "WMON") return zeroAddress;
  if (sym === "USDC") return MONAD_MAINNET_TOKENS.USDC.address;
  if (token.chainId === 143) return token.address;
  throw new Error(`uniswap-v4: no monad mainnet currency for ${token.symbol} on chain ${token.chainId}`);
}

/** the candidate keys for a pair, sorted the way v4 sorts currencies */
export function candidateKeys(a: Address, b: Address, tiers = STANDARD_TIERS): PoolKey[] {
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return tiers.map((t) => ({ currency0, currency1, fee: t.fee, tickSpacing: t.tickSpacing, hooks: zeroAddress }));
}

/**
 * gas the quoter does not count: the 21,000 intrinsic cost plus the universal router, settle, and take.
 * an estimate, from typical v4 single-hop swaps through the universal router
 */
export const ROUTER_OVERHEAD_GAS = 21_000n + 60_000n;

export interface UniswapVenueOptions {
  /** a client on monad mainnet (143). default: a client on MONAD_RPC_URL */
  client?: PublicClient;
  /** quote only these pools. default: the four standard tiers for the pair, best output wins */
  pools?: PoolKey[];
  /** how long quote() keeps using the best pool it found for a pair before it scans the tiers again. default 5 min */
  poolTtlMs?: number;
}

export interface UniswapQuoteDetail {
  key: PoolKey;
  amountOut: bigint;
  gasEstimate: bigint;
}

export function createUniswapVenue(opts: UniswapVenueOptions = {}): SpotVenue & {
  quoteAll(req: QuoteRequest): Promise<UniswapQuoteDetail[]>;
} {
  const client: PublicClient =
    opts.client ??
    (createPublicClient({ chain: monad, transport: http(process.env.MONAD_RPC_URL, { batch: true }) }) as PublicClient);
  const poolTtlMs = opts.poolTtlMs ?? 5 * 60_000;
  /** the best pool per pair, so a router that quotes many small chunks makes one call per chunk, not four */
  const bestPool = new Map<string, { key: PoolKey; at: number }>();

  async function quoteKey(key: PoolKey, sell: Address, amountIn: bigint): Promise<UniswapQuoteDetail> {
    const zeroForOne = key.currency0.toLowerCase() === sell.toLowerCase();
    const { result } = await client.simulateContract({
      address: UNISWAP_V4_MONAD.quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
    });
    return { key, amountOut: result[0], gasEstimate: result[1] };
  }

  async function quoteAll(req: QuoteRequest): Promise<UniswapQuoteDetail[]> {
    const sell = v4Currency(req.sell);
    const buy = v4Currency(req.buy);
    if (sell === buy) throw new Error("uniswap-v4: sell and buy are the same currency");
    const keys =
      opts.pools?.filter(
        (k) => (k.currency0 === sell && k.currency1 === buy) || (k.currency0 === buy && k.currency1 === sell),
      ) ?? candidateKeys(sell, buy);
    const results = await Promise.allSettled(keys.map((key) => quoteKey(key, sell, req.amountIn)));
    const sorted = results
      .filter((r): r is PromiseFulfilledResult<UniswapQuoteDetail> => r.status === "fulfilled")
      .map((r) => r.value)
      .sort((x, y) => (y.amountOut > x.amountOut ? 1 : y.amountOut < x.amountOut ? -1 : 0));
    if (sorted[0] && sorted[0].amountOut > 0n) bestPool.set(`${sell}>${buy}`, { key: sorted[0].key, at: Date.now() });
    return sorted;
  }

  async function best(req: QuoteRequest): Promise<UniswapQuoteDetail | undefined> {
    const sell = v4Currency(req.sell);
    const cached = bestPool.get(`${sell}>${v4Currency(req.buy)}`);
    if (cached && Date.now() - cached.at < poolTtlMs) {
      try {
        const q = await quoteKey(cached.key, sell, req.amountIn);
        if (q.amountOut > 0n) return q;
      } catch {
        // the cached pool failed for this size: scan every tier
      }
    }
    return (await quoteAll(req))[0];
  }

  return {
    id: "uniswap-v4",
    kind: "spot",
    quoteAll,
    async quote(req: QuoteRequest) {
      const top = await best(req);
      if (!top || top.amountOut === 0n) {
        throw new Error(`uniswap-v4: no pool on monad mainnet quotes ${req.sell.symbol} to ${req.buy.symbol}`);
      }
      return {
        venue: "uniswap-v4",
        sell: req.sell,
        buy: req.buy,
        amountIn: req.amountIn,
        amountOut: top.amountOut,
        // v4 fee unit is a hundredth of a bip
        feeBps: top.key.fee / 100,
        gasUnits: top.gasEstimate + ROUTER_OVERHEAD_GAS,
        simulated: false,
        at: Date.now(),
      };
    },
  };
}
