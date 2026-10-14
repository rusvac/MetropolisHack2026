// the one module that talks to apps/server. point it with ?source=server, ?source=fixture,
// or leave it on auto: try the server, and fall back to the browser fixture when it is not up.
//
//   POST /plan     body { intent, ...intent }      -> RebalancePlan (+ PlanExtras), bigints as strings
//   POST /execute  body { plan, planId, dropVenue? } -> text/event-stream of ExecEvent
//   POST /execute/venue-off  body { runId, venue } -> turn a venue off during a run
import type { RebalanceIntent, VenueId } from "@spidereum/core";
import { fixturePlan } from "./fixture.ts";
import { parsePlanJson, stringify } from "./json.ts";
import { simulateRun, type RunHandle } from "./simulate.ts";
import { SseParser } from "./sse.ts";
import type { DemoPlan, ExecEvent, ExecuteOptions, Source } from "./types.ts";

export type SourcePref = "auto" | Source;

export function sourcePref(search = typeof location === "undefined" ? "" : location.search): SourcePref {
  const v = new URLSearchParams(search).get("source");
  return v === "server" || v === "fixture" ? v : "auto";
}

export interface PlanResult {
  plan: DemoPlan;
  source: Source;
  /** why the plan came from the fixture, when the server did not answer */
  note?: string;
}

const PLAN_TIMEOUT_MS = 20_000;

export async function getPlan(intent: RebalanceIntent, pref: SourcePref): Promise<PlanResult> {
  if (pref === "fixture") return { plan: fixturePlan(intent), source: "fixture" };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PLAN_TIMEOUT_MS);
    const res = await fetch("/plan", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: stringify({ intent, ...intent }),
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) throw new Error(`POST /plan answered ${res.status}`);
    const text = await res.text();
    const body = parsePlanJson<DemoPlan | { plan: DemoPlan }>(text);
    const plan = "plan" in body && body.plan ? body.plan : (body as DemoPlan);
    if (!plan || !Array.isArray(plan.swaps) || !plan.before) throw new Error("POST /plan sent no RebalancePlan");
    return { plan, source: "server" };
  } catch (err) {
    if (pref === "server") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return { plan: fixturePlan(intent), source: "fixture", note: `server not reachable (${msg})` };
  }
}

export function execute(
  plan: DemoPlan,
  source: Source,
  opts: ExecuteOptions,
  onEvent: (e: ExecEvent) => void,
): RunHandle {
  if (source === "fixture") return simulateRun(plan, opts, onEvent);

  const ctl = new AbortController();
  let runId: string | undefined;
  let fallback: RunHandle | undefined;
  const emit = (e: ExecEvent) => {
    if (e.type === "start" && e.runId) runId = e.runId;
    onEvent(e);
  };

  (async () => {
    try {
      const res = await fetch("/execute", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: stringify({ plan, planId: plan.planId, ...opts }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`POST /execute answered ${res.status}`);
      const parser = new SseParser(emit);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(value);
      }
      parser.end();
    } catch (err) {
      if (ctl.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", at: Date.now(), message: `${msg}. Showing a simulated run instead` });
      fallback = simulateRun(plan, opts, onEvent);
    }
  })();

  return {
    stop() {
      ctl.abort();
      fallback?.stop();
    },
    venueOff(venue: VenueId) {
      if (fallback) return fallback.venueOff(venue);
      void fetch("/execute/venue-off", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stringify({ runId, venue }),
      }).catch(() => undefined);
    },
  };
}

export type { RunHandle };
