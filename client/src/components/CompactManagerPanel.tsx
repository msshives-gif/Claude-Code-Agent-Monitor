/**
 * @file CompactManagerPanel.tsx
 * @description Persistent dashboard readout of the local compact-manager CLI
 * (context auto-compaction): mode + threshold summary, watcher health with
 * attention flags, a collapsible model-overrides table, and per-session
 * context usage as the manager itself sees it — the full `overview --json`
 * payload, not a digest (watchers without a recent session row still get a
 * line). Polls GET /api/compact-manager/status; renders nothing on machines
 * where the CLI is absent or failing, so the dashboard stays clean without
 * configuration. Session rows show the manager's own usage numbers (advisor
 * state files), which can differ slightly from the transcript-derived
 * ContextGauge readings elsewhere in the UI.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../lib/api";
import type {
  CompactManagerModelOverride,
  CompactManagerSession,
  CompactManagerStatusPayload,
  CompactManagerWatcher,
} from "../lib/types";
import { fmt } from "../lib/format";

const POLL_MS = 15_000;

/** Locale-neutral compact age: 4s / 12m / 2.1h. Callers pass finite numbers only. */
function ageText(ageS: number): string {
  if (ageS < 60) return `${ageS}s`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m`;
  return `${(ageS / 3600).toFixed(1)}h`;
}

/** 0.7 → "70"; anything non-finite → "?" so a drifted payload can't NaN the header. */
function pctText(fraction: unknown): string {
  return typeof fraction === "number" && Number.isFinite(fraction)
    ? String(Math.round(fraction * 100))
    : "?";
}

/** Finite number or null — the render-side unit of trust for payload numerics. */
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function barColors(pct: number, triggerPct: number): { bar: string; text: string } {
  if (pct >= triggerPct * 100) return { bar: "bg-red-500", text: "text-red-400" };
  if (pct >= triggerPct * 100 - 10) return { bar: "bg-amber-500", text: "text-amber-400" };
  return { bar: "bg-emerald-500", text: "text-emerald-400" };
}

/** Watcher rows normalized so malformed nested fields can't reach render. */
interface SafeWatcher {
  session_id: string;
  state: string;
  live: boolean;
  reason: string | null;
  flags: string[];
}

function normalizeWatcher(w: CompactManagerWatcher): SafeWatcher {
  return {
    session_id: w.session_id,
    state: typeof w.state === "string" ? w.state : "",
    live: w.live === true,
    reason: typeof w.reason === "string" ? w.reason : null,
    flags: Array.isArray(w.flags) ? w.flags.filter((f): f is string => typeof f === "string") : [],
  };
}

/** Watcher-state cell. Precedence: flags > watched > retired > raw state > unwatched. */
function WatcherCell({ watcher }: { watcher: SafeWatcher | undefined }) {
  const { t } = useTranslation("dashboard");
  if (watcher && watcher.flags.length > 0) {
    return (
      <span className="text-red-400 font-mono text-[10px]" title={watcher.flags.join(", ")}>
        {watcher.flags[0]}
      </span>
    );
  }
  if (watcher?.live) {
    return <span className="text-emerald-400 text-[10px]">{t("compactManager.watched")}</span>;
  }
  if (watcher && watcher.state === "WATCHER_RETIRED") {
    return (
      <span
        className="text-gray-500 text-[10px]"
        title={watcher.reason ? `${watcher.state}: ${watcher.reason}` : watcher.state}
      >
        {t("compactManager.retired")}
      </span>
    );
  }
  if (watcher) {
    // Exists but neither live nor retired — an unknown lifecycle state.
    // Show it raw rather than mislabeling it watched/retired/unwatched.
    return (
      <span
        className="text-gray-500 font-mono text-[10px] truncate inline-block max-w-full"
        title={watcher.reason ? `${watcher.state}: ${watcher.reason}` : watcher.state}
      >
        {watcher.state || "?"}
      </span>
    );
  }
  return <span className="text-gray-600 text-[10px]">{t("compactManager.unwatched")}</span>;
}

function SessionRow({
  session,
  watcher,
  triggerPct,
}: {
  session: CompactManagerSession;
  watcher: SafeWatcher | undefined;
  triggerPct: number;
}) {
  const { t } = useTranslation("dashboard");
  const shortId = session.session_id.slice(0, 8);
  if (session.unreadable) {
    // Same column skeleton so the watcher state stays visible and aligned —
    // an unreadable state row can still have a live/retired watcher.
    return (
      <div className="flex items-center gap-3 text-xs">
        <span className="font-mono text-gray-500 w-20 flex-shrink-0">{shortId}</span>
        <span className="text-gray-600 truncate w-40 flex-shrink-0">
          {t("compactManager.unreadable")}
        </span>
        <span className="w-24 flex-shrink-0" />
        <span className="font-mono text-gray-600 w-28 text-right flex-shrink-0">—</span>
        <span className="w-14 flex-shrink-0" />
        <span className="w-10 flex-shrink-0" />
        <span className="w-20 flex-shrink-0 text-right">
          <WatcherCell watcher={watcher} />
        </span>
        <span className="flex-1 min-w-0" />
      </div>
    );
  }
  // Strings only — the CLI already coerces, but an object here would be
  // an unrenderable React child and take the page down.
  const model = typeof session.model === "string" ? session.model : null;
  // Numerics render only when finite; invalid values surface as "?" or blank
  // rather than degrading into plausible-but-false zeros.
  const pct = finite(session.pct);
  const current = finite(session.current);
  const window = finite(session.window);
  const peak = finite(session.peak);
  // The derived percentage gets its own finite check — extreme operands can
  // overflow to Infinity even when both inputs are finite.
  const peakPct =
    peak !== null && window !== null && window > 0 ? finite((peak / window) * 100) : null;
  const ageS = finite(session.age_s);
  const colors = pct !== null ? barColors(pct, triggerPct) : null;
  const currentText =
    current !== null && pct !== null
      ? `${fmt(current)} · ${pct.toFixed(1)}%`
      : current !== null
        ? fmt(current)
        : pct !== null
          ? `${pct.toFixed(1)}%`
          : "?";
  return (
    <div className="flex items-center gap-3 text-xs" data-testid="compact-manager-row">
      <span className="font-mono text-gray-400 w-20 flex-shrink-0" title={session.session_id}>
        {shortId}
      </span>
      <span
        className="font-mono text-gray-500 truncate w-40 flex-shrink-0"
        title={model || undefined}
      >
        {model || "?"}
      </span>
      <span
        className="w-24 h-1.5 rounded-full bg-surface-3/80 overflow-hidden flex-shrink-0"
        title={current !== null && window !== null ? `${fmt(current)} / ${fmt(window)}` : undefined}
      >
        <span
          className={`block h-full rounded-full ${colors ? colors.bar : "bg-gray-600"} opacity-80`}
          style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
        />
      </span>
      <span
        className={`font-mono w-28 text-right flex-shrink-0 ${colors ? colors.text : "text-gray-500"}`}
      >
        {currentText}
      </span>
      <span
        className="font-mono text-gray-500 w-14 text-right flex-shrink-0"
        title={peak !== null ? fmt(peak) : undefined}
      >
        {/* Percent only — never token units under a percent-scaled column;
            the raw count lives in the tooltip. */}
        {peakPct !== null ? `${peakPct.toFixed(1)}%` : ""}
      </span>
      <span className="font-mono text-gray-600 w-10 text-right flex-shrink-0">
        {session.future_mtime ? "?" : ageS !== null ? ageText(ageS) : ""}
      </span>
      <span className="w-20 flex-shrink-0 text-right">
        <WatcherCell watcher={watcher} />
      </span>
      <span className="flex-1 min-w-0" />
    </div>
  );
}

/** A watcher with no session row touched in the last 24h — usage unknown, but
 *  the watcher's existence and state must still be visible (full payload). */
function WatcherOnlyRow({ watcher }: { watcher: SafeWatcher }) {
  return (
    <div className="flex items-center gap-3 text-xs" data-testid="compact-manager-row">
      <span className="font-mono text-gray-400 w-20 flex-shrink-0" title={watcher.session_id}>
        {watcher.session_id.slice(0, 8)}
      </span>
      <span className="font-mono text-gray-600 w-40 flex-shrink-0">—</span>
      <span className="w-24 flex-shrink-0" />
      <span className="font-mono text-gray-600 w-28 text-right flex-shrink-0">—</span>
      <span className="w-14 flex-shrink-0" />
      <span className="w-10 flex-shrink-0" />
      <span className="w-20 flex-shrink-0 text-right">
        <WatcherCell watcher={watcher} />
      </span>
      <span className="flex-1 min-w-0" />
    </div>
  );
}

/** Muted column titles aligned to SessionRow's fixed widths. */
function SessionHeaderRow() {
  const { t } = useTranslation("dashboard");
  return (
    <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-gray-600">
      <span className="w-20 flex-shrink-0">{t("compactManager.colSession")}</span>
      <span className="w-40 flex-shrink-0">{t("compactManager.colModel")}</span>
      <span className="w-24 flex-shrink-0">{t("compactManager.colUsage")}</span>
      <span className="w-28 text-right flex-shrink-0">{t("compactManager.colCurrent")}</span>
      <span className="w-14 text-right flex-shrink-0">{t("compactManager.colPeak")}</span>
      <span className="w-10 text-right flex-shrink-0">{t("compactManager.colUpdated")}</span>
      <span className="w-20 text-right flex-shrink-0">{t("compactManager.colWatcher")}</span>
      <span className="flex-1 min-w-0" />
    </div>
  );
}

function OverridesTable({
  overrides,
}: {
  overrides: Array<[string, CompactManagerModelOverride]>;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <div
      className="overflow-x-auto"
      data-testid="compact-manager-overrides"
      id="compact-manager-overrides"
    >
      <table className="text-xs font-mono text-gray-400">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-gray-600">
            <th className="text-left font-normal pr-6 pb-1">{t("compactManager.ovrPattern")}</th>
            <th className="text-right font-normal pr-6 pb-1">{t("compactManager.ovrWindow")}</th>
            <th className="text-right font-normal pr-6 pb-1">{t("compactManager.ovrSoft")}</th>
            <th className="text-right font-normal pr-6 pb-1">{t("compactManager.ovrHard")}</th>
            <th className="text-right font-normal pb-1">{t("compactManager.ovrTrigger")}</th>
          </tr>
        </thead>
        <tbody>
          {overrides.map(([pattern, o]) => {
            const window = finite(o?.context_window);
            return (
              <tr key={pattern}>
                <td className="pr-6">{pattern}</td>
                <td className="text-right pr-6">{window !== null ? fmt(window) : "?"}</td>
                <td className="text-right pr-6">{pctText(o?.soft_pct)}%</td>
                <td className="text-right pr-6">{pctText(o?.hard_pct)}%</td>
                <td className="text-right">{pctText(o?.managed_trigger_pct)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CompactManagerPanel() {
  const { t } = useTranslation("dashboard");
  const [status, setStatus] = useState<CompactManagerStatusPayload | null>(null);
  const [overridesOpen, setOverridesOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.compactManager.status());
    } catch {
      // Endpoint unreachable (older server, network blip) — treat exactly
      // like an absent CLI and keep the panel hidden.
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const overview = status?.available ? status.overview : undefined;
  if (!overview) return null;

  // Belt-and-braces against a shape-drifted producer (the server already
  // rejects envelopes without these arrays): default the arrays, drop rows
  // without a session id, normalize watcher fields (malformed nested flags
  // must never reach .join()/React children), and never let a missing
  // trigger become NaN — this panel must degrade, never take the Dashboard
  // down with a render throw (the app has no error boundary).
  const watchers = (Array.isArray(overview.watchers) ? overview.watchers : [])
    .filter((w) => typeof w?.session_id === "string")
    .map(normalizeWatcher);
  const sessions = (Array.isArray(overview.sessions) ? overview.sessions : []).filter(
    (s) => typeof s?.session_id === "string"
  );
  const watcherBySession = new Map(watchers.map((w) => [w.session_id, w]));
  const sessionIds = new Set(sessions.map((s) => s.session_id));
  const watcherOnly = watchers.filter((w) => !sessionIds.has(w.session_id));
  const flagged = watchers.filter((w) => w.flags.length > 0);
  const overrides =
    overview.models && typeof overview.models === "object" ? Object.entries(overview.models) : [];
  const triggerPct = Number.isFinite(overview.managed_trigger_pct)
    ? overview.managed_trigger_pct
    : 0.8;
  const contextWindow = finite(overview.context_window);

  return (
    <div className="card p-5 flex flex-col gap-3" data-testid="compact-manager-panel">
      <div className="flex items-center justify-between flex-wrap gap-x-4 gap-y-1">
        <div className="flex items-center gap-3">
          <Archive className="w-4 h-4 text-sky-400" />
          <span className="text-xs text-gray-500 uppercase tracking-wider">
            {t("compactManager.title")}
          </span>
        </div>
        <span className="text-[10px] font-mono text-gray-500">
          {t("compactManager.summaryLine", {
            mode: overview.mode || "?",
            window: contextWindow !== null ? fmt(contextWindow) : "?",
            soft: pctText(overview.soft_pct),
            hard: pctText(overview.hard_pct),
            trigger: pctText(triggerPct),
          })}
        </span>
      </div>

      {flagged.length > 0 && (
        <div
          className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 rounded-md px-3 py-2"
          data-testid="compact-manager-flags"
        >
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="font-mono truncate">
            {flagged.map((w) => `${w.session_id.slice(0, 8)}: ${w.flags.join(",")}`).join("  ·  ")}
          </span>
        </div>
      )}

      {overrides.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setOverridesOpen((v) => !v)}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-500 hover:text-gray-400"
            data-testid="compact-manager-overrides-toggle"
            aria-expanded={overridesOpen}
            aria-controls="compact-manager-overrides"
          >
            {overridesOpen ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            {t("compactManager.overrides", { n: overrides.length })}
          </button>
          {overridesOpen && (
            <div className="mt-2 pl-4">
              <OverridesTable overrides={overrides} />
            </div>
          )}
        </div>
      )}

      {sessions.length === 0 && watcherOnly.length === 0 ? (
        <span className="text-xs text-gray-600">{t("compactManager.noSessions")}</span>
      ) : (
        <div className="overflow-x-auto">
          <div className="space-y-2 min-w-[45rem]">
            <SessionHeaderRow />
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {sessions.map((s) => (
                <SessionRow
                  key={s.session_id}
                  session={s}
                  watcher={watcherBySession.get(s.session_id)}
                  triggerPct={triggerPct}
                />
              ))}
              {watcherOnly.map((w) => (
                <WatcherOnlyRow key={w.session_id} watcher={w} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
