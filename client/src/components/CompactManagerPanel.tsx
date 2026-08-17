/**
 * @file CompactManagerPanel.tsx
 * @description Persistent dashboard readout of the local compact-manager CLI
 * (context auto-compaction): mode and trigger threshold, watcher health with
 * attention flags, and per-session context usage as the manager itself sees
 * it. Polls GET /api/compact-manager/status; renders nothing on machines
 * where the CLI is absent or failing, so the dashboard stays clean without
 * configuration. Session rows show the manager's own usage numbers (advisor
 * state files), which can differ slightly from the transcript-derived
 * ContextGauge readings elsewhere in the UI.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import type {
  CompactManagerSession,
  CompactManagerStatusPayload,
  CompactManagerWatcher,
} from "../lib/types";
import { fmt } from "../lib/format";

const POLL_MS = 15_000;
const MAX_ROWS = 6;

/** Locale-neutral compact age: 4s / 12m / 2.1h. */
function ageText(ageS: number): string {
  if (ageS < 60) return `${ageS}s`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m`;
  return `${(ageS / 3600).toFixed(1)}h`;
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
  const watched = Boolean(watcher?.live && (watcher?.flags?.length ?? 0) === 0);
  const flags = watcher?.flags ?? [];
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
        ) : (
          <span className="text-gray-600 text-[10px]">{t("compactManager.unwatched")}</span>
        )}
      </span>
    </div>
  );
}

export function CompactManagerPanel() {
  const { t } = useTranslation("dashboard");
  const [status, setStatus] = useState<CompactManagerStatusPayload | null>(null);

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
  const allSessions = (Array.isArray(overview.sessions) ? overview.sessions : []).filter(
    (s) => typeof s?.session_id === "string"
  );
  const watcherBySession = new Map(watchers.map((w) => [w.session_id, w]));
  const flagged = watchers.filter((w) => (w.flags?.length ?? 0) > 0);
  const sessions = allSessions.slice(0, MAX_ROWS);
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
          {t("compactManager.modeLine", {
            mode: overview.mode || "?",
            trigger: Math.round(triggerPct * 100),
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

      {sessions.length === 0 ? (
        <span className="text-xs text-gray-600">{t("compactManager.noSessions")}</span>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <SessionRow
              key={s.session_id}
              session={s}
              watcher={watcherBySession.get(s.session_id)}
              triggerPct={triggerPct}
            />
          ))}
        </div>
      )}
    </div>
  );
}
