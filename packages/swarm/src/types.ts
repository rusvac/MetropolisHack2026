// the swarm's own shapes. the shared contract stays in @spidereum/core
import type { Address, Hex } from "viem";
import { CHAIN_ACCOUNT_INDEX } from "./addresses.ts";

/** one swarm account: its derivation index on one chain. monad and base use different paths, so they never share an address */
export interface AccountRef {
  chainId: number;
  account: number;
}

/**
 * the account's identity: its derivation path. a testnet and its mainnet share a path, so they share the address:
 * monad testnet #3 and monad mainnet #3 are one account. monad #3 and base #3 are two
 */
export function accountKey(ref: AccountRef): string {
  const path = CHAIN_ACCOUNT_INDEX[ref.chainId];
  return path === undefined ? `chain ${ref.chainId}/${ref.account}` : `m/44'/60'/${path}'/0/${ref.account}`;
}

/** value that moved from one swarm account straight to another. an observer links the two */
export interface SwarmTransfer {
  from: AccountRef;
  to: AccountRef;
  /** "direct": a plain transfer. "bridge": a bridge whose message names the receiver, for example cctp */
  kind: "direct" | "bridge";
  /** chain where the transfer ran */
  chainId: number;
  /** token address. the zero address is the native token */
  token: Address;
  symbol: string;
  amount: bigint;
  hash?: Hex;
  url?: string;
  blockNumber?: bigint;
  /** unix ms */
  at: number;
}
