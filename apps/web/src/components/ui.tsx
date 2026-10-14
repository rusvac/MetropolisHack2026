// small building blocks shared by the beats
import type { ReactNode } from "react";
import { addressUrl, network, shortAddress } from "../lib/format.ts";

export function Card({ children, className = "", tone }: { children: ReactNode; className?: string; tone?: "accent" | "warn" | "good" }) {
  const border =
    tone === "accent" ? "border-accent/40" : tone === "warn" ? "border-warn/50" : tone === "good" ? "border-good/40" : "border-line";
  return <div className={`rounded-2xl border ${border} bg-surface p-4 ${className}`}>{children}</div>;
}

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`text-[11px] font-medium uppercase tracking-[0.08em] text-faint ${className}`}>{children}</div>;
}

/** the network a number comes from. quote networks read "mainnet quote" */
export function NetBadge({ chainId, className = "" }: { chainId: number; className?: string }) {
  const n = network(chainId);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-raised px-2 py-0.5 text-[11px] text-muted ${className}`}
      title={`${n.name} (${n.id})`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: n.color }} />
      {n.short}
      {n.role === "quote" ? <span className="text-faint">· quote</span> : null}
    </span>
  );
}

/** "simulated" on every number that does not come from a live venue or a live balance */
export function SimBadge({ simulated, live = "live", className = "" }: { simulated: boolean; live?: string; className?: string }) {
  return simulated ? (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[11px] font-medium text-warn ${className}`}>
      simulated
    </span>
  ) : (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-good/40 bg-good/10 px-2 py-0.5 text-[11px] font-medium text-good ${className}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-good" />
      {live}
    </span>
  );
}

export function Stat({ label, value, sub, accent }: { label: ReactNode; value: ReactNode; sub?: ReactNode; accent?: string }) {
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <div className="num mt-1 text-2xl font-semibold tracking-tight" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

export function AddressLink({ chainId, address }: { chainId: number; address: string }) {
  const url = addressUrl(chainId, address);
  const text = shortAddress(address);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted underline decoration-line-strong underline-offset-2 hover:text-ink">
      {text}
    </a>
  ) : (
    <span className="font-mono text-xs text-muted">{text}</span>
  );
}

export function AccountDot({ label, color, size = 28 }: { label: string; color: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-semibold text-white"
      style={{ width: size, height: size, background: `${color}33`, border: `1.5px solid ${color}`, boxShadow: `0 0 12px ${color}33` }}
    >
      {label}
    </span>
  );
}

export function VenueChip({ name, color, struck }: { name: string; color: string; struck?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${struck ? "line-through opacity-50" : ""}`}
      style={{ background: `${color}1f`, color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {name}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  className?: string;
}) {
  const style =
    variant === "primary"
      ? "bg-accent text-white hover:brightness-110 shadow-[0_8px_30px_-8px_#8b7bff]"
      : variant === "danger"
        ? "border border-warn/50 bg-warn/10 text-warn hover:bg-warn/20"
        : "border border-line bg-raised text-ink hover:border-line-strong";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-12 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${style} ${className}`}
    >
      {children}
    </button>
  );
}

export function BeatHeader({ n, title, lede }: { n: number; title: string; lede: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="font-mono text-xs text-accent">beat {n} / 7</div>
      <h2 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight">{title}</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">{lede}</p>
    </div>
  );
}
