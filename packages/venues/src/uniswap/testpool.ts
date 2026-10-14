// the test pool on monad testnet (10143): spidereum's own constant-product pool of native MON against
// circle's testnet USDC. uniswap v4 has no monad testnet deployment, so this pool is the second executing venue.
// every number from it comes from the test pool, and its venue id says so: "test-pool"
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import {
  monadTestnet,
  type Intent,
  type QuoteRequest,
  type Slice,
  type SpotVenue,
  type Token,
  type TxRequest,
} from "@spidereum/core";
import { testPoolAbi } from "./pool/artifact.ts";
import { TEST_POOL_DEPLOYMENT } from "./pool/deployment.ts";

export const TEST_POOL_VENUE_ID = "test-pool" as const;

/** the tokens of the test pool. MON is native, so its address is 0 */
export const TEST_POOL_TOKENS = {
  MON: { chainId: 10143, symbol: "MON", address: zeroAddress, decimals: 18 },
  USDC: { chainId: 10143, symbol: "USDC", address: "0x534b2f3a21130d7a60830c2df862319e593943a3", decimals: 6 },
} as const satisfies Record<string, Token>;

/** fee of the deployed pool, in basis points. the contract stores it as an immutable */
export const TEST_POOL_FEE_BPS = 30;

/**
 * gas per transaction, from the live swaps on monad testnet on 13 oct 2026 (index.live.test.ts).
 * monad charges the gas limit, and its receipts report it. a USDC sale also needs the approval, which build() puts first
 */
export const TEST_POOL_GAS = {
  monForUsdc: 114_000n,
  usdcForMon: 470_000n,
  approve: 88_000n,
} as const;

const NATIVE_ALIASES = new Set(["0x0000000000000000000000000000000000000000", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]);

/** which side of the pool a token is. by symbol first, so mainnet tokens from a plan map to the testnet pool */
export function testPoolSide(token: Token): "MON" | "USDC" {
  const sym = token.symbol.toUpperCase();
  if (sym === "MON" || sym === "WMON") return "MON";
  if (sym === "USDC") return "USDC";
  const addr = token.address.toLowerCase();
  if (NATIVE_ALIASES.has(addr)) return "MON";
  if (addr === TEST_POOL_TOKENS.USDC.address) return "USDC";
  throw new Error(`test pool: trades MON and USDC only, not ${token.symbol}`);
}

export function monIn(sell: Token, buy: Token): boolean {
  const s = testPoolSide(sell);
  if (s === testPoolSide(buy)) throw new Error("test pool: sell and buy are the same token");
  return s === "MON";
}

/** constant product with the fee on the amount in. the same math as TestPool.getAmountOut */
export function testPoolAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps = TEST_POOL_FEE_BPS): bigint {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const inAfterFee = amountIn * BigInt(10_000 - feeBps);
  return (inAfterFee * reserveOut) / (reserveIn * 10_000n + inAfterFee);
}

/** the least output a slice accepts: its expected output less the intent's slippage */
export function minOut(expectedOut: bigint, maxSlippageBps: number): bigint {
  return (expectedOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;
}

export interface TestPoolVenueOptions {
  /** a client on monad testnet (10143). default: a client on MONAD_TESTNET_RPC_URL */
  client?: PublicClient;
  /** the pool contract. default: the deployed address in pool/deployment.ts */
  address?: Address;
}

export interface TestPoolState {
  address: Address;
  reserveMon: bigint;
  reserveUsdc: bigint;
  /** USDC per MON at the reserves, before fees */
  midPrice: number;
}

export function createTestPoolVenue(opts: TestPoolVenueOptions = {}): SpotVenue & {
  address: Address;
  state(): Promise<TestPoolState>;
} {
  const found = opts.address ?? TEST_POOL_DEPLOYMENT.address;
  if (!found) throw new Error("test pool: no address. deploy with pool/deploy.ts or pass { address }");
  const address: Address = found;
  const client: PublicClient =
    opts.client ??
    (createPublicClient({ chain: monadTestnet, transport: http(process.env.MONAD_TESTNET_RPC_URL) }) as PublicClient);

  async function state(): Promise<TestPoolState> {
    const [reserveMon, reserveUsdc] = await client.readContract({ address, abi: testPoolAbi, functionName: "getReserves" });
    const midPrice = reserveMon === 0n ? 0 : Number(reserveUsdc) / 1e6 / (Number(reserveMon) / 1e18);
    return { address, reserveMon, reserveUsdc, midPrice };
  }

  return {
    id: TEST_POOL_VENUE_ID,
    kind: "spot",
    address,
    state,
    async quote(req: QuoteRequest) {
      const isMonIn = monIn(req.sell, req.buy);
      const amountOut = await client.readContract({
        address,
        abi: testPoolAbi,
        functionName: "getAmountOut",
        args: [req.amountIn, isMonIn],
      });
      return {
        venue: TEST_POOL_VENUE_ID,
        sell: req.sell,
        buy: req.buy,
        amountIn: req.amountIn,
        amountOut,
        feeBps: TEST_POOL_FEE_BPS,
        gasUnits: isMonIn ? TEST_POOL_GAS.monForUsdc : TEST_POOL_GAS.approve + TEST_POOL_GAS.usdcForMon,
        // a live contract on monad testnet: the reserves are real, the pool is ours
        simulated: false,
        at: Date.now(),
      };
    },
    async build(slice: Slice, intent: Intent, account: Address): Promise<TxRequest[]> {
      const least = minOut(slice.expectedOut, intent.maxSlippageBps);
      if (monIn(intent.sell, intent.buy)) {
        return [
          {
            to: address,
            data: encodeFunctionData({ abi: testPoolAbi, functionName: "swapMonForUsdc", args: [least, account] }),
            value: slice.amountIn,
          },
        ];
      }
      // an exact approval each slice, so slices built ahead of time from one account still settle in order
      return [
        {
          to: TEST_POOL_TOKENS.USDC.address,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [address, slice.amountIn] }),
          value: 0n,
        },
        {
          to: address,
          data: encodeFunctionData({
            abi: testPoolAbi,
            functionName: "swapUsdcForMon",
            args: [slice.amountIn, least, account],
          }),
          value: 0n,
        },
      ];
    },
  };
}
