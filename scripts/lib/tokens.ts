// tokens and chains the demo names. execution runs on testnets, so holdings use testnet tokens.
// the live venues map these to mainnet for quotes
import type { Token } from "../../packages/core/src/index.ts";

export const NATIVE = "0x0000000000000000000000000000000000000000" as const;

/** MON, the native token on monad testnet */
export const MON: Token = { chainId: 10143, symbol: "MON", address: NATIVE, decimals: 18 };

/** circle's USDC on monad testnet */
export const USDC_MONAD: Token = {
  chainId: 10143,
  symbol: "USDC",
  address: "0x534b2f3a21130d7a60830c2df862319e593943a3",
  decimals: 6,
};

/** circle's USDC on base sepolia */
export const USDC_BASE: Token = {
  chainId: 84532,
  symbol: "USDC",
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  decimals: 6,
};

/** the monad mainnet tokens the venues quote. the same as MONAD_MON and MONAD_USDC in @spidereum/venues */
export const MON_MAINNET: Token = { chainId: 143, symbol: "MON", address: NATIVE, decimals: 18 };
export const USDC_MAINNET: Token = { chainId: 143, symbol: "USDC", address: "0x754704bc059f8c67012fed69bc8a327a5aafb603", decimals: 6 };

/** the token a move really sends: a mainnet quote token maps to its testnet twin */
export function execToken(t: Token, known: Token[] = []): Token {
  const chainId = t.chainId === 143 ? 10143 : t.chainId === 8453 ? 84532 : t.chainId;
  if (chainId === t.chainId) return t;
  const twin = known.find((k) => k.chainId === chainId && k.symbol === t.symbol);
  if (twin) return twin;
  if (chainId === 10143 && t.symbol === "MON") return MON;
  if (chainId === 10143 && t.symbol === "USDC") return USDC_MONAD;
  if (chainId === 84532 && t.symbol === "USDC") return USDC_BASE;
  return { ...t, chainId };
}

export interface ChainInfo {
  name: string;
  short: string;
  explorer: string;
}

export const CHAINS: Record<number, ChainInfo> = {
  10143: { name: "monad testnet", short: "monad", explorer: "https://testnet.monadexplorer.com" },
  84532: { name: "base sepolia", short: "base", explorer: "https://sepolia.basescan.org" },
  143: { name: "monad mainnet", short: "monad", explorer: "https://monadscan.com" },
  8453: { name: "base mainnet", short: "base", explorer: "https://basescan.org" },
};

export const MONAD_CHAINS = new Set([10143, 143]);
export const BASE_CHAINS = new Set([84532, 8453]);

export function chainName(chainId: number): string {
  return CHAINS[chainId]?.name ?? `chain ${chainId}`;
}

export function txUrl(chainId: number, hash: string): string | null {
  const c = CHAINS[chainId];
  return c ? `${c.explorer}/tx/${hash}` : null;
}

export function addressUrl(chainId: number, address: string): string | null {
  const c = CHAINS[chainId];
  return c ? `${c.explorer}/address/${address}` : null;
}

/** the monad accounts the final demo run uses. the lead funds them */
export const DEMO_MONAD_ACCOUNTS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
/** the base accounts that hold USDC before the bridge */
export const DEMO_BASE_ACCOUNTS = [0, 1, 2, 3];
