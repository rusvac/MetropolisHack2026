// a constant-product pool with fixed reserves. the router and the screens build on it
// before the live venues land. every quote says simulated: true
import type { QuoteRequest, SpotVenue } from "@spidereum/core";

export interface MockVenueOptions {
  name: string;
  /** reserve of the token the person sells, atomic units */
  reserveIn: bigint;
  /** reserve of the token the person buys, atomic units */
  reserveOut: bigint;
  feeBps: number;
  gasUnits?: bigint;
}

export function createMockVenue(opts: MockVenueOptions): SpotVenue {
  const gasUnits = opts.gasUnits ?? 150_000n;
  return {
    id: `mock-${opts.name}`,
    kind: "spot",
    async quote(req: QuoteRequest) {
      const inAfterFee = (req.amountIn * BigInt(10_000 - opts.feeBps)) / 10_000n;
      const amountOut = (opts.reserveOut * inAfterFee) / (opts.reserveIn + inAfterFee);
      return {
        venue: `mock-${opts.name}`,
        sell: req.sell,
        buy: req.buy,
        amountIn: req.amountIn,
        amountOut,
        feeBps: opts.feeBps,
        gasUnits,
        simulated: true,
        at: Date.now(),
      };
    },
  };
}
