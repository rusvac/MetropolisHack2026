// what every beat receives from the app
import type { RebalanceIntent, VenueId } from "@spidereum/core";
import type { Move } from "../lib/moves.ts";
import type { RunState } from "../lib/run.ts";
import type { Address, DemoPlan, Source } from "../lib/types.ts";

export interface BeatProps {
  plan: DemoPlan;
  moves: Move[];
  source: Source;
  /** true when the balances in `plan.before` are not live */
  balancesSimulated: boolean;
  addressOf: (chainId: number, index: number) => Address | undefined;
  intent: RebalanceIntent;
  setIntent: (i: RebalanceIntent) => void;
  planning: boolean;
  replan: () => void;
  run: RunState;
  startRun: (dropVenue?: VenueId) => void;
  stopRun: () => void;
  venueOffNow: (v: VenueId) => void;
  go: (beat: number) => void;
}
