// lane L5 owns this package. see CLAUDE.md
// pure logic, no network of its own: every number comes from the venues the caller passes
//
// plan(intent, venues, opts)                 one swap, split into slices across venues and accounts
// rebalance(portfolio, intent, venues, opts) target weights into bridges, sliced swaps, and the hedge quote
// replan(plan, doneSlices, venues, opts)     the slices not yet sent, re-routed over the venues still up
export { type AnyVenue, type PlanOptions, plan, replan } from "./plan.ts";
export { type RebalanceOptions, rebalance } from "./rebalance.ts";
