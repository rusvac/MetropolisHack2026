// the chains the swarm holds funds on, their clients, and their explorer links
import { createPublicClient, http, zeroAddress } from "viem";
import type { Address, Chain, Hex, PublicClient } from "viem";
import { baseSepolia, monadTestnet } from "@spidereum/core";
import type { Token } from "@spidereum/core";

/** the native token (MON, ETH) as a `Token.address` */
export const NATIVE: Address = zeroAddress;

export function isNative(token: Address | "native" | undefined): boolean {
  return token === undefined || token === "native" || token.toLowerCase() === NATIVE;
}

export interface SwarmChain {
  chain: Chain;
  name: string;
  /** the `.env` key for the rpc url */
  rpcEnv: string;
  explorer: string;
  native: Token;
  usdc: Token;
  /** monad's reserve balance rule applies: see `send.ts` */
  monadReserve: boolean;
  pollingMs: number;
}

export const SWARM_CHAINS: Record<number, SwarmChain> = {
  10143: {
    chain: monadTestnet,
    name: "monad testnet",
    rpcEnv: "MONAD_TESTNET_RPC_URL",
    explorer: "https://testnet.monadexplorer.com",
    native: { chainId: 10143, symbol: "MON", address: NATIVE, decimals: 18 },
    usdc: { chainId: 10143, symbol: "USDC", address: "0x534b2f3a21130d7a60830c2df862319e593943a3", decimals: 6 },
    monadReserve: true,
    pollingMs: 400,
  },
  84532: {
    chain: baseSepolia,
    name: "base sepolia",
    rpcEnv: "BASE_SEPOLIA_RPC_URL",
    explorer: "https://sepolia.basescan.org",
    native: { chainId: 84532, symbol: "ETH", address: NATIVE, decimals: 18 },
    usdc: { chainId: 84532, symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
    monadReserve: false,
    pollingMs: 1000,
  },
};

export function swarmChain(chainId: number): SwarmChain {
  const c = SWARM_CHAINS[chainId];
  if (!c) throw new Error(`the swarm has no config for chain ${chainId}`);
  return c;
}

export function txUrl(chainId: number, hash: Hex): string {
  return `${swarmChain(chainId).explorer}/tx/${hash}`;
}

export function addressUrl(chainId: number, address: Address): string {
  return `${swarmChain(chainId).explorer}/address/${address}`;
}

const clients = new Map<string, PublicClient>();

/** one cached public client per chain and rpc url. the url comes from `.env` unless given */
export function publicClient(chainId: number, rpcUrl?: string): PublicClient {
  const c = swarmChain(chainId);
  const url = rpcUrl ?? process.env[c.rpcEnv]?.trim();
  if (!url) throw new Error(`${c.rpcEnv} is empty. put the rpc url in .env`);
  const key = `${chainId}|${url}`;
  let client = clients.get(key);
  if (!client) {
    client = createPublicClient({
      chain: c.chain,
      transport: http(url, { retryCount: 6, retryDelay: 250, timeout: 20_000 }),
      pollingInterval: c.pollingMs,
    }) as PublicClient;
    clients.set(key, client);
  }
  return client;
}

export function mnemonicFromEnv(mnemonic?: string): string {
  const m = (mnemonic ?? process.env.BURNER_MNEMONIC)?.trim();
  if (!m) throw new Error("BURNER_MNEMONIC is empty. put the seed in .env");
  return m;
}
