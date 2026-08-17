/**
 * @file CompactManagerPanel.test.tsx
 * @description The compact-manager readout must render nothing when the CLI
 * is unavailable (or the endpoint errors), and must render the full overview
 * when one is present — summary values, session rows with consistent units,
 * watcher-only rows, watcher-state precedence, and the collapsible model
 * overrides — while degrading (never throwing) on malformed payload fields,
 * so machines without compact-manager see a clean dashboard while machines
 * with it get the persistent readout.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, screen, cleanup, fireEvent } from "@testing-library/react";
import type { CompactManagerStatusPayload } from "../../lib/types";

let payload: CompactManagerStatusPayload | Error = {
  available: false,
  fetched_at: 0,
  reason: "cli_not_found",
};

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      compactManager: {
        status: vi.fn().mockImplementation(() => {
          if (payload instanceof Error) return Promise.reject(payload);
          return Promise.resolve(payload);
        }),
      },
    },
  };
});

import { CompactManagerPanel } from "../CompactManagerPanel";

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

const BASE_OVERVIEW = {
  schema: 1,
  generated_at: 1_700_000_000,
  mode: "managed",
  context_window: 1_000_000,
  soft_pct: 0.7,
  hard_pct: 0.8,
  managed_trigger_pct: 0.8,
  models: {},
  watchers: [],
  sessions: [],
};

afterEach(cleanup);

describe("CompactManagerPanel", () => {
  it("renders nothing when the CLI is unavailable", async () => {
    payload = { available: false, fetched_at: 0, reason: "cli_not_found" };
    render(<CompactManagerPanel />);
    await settle();
    expect(screen.queryByTestId("compact-manager-panel")).toBeNull();
  });

  it("renders nothing when the endpoint rejects", async () => {
    payload = new Error("network down");
    render(<CompactManagerPanel />);
    await settle();
    expect(screen.queryByTestId("compact-manager-panel")).toBeNull();
  });

  it("survives a shape-drifted overview without crashing the page", async () => {
    // available:true but the arrays are missing — the server rejects this
    // shape, but the client must ALSO degrade (no error boundary exists to
    // catch a render throw).
    payload = {
      available: true,
      fetched_at: Date.now(),
      overview: { schema: 1 } as never,
    };
    render(<CompactManagerPanel />);
    await settle();
    const panel = screen.getByTestId("compact-manager-panel");
    expect(panel).toBeTruthy();
    expect(screen.queryAllByTestId("compact-manager-row")).toHaveLength(0);
  });

  it("survives malformed nested watcher/session fields without crashing", async () => {
    // Field-level drift the server's array check can't catch: flags as a
    // non-array, flags containing objects, non-finite numerics. Must render
    // degraded output, never throw.
    payload = {
      available: true,
      fetched_at: Date.now(),
      overview: {
        ...BASE_OVERVIEW,
        watchers: [
          {
            session_id: "aaaa1111-bad-flags",
            pid: 1,
            state: "WATCHER_READY",
            live: true,
            reason: null,
            flags: { length: 1 } as never,
          },
          {
            session_id: "bbbb2222-obj-flag",
            pid: 2,
            state: "WATCHER_READY",
            live: true,
            reason: null,
            flags: [{} as never, "ATTENTION"],
          },
          {
            session_id: "cccc3333-bad-state",
            pid: 3,
            state: 42 as never,
            live: false,
            reason: {} as never,
            flags: [],
          },
        ],
        sessions: [
          {
            session_id: "aaaa1111-bad-flags",
            model: "claude-fable-5",
            current: NaN,
            peak: Infinity,
            window: 1_000_000,
            pct: NaN,
            updated_epoch: 1,
            age_s: NaN,
          },
          {
            session_id: "dddd4444-zero-window",
            model: "claude-fable-5",
            current: 500,
            peak: 1000,
            window: 0,
            pct: 50,
            updated_epoch: 1,
            age_s: 5,
          },
        ],
      },
    };
    render(<CompactManagerPanel />);
    await settle();
    const rows = screen.getAllByTestId("compact-manager-row");
    // 2 session rows + watcher-only rows for bbbb2222 and cccc3333
    expect(rows).toHaveLength(4);
    const rowText = rows[0]?.textContent ?? "";
    // non-finite numerics surface as "?", never NaN/Infinity/fake 0.0%
    expect(rowText).toContain("?");
    expect(rowText).not.toContain("NaN");
    expect(rowText).not.toContain("Infinity");
    expect(rowText).not.toContain("0.0%");
    // zero window: peak tokens still render (the column is token-scaled)
    const zeroWindowRow = rows.find((r) => r.textContent?.includes("dddd4444"));
    expect(zeroWindowRow?.textContent).toContain("1.0K");
    // the object entry in flags is dropped; the string entry survives
    expect(screen.getByTestId("compact-manager-flags").textContent).toContain("ATTENTION");
    // flags win over live in the row's watcher cell (not just the strip)
    const liveFlagRow = rows.find((r) => r.textContent?.includes("bbbb2222"));
    expect(liveFlagRow?.textContent).toContain("ATTENTION");
    expect(liveFlagRow?.textContent).not.toContain("watched");
    // non-string state/reason degrade to "?" placeholder, no crash, and the
    // object reason never leaks into a title attribute
    const badStateRow = rows.find((r) => r.textContent?.includes("cccc3333"));
    expect(badStateRow?.textContent).toContain("?");
    expect(badStateRow?.innerHTML ?? "").not.toContain("object Object");
  });

  it("renders the full overview: summary, overrides, session rows, watcher states", async () => {
    payload = {
      available: true,
      fetched_at: Date.now(),
      overview: {
        ...BASE_OVERVIEW,
        // trigger deliberately differs from hard so the summary assertion
        // can't pass on a copied value
        managed_trigger_pct: 0.75,
        models: {
          "[1m]": {
            context_window: 1_000_000,
            soft_pct: 0.7,
            hard_pct: 0.8,
            managed_trigger_pct: 0.8,
          },
          fable: {
            context_window: 500_000,
            soft_pct: 0.6,
            hard_pct: 0.75,
            managed_trigger_pct: 0.75,
          },
        },
        watchers: [
          {
            session_id: "aaaa1111-live",
            pid: 42,
            state: "WATCHER_READY",
            live: true,
            reason: null,
            flags: [],
          },
          {
            session_id: "bbbb2222-dead",
            pid: null,
            state: "WATCHER_READY",
            live: false,
            reason: null,
            flags: ["DEAD-LEASE"],
          },
          {
            session_id: "dddd4444-done",
            pid: null,
            state: "WATCHER_RETIRED",
            live: false,
            reason: "deadline",
            flags: [],
          },
          {
            session_id: "eeee5555-old",
            pid: null,
            state: "WATCHER_RETIRED",
            live: false,
            reason: "deadline",
            flags: [],
          },
          {
            // live wins over a (contradictory) retired state
            session_id: "gggg7777-live-retired",
            pid: 7,
            state: "WATCHER_RETIRED",
            live: true,
            reason: null,
            flags: [],
          },
          {
            // watcher on an unreadable session must not disappear
            session_id: "cccc3333-oops",
            pid: null,
            state: "WATCHER_RETIRED",
            live: false,
            reason: "deadline",
            flags: [],
          },
        ],
        sessions: [
          {
            session_id: "aaaa1111-live",
            session_live: true,
            model: "claude-fable-5",
            current: 123_000,
            peak: 456_000,
            window: 1_000_000,
            pct: 12.3,
            updated_epoch: 1,
            age_s: 4,
          },
          {
            session_id: "dddd4444-done",
            session_live: false,
            model: "claude-fable-5",
            current: 700_000,
            peak: 710_000,
            window: 1_000_000,
            pct: 70,
            updated_epoch: 1,
            age_s: 4000,
          },
          {
            session_id: "ffff6666-future",
            model: "claude-fable-5",
            current: 10_000,
            peak: 10_000,
            window: 1_000_000,
            pct: 1,
            updated_epoch: 1,
            future_mtime: true,
          },
          {
            session_id: "gggg7777-live-retired",
            session_live: null,
            model: "claude-fable-5",
            current: 20_000,
            peak: 20_000,
            window: 1_000_000,
            pct: 2,
            updated_epoch: 1,
            age_s: 9,
          },
          { session_id: "cccc3333-oops", unreadable: true },
        ],
      },
    };
    render(<CompactManagerPanel />);
    await settle();
    const panel = screen.getByTestId("compact-manager-panel");
    expect(panel).toBeTruthy();

    // summary carries all five values — trigger (75%) differs from
    // hard (80%) so a copied value can't satisfy this
    const panelText = panel.textContent ?? "";
    expect(panelText).toContain("mode: managed");
    // the session table names its 24h window and row count (5 session
    // rows incl. the unreadable one + 2 watcher-only rows)
    expect(panelText).toContain("24h (7)");
    expect(panelText).toContain("1.0M");
    expect(panelText).toContain("70%");
    expect(panelText).toContain("80%");
    expect(panelText).toContain("75%");

    // column headers
    for (const label of ["session", "model", "usage", "current", "peak", "updated", "watcher"]) {
      expect(panelText.toLowerCase()).toContain(label);
    }

    // session rows + watcher-only rows (bbbb2222 and eeee5555 have no
    // session row) — unreadable rows render outside the data-testid
    const rows = screen.getAllByTestId("compact-manager-row");
    expect(rows).toHaveLength(6);
    const row = (id: string) => rows.find((r) => r.textContent?.includes(id))?.textContent ?? "";

    // healthy row: CLI-mirroring units — current and peak as token
    // counts, percentage as its own column
    const rowText = row("aaaa1111");
    expect(rowText).toContain("claude-fable-5");
    expect(rowText).toContain("123.0K");
    expect(rowText).toContain("456.0K");
    expect(rowText).toContain("12.3%");
    expect(rowText).toContain("watched");
    // full watcher detail columns: pid and short state
    expect(rowText).toContain("42");
    expect(rowText).toContain("READY");

    // retired watcher renders as retired, not unwatched — with its
    // retirement reason in the reason column
    expect(row("dddd4444")).toContain("retired");
    expect(row("dddd4444")).toContain("deadline");

    // CLI liveness verdict: live rows carry the dot, dead rows dim and get
    // a gray dot; rows without the field or explicit null show no dot
    const liveRowEl = rows.find((r) => r.textContent?.includes("aaaa1111"));
    expect(liveRowEl?.getAttribute("data-live")).toBe("true");
    expect(liveRowEl?.className).not.toContain("opacity-50");
    expect(liveRowEl?.querySelector("[title='session running']")).toBeTruthy();
    const goneRowEl = rows.find((r) => r.textContent?.includes("dddd4444"));
    expect(goneRowEl?.getAttribute("data-live")).toBe("false");
    expect(goneRowEl?.className).toContain("opacity-50");
    expect(goneRowEl?.querySelector("[title='session exited — state lingering']")).toBeTruthy();
    // absent field (ffff6666) and explicit null (gggg7777) both read unknown
    for (const id of ["ffff6666", "gggg7777"]) {
      const el = rows.find((r) => r.textContent?.includes(id));
      expect(el?.getAttribute("data-live")).toBe("unknown");
      expect(el?.className).not.toContain("opacity-50");
      expect(el?.querySelector("[title^='session ']")).toBeNull();
    }

    // future_mtime renders "?" for age
    expect(row("ffff6666")).toContain("?");

    // live wins over a contradictory retired state
    expect(row("gggg7777")).toContain("watched");

    // watcher-only rows: id, dashes, state — no fabricated usage. The
    // flagged sessionless watcher shows its flag; the retired one, "retired".
    const deadRow = row("bbbb2222");
    expect(deadRow).toContain("—");
    expect(deadRow).toContain("DEAD-LEASE");
    const watcherOnlyRow = row("eeee5555");
    expect(watcherOnlyRow).toContain("—");
    expect(watcherOnlyRow).toContain("retired");

    // unreadable row degrades to its id but keeps its watcher's state
    const unreadableRow = screen.getByText("cccc3333").parentElement;
    expect(unreadableRow?.textContent).toContain("retired");

    // flagged watcher surfaces in the attention strip
    const flagStrip = screen.getByTestId("compact-manager-flags");
    expect(flagStrip.textContent).toContain("bbbb2222");
    expect(flagStrip.textContent).toContain("DEAD-LEASE");

    // model overrides: collapsed by default; rows join the SAME table as
    // the always-visible global row on toggle (column-aligned formats)
    expect(screen.queryAllByTestId("compact-manager-override-row")).toHaveLength(0);
    const toggle = screen.getByTestId("compact-manager-overrides-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const overrideRows = screen.getAllByTestId("compact-manager-override-row");
    expect(overrideRows).toHaveLength(2);
    const rowsText = overrideRows.map((r) => r.textContent ?? "").join(" ");
    expect(rowsText).toContain("[1m]");
    expect(rowsText).toContain("fable");
    expect(rowsText).toContain("1.0M");
    expect(rowsText).toContain("500.0K");
    expect(rowsText).toContain("60%");
    expect(rowsText).toContain("75%");
    fireEvent.click(toggle);
    expect(screen.queryAllByTestId("compact-manager-override-row")).toHaveLength(0);
  });

  it("renders every session row (no cap)", async () => {
    payload = {
      available: true,
      fetched_at: Date.now(),
      overview: {
        ...BASE_OVERVIEW,
        sessions: Array.from({ length: 9 }, (_, i) => ({
          session_id: `sess${i}000-0000-0000-0000-000000000000`,
          model: "claude-fable-5",
          current: 10_000,
          peak: 10_000,
          window: 1_000_000,
          pct: 1,
          updated_epoch: 1,
          age_s: 10,
        })),
      },
    };
    render(<CompactManagerPanel />);
    await settle();
    expect(screen.getAllByTestId("compact-manager-row")).toHaveLength(9);
    // no overrides -> no toggle at all
    expect(screen.queryByTestId("compact-manager-overrides-toggle")).toBeNull();
  });
});
