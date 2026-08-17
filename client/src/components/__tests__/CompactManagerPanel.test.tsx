/**
 * @file CompactManagerPanel.test.tsx
 * @description The compact-manager readout must render nothing when the CLI
 * is unavailable (or the endpoint errors), and must render session rows with
 * watcher flags surfaced when an overview is present — so machines without
 * compact-manager see a clean dashboard while machines with it get the
 * persistent readout.
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

  it("renders session rows and surfaces watcher flags", async () => {
    payload = {
      available: true,
      fetched_at: Date.now(),
      overview: {
        schema: 1,
        generated_at: Date.now() / 1000,
        mode: "managed",
        context_window: 1_000_000,
        soft_pct: 0.7,
        hard_pct: 0.8,
        managed_trigger_pct: 0.8,
        models: {
          "[1m]": {
            context_window: 1_000_000,
            soft_pct: 0.7,
            hard_pct: 0.8,
            managed_trigger_pct: 0.8,
          },
          fable: {
            context_window: 1_000_000,
            soft_pct: 0.7,
            hard_pct: 0.8,
            managed_trigger_pct: 0.8,
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
        ],
        sessions: [
          {
            session_id: "aaaa1111-live",
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
            model: "claude-fable-5",
            current: 700_000,
            peak: 710_000,
            window: 1_000_000,
            pct: 70,
            updated_epoch: 1,
            age_s: 4000,
          },
          { session_id: "cccc3333-oops", unreadable: true },
        ],
      },
    };
    render(<CompactManagerPanel />);
    await settle();
    expect(screen.getByTestId("compact-manager-panel")).toBeTruthy();
    // healthy session row: short id, model, pct, peak
    const rows = screen.getAllByTestId("compact-manager-row");
    expect(rows).toHaveLength(2);
    const rowText = rows[0]?.textContent ?? "";
    expect(rowText).toContain("aaaa1111");
    expect(rowText).toContain("claude-fable-5");
    expect(rowText).toContain("12.3%");
    expect(rowText).toContain("456"); // peak column (fmt-compacted)
    // retired watcher renders as a muted state, not "unwatched"
    const retiredRow = rows[1]?.textContent ?? "";
    expect(retiredRow).toContain("dddd4444");
    expect(retiredRow).toContain("retired");
    // unreadable row degrades to its id
    expect(screen.getByText("cccc3333")).toBeTruthy();
    // flagged watcher surfaces in the attention strip
    const flagStrip = screen.getByTestId("compact-manager-flags");
    expect(flagStrip.textContent).toContain("bbbb2222");
    expect(flagStrip.textContent).toContain("DEAD-LEASE");
    // model overrides: collapsed by default, table appears on toggle
    expect(screen.queryByTestId("compact-manager-overrides")).toBeNull();
    fireEvent.click(screen.getByTestId("compact-manager-overrides-toggle"));
    const table = screen.getByTestId("compact-manager-overrides");
    expect(table.textContent).toContain("[1m]");
    expect(table.textContent).toContain("fable");
    fireEvent.click(screen.getByTestId("compact-manager-overrides-toggle"));
    expect(screen.queryByTestId("compact-manager-overrides")).toBeNull();
  });

  it("renders every session row (no cap)", async () => {
    payload = {
      available: true,
      fetched_at: Date.now(),
      overview: {
        schema: 1,
        generated_at: Date.now() / 1000,
        mode: "managed",
        context_window: 1_000_000,
        soft_pct: 0.7,
        hard_pct: 0.8,
        managed_trigger_pct: 0.8,
        models: {},
        watchers: [],
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
