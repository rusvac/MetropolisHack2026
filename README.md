<img src="assets/logo/spidereum-icon.svg" width="96" alt="Spidereum">

# Spidereum

One intent, many routes. Spidereum splits a trade or a rebalance across Monad venues and a swarm of your own accounts. The split costs less than one big trade, and no single transaction shows your full size.

Built for Metropolis, the Monad hackathon, on 13 Oct 2026.

## The problem

A big trade pays twice. It pays once in price impact. It pays again because everyone can see the size. Professional desks split their orders across venues and over time for both reasons. One person with one wallet cannot.

## What it does

You state an intent in one sentence, for example "Get me to 70% MON and 30% USDC, with half the MON hedged."

1. **The swarm.** Spidereum derives your accounts from one seed, on Monad and on Base. No address appears on both chains.
2. **The portfolio now.** It reads your holdings per account and per chain.
3. **The intent.** You set target weights, a hedge ratio, and a privacy weight.
4. **The plan.** The router turns the targets into moves:
   - bridges from Base into different Monad accounts,
   - swap slices split across Kuru and Uniswap v4, each with its own account and delay,
   - a short on Perpl for the hedge.
   Next to the plan, it shows the naive version: one account, one bridge, one trade per asset.
5. **Execute.** A live timeline with an explorer link for every move. If a venue drops out halfway, the remaining slices re-route to the other venues.
6. **The portfolio after.** Before and after, against the targets.
7. **What an observer can link.** The largest single move as a share of the total, a correlation score, and every direct transfer between your accounts.

## Why Monad

Blocks come every 400 ms, and gas is cheap. Twenty slices settle in seconds and cost cents. On Ethereum mainnet, the gas for twenty slices costs more than the split saves.

## What is live and what is simulated

Every number in the app and the terminal says where it comes from.

| Part | Status |
|---|---|
| Kuru quotes | live, Monad mainnet order book |
| Uniswap v4 quotes | live, Monad mainnet Quoter |
| Perpl hedge quote | live, Perpl mainnet mark price and funding |
| Aurora Intents bridge quote | live, dry quotes from Aurora's Swap API. Nothing is deposited |
| Swaps, hedge, and account funding | live sends on Monad testnet |
| Bridge from Base Sepolia | built on Circle CCTP V2, not yet sent |
| The $4,700 portfolio in `bun run demo` | a fixed portfolio, simulated |

In our runs on live Monad mainnet quotes, splitting a $2,970 swap across Kuru and Uniswap v4 saved $0.33 to $1.13 against one trade at the best single venue. The amount moves with the order books. The size shown changes more: the largest single move fell from 100% of the rebalance to 21%.

## Onchain proof, Monad testnet

| What | Transaction |
|---|---|
| Kuru swap from a swarm account | [0xbd610ad7…](https://testnet.monadexplorer.com/tx/0xbd610ad7574751ff891a8e2e12c17111beb65f3448321fff7918a75c2a46b1c4) |
| Test pool swap | [0x0e86f001…](https://testnet.monadexplorer.com/tx/0x0e86f001fb14eb020424181b4ec32820812ff0f15c9233de6846ff89be2002a3) |
| Uniswap v4 (Monad testnet deployment) swap | [0xfb65d406…](https://testnet.monadexplorer.com/tx/0xfb65d4068ee81975bba36738310a78da7ca7a7713bdce07f27c242911eeb796f) |
| Perpl short, 100 MON, AUSD collateral | [0x5d8bf15d…](https://testnet.monadexplorer.com/tx/0x5d8bf15db658d37e1c4eb9cee61ee84d917bdf147707e10d0f4e2024555bfb7c) |
| A three-transaction slice from one swarm account | [0x82093bad…](https://testnet.monadexplorer.com/tx/0x82093badfc171d3ec43c43e0fa593b650d57ba5d53d762dd7e414c8cefb32a36) |
| `bun run demo:onchain`: the first of 8 slices from 4 swarm accounts, on the test pool | [0xee2a0e6f…](https://testnet.monadexplorer.com/tx/0xee2a0e6f58fa719d0445942d5249c595b316c5adc92812c9cb3fcf94a96cecd0) |
| The same run, after the test pool turned off: a re-routed slice on Uniswap v4 testnet | [0xaf65ef9d…](https://testnet.monadexplorer.com/tx/0xaf65ef9d992d224105161c30857a13cd5fceac0f1897e62865f11b5775dda00c) |

`bun run demo:onchain` runs the whole loop on Monad testnet: live balances, testnet quotes, the router's split, real sends from the swarm, a venue that turns off halfway, and the re-route. At testnet size, gas is most of the cost, so the split loses money there. The terminal says so. The mainnet demo shows the split at a real size.

Contracts on Monad testnet:

- Kuru market, MON against Circle USDC: `0x10D447F2cfa2f2750D8b91461c580902573ACC90`
- Test pool, constant product, MON against Circle USDC: `0x8345ab7fbf4579d5ed6fae7b850761af98e63de5`

## Integrations

- **Kuru.** Order book quotes on mainnet. Swaps on a testnet market that we created through Kuru's testnet router.
- **Uniswap v4.** Quoter on Monad mainnet. Swaps on the Monad testnet deployment through the Universal Router.
- **Perpl.** Mark price and funding from Perpl's API. A short on Perpl testnet with AUSD as collateral.
- **Aurora Intents.** Bridge quotes from Base into Monad. A solver fills each Monad account, so no swarm account funds another.
- **Circle CCTP V2.** The testnet bridge from Base Sepolia to Monad testnet. Circle's forwarding service sends the mint.

## Run it

```sh
bun install
cp .env.example .env    # add BURNER_MNEMONIC, a testnet-only seed
bun run demo            # the seven beats in the terminal, with live mainnet quotes
bun run demo:onchain --dry   # the testnet run, planned and built, nothing sent
bun run demo:onchain    # the testnet run, with real sends from swarm accounts 10 to 13
bun run server          # the API on port 8787. DEMO_ONCHAIN=1 runs the testnet mode
bun run dev             # the phone app, in a second terminal
bun run check           # typecheck and offline tests
bun run test:live       # tests that read live networks
```

## Layout

- `packages/core`: the shared types.
- `packages/venues`: Kuru, Uniswap v4, the test pool, Perpl, Aurora Intents, and CCTP.
- `packages/router`: `plan`, `rebalance`, and `replan`.
- `packages/swarm`: account derivation, live balances, sending, funding, and the correlation score.
- `apps/server`: the plan and execute routes. The seed and keys stay on the server.
- `apps/web`: the seven beats as phone screens.
- `scripts`: the terminal demo.

## Built during Metropolis

The idea and a mock prototype existed before 1 Sep 2026. Everything in this repo was written for Metropolis on 13 Oct 2026.
