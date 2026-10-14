// the correlation score as a meter. adapted from spidereum desktop CorrelationMeter.
// the score is 0 to 100, higher = easier for an observer to link the accounts
import { RISK_COLOR, riskLevel } from "../lib/linkability.ts";

export function Meter({ label, score }: { label: string; score: number }) {
  const level = riskLevel(score);
  const color = RISK_COLOR[level];
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm text-muted">{label}</div>
        <div className="flex items-baseline gap-2">
          <span className="num text-2xl font-semibold" style={{ color }}>
            {score}
          </span>
          <span className="text-xs text-faint">/100</span>
          <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider" style={{ background: `${color}22`, color }}>
            {level}
          </span>
        </div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.max(2, score)}%`, background: color }} />
      </div>
    </div>
  );
}
