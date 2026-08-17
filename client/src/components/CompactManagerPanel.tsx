/**
 * @file CompactManagerPanel.tsx
 * @description Persistent dashboard readout of the local compact-manager CLI
 * (context auto-compaction): mode + threshold summary, watcher health with
 * attention flags, a collapsible model-overrides table, and per-session
 * context usage as the manager itself sees it — the full `overview --json`
 * payload, not a digest. Polls GET /api/compact-manager/status; renders
 * nothing on machines where the CLI is absent or failing, so the dashboard
 * stays clean without configuration. Session rows show the manager's own
 * usage numbers (advisor state files), which can differ slightly from the
 * transcript-derived ContextGauge readings elsewhere in the UI.
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

/** Locale-neutral compact age: 4s / 12m / 2.1h. */
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

function barColors(pct: number, triggerPct: number): { bar: string; text: string } {
  if (pct >= triggerPct * 100) return { bar: "bg-red-500", text: "text-red-400" };
  if (pct >= triggerPct * 100 - 10) return { bar: "bg-amber-500", text: "text-amber-400" };
  return { bar: "bg-emerald-500", text: "text-emerald-400" };
}

function SessionRow({
  session,
  watcher,
  triggerPct,
}: {
  session: CompactManagerSession;
  watcher: CompactManagerWatcher | undefined;
  triggerPct: number;
}) {
  const { t } = useTranslation("dashboard");
  const shortId = session.session_id.slice(0, 8);
  if (session.unreadable) {
    return (
      <div className="flex items-center gap-3 text-xs">
        <span className="font-mono text-gray-500 w-20 flex-shrink-0">{shortId}</span>
        <span className="text-gray-600">{t("compactManager.unreadable")}</span>
      </div>
    );
  }
  const pct = typeof session.pct === "number" && Number.isFinite(session.pct) ? session.pct : 0;
  // Strings only — the CLI already coerces, but an object here would be
  // an unrenderable React child and take the page down.
  const model = typeof session.model === "string" ? session.model : null;
  const { bar, text } = barColors(pct, triggerPct);
  const flags = watcher?.flags ?? [];
  const watched = Boolean(watcher?.live && flags.length === 0);
  // A watcher row that exists but is not live is a retired/ended watcher —
  // distinct from "never watched", which has no watcher row at all.
  const retired = Boolean(watcher && !watcher.live && flags.length === 0);
  return (
    <div className="flex items-center gap-3 text-xs" data-testid="compact-manager-row">
      <span className="font-mono text-gray-400 w-20 flex-shrink-0" title={session.session_id}>
        {shortId}
      </span>
      <span className="text-gray-500 truncate flex-1 min-w-0" title={model || undefined}>
        {model || "?"}
      </span>
      <span
        className="w-24 h-1.5 rounded-full bg-surface-3/80 overflow-hidden flex-shrink-0"
        title={
          typeof session.current === "number" && typeof session.window === "number"
            ? `${fmt(session.current)} / ${fmt(session.window)}`
            : undefined
        }
      >
        <span
          className={`block h-full rounded-full ${bar} opacity-80`}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </span>
      <span className={`font-mono w-12 text-right flex-shrink-0 ${text}`}>{pct.toFixed(1)}%</span>
      <span className="font-mono text-gray-500 w-14 text-right flex-shrink-0">
        {typeof session.peak === "number" && Number.isFinite(session.peak) ? fmt(session.peak) : ""}
      </span>
      <span className="font-mono text-gray-600 w-10 text-right flex-shrink-0">
        {session.future_mtime
          ? "?"
          : typeof session.age_s === "number"
            ? ageText(session.age_s)
            : ""}
      </span>
      <span className="w-20 flex-shrink-0 text-right">
        {flags.length > 0 ? (
          <span className="text-red-400 font-mono text-[10px]" title={flags.join(", ")}>
            {flags[0]}
          </span>
        ) : watched ? (
          <span className="text-emerald-400 text-[10px]">{t("compactManager.watched")}</span>
        ) : retired ? (
          <span
            className="text-gray-500 text-[10px]"
            title={watcher?.reason ? `${watcher.state}: ${watcher.reason}` : watcher?.state}
          >
            {t("compactManager.retired")}
          </span>
        ) : (
          <span className="text-gray-600 text-[10px]">{t("compactManager.unwatched")}</span>
        )}
      </span>
    </div>
  );
}

/** Muted column titles aligned to SessionRow's fixed widths. */
function SessionHeaderRow() {
  const { t } = useTranslation("dashboard");
  return (
    <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-gray-600">
      <span className="w-20 flex-shrink-0">{t("compactManager.colSession")}</span>
      <span className="flex-1 min-w-0">{t("compactManager.colModel")}</span>
      <span className="w-24 flex-shrink-0">{t("compactManager.colUsage")}</span>
      <span className="w-12 text-right flex-shrink-0">%</span>
      <span className="w-14 text-right flex-shrink-0">{t("compactManager.colPeak")}</span>
      <span className="w-10 text-right flex-shrink-0">{t("compactManager.colUpdated")}</span>
      <span className="w-20 text-right flex-shrink-0">{t("compactManager.colWatcher")}</span>
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
    <div className="overflow-x-auto" data-testid="compact-manager-overrides">
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
          {overrides.map(([pattern, o]) => (
            <tr key={pattern}>
              <td className="pr-6">{pattern}</td>
              <td className="text-right pr-6">
                {typeof o?.context_window === "number" && Number.isFinite(o.context_window)
                  ? fmt(o.context_window)
                  : "?"}
              </td>
              <td className="text-right pr-6">{pctText(o?.soft_pct)}%</td>
              <td className="text-right pr-6">{pctText(o?.hard_pct)}%</td>
              <td className="text-right">{pctText(o?.managed_trigger_pct)}%</td>
            </tr>
          ))}
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
  // without a session id, and never let a missing trigger become NaN —
  // this panel must degrade, never take the Dashboard down with a render
  // throw (the app has no error boundary).
  const watchers = (Array.isArray(overview.watchers) ? overview.watchers : []).filter(
    (w) => typeof w?.session_id === "string"
  );
  const sessions = (Array.isArray(overview.sessions) ? overview.sessions : []).filter(
    (s) => typeof s?.session_id === "string"
  );
  const watcherBySession = new Map(watchers.map((w) => [w.session_id, w]));
  const flagged = watchers.filter((w) => (w.flags?.length ?? 0) > 0);
  const overrides =
    overview.models && typeof overview.models === "object" ? Object.entries(overview.models) : [];
  const triggerPct = Number.isFinite(overview.managed_trigger_pct)
    ? overview.managed_trigger_pct
    : 0.8;

  return (
    <div className="card p-5 flex flex-col gap-3" data-testid="compact-manager-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Archive className="w-4 h-4 text-sky-400" />
          <span className="text-xs text-gray-500 uppercase tracking-wider">
            {t("compactManager.title")}
          </span>
        </div>
        <span className="text-[10px] font-mono text-gray-500">
          {t("compactManager.summaryLine", {
            mode: overview.mode || "?",
            window:
              typeof overview.context_window === "number" &&
              Number.isFinite(overview.context_window)
                ? fmt(overview.context_window)
                : "?",
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
            {flagged
              .map((w) => `${w.session_id.slice(0, 8)}: ${(w.flags ?? []).join(",")}`)
              .join("  ·  ")}
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

      {sessions.length === 0 ? (
        <span className="text-xs text-gray-600">{t("compactManager.noSessions")}</span>
      ) : (
        <div className="space-y-2">
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
          </div>
        </div>
      )}
    </div>
  );
}
