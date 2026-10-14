// aurora intents asset ids for the bridge leg: usdc on base into monad.
// ids come from the live token list, GET https://intents-api.aurora.dev/api/tokens/{apiKey},
// and the "supported assets" table at https://docs.intents.aurora.dev/llms-full.txt
import type { Address } from "viem";
import type { Token } from "@spidereum/core";

export interface AuroraAsset {
  assetId: string;
  /** aurora's chain name, as the token list spells it */
  blockchain: string;
  symbol: string;
  decimals: number;
  /** undefined for the chain's native coin */
  contractAddress?: Address;
  stable: boolean;
}

export const AURORA_ASSETS = {
  baseUsdc: {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    blockchain: "base",
    symbol: "USDC",
    decimals: 6,
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    stable: true,
  },
  baseEth: {
    assetId: "nep141:base.omft.near",
    blockchain: "base",
    symbol: "ETH",
    decimals: 18,
    stable: false,
  },
  monadMon: {
    assetId: "nep245:v2_1.omni.hot.tg:143_11111111111111111111",
    blockchain: "monad",
    symbol: "MON",
    decimals: 18,
    stable: false,
  },
  monadUsdc: {
    assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
    blockchain: "monad",
    symbol: "USDC",
    decimals: 6,
    contractAddress: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    stable: true,
  },
  monadUsdt0: {
    assetId: "nep245:v2_1.omni.hot.tg:143_4EJiJxSALvGoTZbnc8K7Ft9533et",
    blockchain: "monad",
    symbol: "USDT0",
    decimals: 6,
    contractAddress: "0xe7cd86e13ac4309349f30b3435a9d337750fc82d",
    stable: true,
  },
} as const satisfies Record<string, AuroraAsset>;

const ALL: AuroraAsset[] = Object.values(AURORA_ASSETS);

/** the native coin on monad mainnet, as a core `Token`. aurora delivers it as plain MON, not wrapped */
export const MONAD_MON: Token = {
  chainId: 143,
  symbol: "MON",
  address: "0x0000000000000000000000000000000000000000",
  decimals: 18,
};

/** usdc on monad mainnet (circle's native usdc), as a core `Token` */
export const MONAD_USDC: Token = {
  chainId: 143,
  symbol: "USDC",
  address: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
  decimals: 6,
};

const NATIVE_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

/** chain names and ids a caller may put in `bridgeIn.fromChain`, mapped to aurora's name */
const CHAIN_ALIASES: Record<string, string> = {
  base: "base",
  "8453": "base",
  "eip155:8453": "base",
  // a testnet source still gets a mainnet quote: the plan's numbers use real liquidity
  "base-sepolia": "base",
  "base sepolia": "base",
  basesepolia: "base",
  "84532": "base",
  "eip155:84532": "base",
  monad: "monad",
  "143": "monad",
  "10143": "monad",
};

/** chain id to aurora's chain name. testnets map to their mainnet, so the quote uses mainnet liquidity */
const CHAIN_ID_TO_BLOCKCHAIN: Record<number, string> = {
  8453: "base",
  84532: "base",
  143: "monad",
  10143: "monad",
};

export function auroraChainName(chain: string): string | undefined {
  return CHAIN_ALIASES[chain.trim().toLowerCase()];
}

/** the origin asset for `bridgeIn`: an aurora asset id, a symbol, or a contract address on the chain */
export function resolveOriginAsset(fromChain: string, fromToken: string): AuroraAsset | undefined {
  const token = fromToken.trim();
  if (token.startsWith("nep141:") || token.startsWith("nep245:") || token.startsWith("1cs_v1:")) {
    return ALL.find((a) => a.assetId === token);
  }
  const blockchain = auroraChainName(fromChain);
  if (!blockchain) return undefined;
  return findAsset(blockchain, token);
}

/** the destination asset for a core `Token` on monad (mainnet or testnet), by address first, then by symbol */
export function resolveDestinationAsset(to: Token): AuroraAsset | undefined {
  const blockchain = CHAIN_ID_TO_BLOCKCHAIN[to.chainId];
  if (!blockchain) return undefined;
  // on mainnet the address is exact. on testnet the addresses differ, so the symbol decides
  if (to.chainId === 143 || to.chainId === 8453) {
    const byAddress = findAsset(blockchain, to.address);
    if (byAddress) return byAddress;
  }
  if (NATIVE_ADDRESSES.has(to.address.toLowerCase())) {
    return ALL.find((a) => a.blockchain === blockchain && a.contractAddress === undefined);
  }
  return findAsset(blockchain, to.symbol);
}

function findAsset(blockchain: string, symbolOrAddress: string): AuroraAsset | undefined {
  const key = symbolOrAddress.trim().toLowerCase();
  const onChain = ALL.filter((a) => a.blockchain === blockchain);
  if (key.startsWith("0x")) {
    if (NATIVE_ADDRESSES.has(key)) return onChain.find((a) => a.contractAddress === undefined);
    return onChain.find((a) => a.contractAddress?.toLowerCase() === key);
  }
  return onChain.find((a) => a.symbol.toLowerCase() === key);
}

/** rescale an atomic amount between two decimal counts, rounding down */
export function rescale(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return amount;
  if (toDecimals > fromDecimals) return amount * 10n ** BigInt(toDecimals - fromDecimals);
  return amount / 10n ** BigInt(fromDecimals - toDecimals);
}
