/**
 * @file ContextGauge.tsx
 * @description Context-window fullness gauge. Shows how much of the model's
 * context window the session's latest request occupied (input + cache read +
 * cache write + output of the newest usage record), with green/amber/red
 * thresholds so context exhaustion is visible before it happens. Renders
 * nothing when the session has no context reading yet — older rows and
 * providers without transcript usage degrade to the previous card layout.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { fmt } from "../lib/format";

/** Warning thresholds, as fractions of the model's context window. */
const AMBER_THRESHOLD = 0.7;
const RED_THRESHOLD = 0.9;

function gaugeColors(ratio: number): { bar: string; text: string } {
  if (ratio >= RED_THRESHOLD) return { bar: "bg-red-500", text: "text-red-400" };
  if (ratio >= AMBER_THRESHOLD) return { bar: "bg-amber-500", text: "text-amber-400" };
  return { bar: "bg-emerald-500", text: "text-emerald-400" };
}

interface ContextGaugeProps {
  /** Latest request's context occupancy in tokens (sessions.latest_context_tokens). */
  tokens: number | null | undefined;
  /** The owning model's context window in tokens (sessions.context_window). */
  window: number | null | undefined;
  /** Compact inline pill for card footers; default is a full labeled bar. */
  compact?: boolean;
  className?: string;
}

export function ContextGauge({ tokens, window: win, compact, className }: ContextGaugeProps) {
  if (
    typeof tokens !== "number" ||
    typeof win !== "number" ||
    !Number.isFinite(tokens) ||
    !Number.isFinite(win) ||
    tokens <= 0 ||
    win <= 0
  ) {
    return null;
  }
  const ratio = Math.min(1, tokens / win);
  const pct = Math.round(ratio * 100);
  const { bar, text } = gaugeColors(ratio);
  const title = `Context window used: ${tokens.toLocaleString()} of ${win.toLocaleString()} tokens (${pct}%)`;

  if (compact) {
    return (
      <span
        className={`flex items-center gap-1.5 flex-shrink-0 ${className || ""}`}
        title={title}
        data-testid="context-gauge-compact"
      >
        <span className="w-10 h-1.5 rounded-full bg-surface-3/80 overflow-hidden inline-block">
          <span
            className={`block h-full rounded-full ${bar} opacity-80`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className={`font-mono ${text}`}>{pct}%</span>
      </span>
    );
  }

  return (
    <div className={className} title={title} data-testid="context-gauge">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] text-gray-500 font-mono">
          {fmt(tokens)} / {fmt(win)} tokens
        </span>
        <span className={`text-[11px] font-mono ${text}`}>{pct}%</span>
      </div>
      <div className="w-full h-2 rounded-full bg-surface-3/60 overflow-hidden">
        <div className={`h-full rounded-full ${bar} opacity-80`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
