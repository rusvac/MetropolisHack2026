// written by deploy.ts. the test pool on monad testnet (10143)
import type { Address, Hash } from "viem";

export const TEST_POOL_DEPLOYMENT: { address: Address | null; deployTx: Hash | null; owner: Address | null } = {
  address: "0x8345ab7fbf4579d5ed6fae7b850761af98e63de5",
  deployTx: "0xba711d75e1b894cf62fb67d95ce32eb25868cc69b65104bd976d237842b0b54f",
  owner: "0x857BD8EB67778538AC6d1D65EF219b9A296d63db",
};
