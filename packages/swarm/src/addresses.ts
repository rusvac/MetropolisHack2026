// the swarm's account paths, and `bun run swarm:addresses` to print the addresses to fund.
// prints public addresses only. never prints the seed or a key
import { mnemonicToAccount } from "viem/accounts";
import type { HDAccount } from "viem/accounts";

/** one bip-44 account per chain, so no address appears on two chains */
export const CHAIN_ACCOUNT_INDEX: Record<number, number> = {
  10143: 0, // monad testnet: m/44'/60'/0'/0/i
  143: 0, // monad mainnet: same path
  84532: 1, // base sepolia: m/44'/60'/1'/0/i
  8453: 1, // base mainnet: same path
};

export function deriveSwarmAccount(mnemonic: string, chainId: number, index: number): HDAccount {
  const accountIndex = CHAIN_ACCOUNT_INDEX[chainId];
  if (accountIndex === undefined) throw new Error(`no swarm path for chain ${chainId}`);
  return mnemonicToAccount(mnemonic, { accountIndex, addressIndex: index });
}

if (import.meta.main) {
  const mnemonic = process.env.BURNER_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("BURNER_MNEMONIC is empty. put the seed in .env");
  const count = Number(process.argv[2] ?? 4);
  for (const [chainId, name] of [[10143, "monad testnet"], [84532, "base sepolia"]] as const) {
    console.log(`${name} (${chainId})`);
    for (let i = 0; i < count; i++) {
      console.log(`  ${i}  ${deriveSwarmAccount(mnemonic, chainId, i).address}${i === 0 ? "  <- fund this one" : ""}`);
    }
  }
}
