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
import { render, act, screen, cleanup } from "@testing-library/react";
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
        models: {},
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
          { session_id: "cccc3333-oops", unreadable: true },
        ],
      },
    };
    render(<CompactManagerPanel />);
    await settle();
    expect(screen.getByTestId("compact-manager-panel")).toBeTruthy();
    // healthy session row: short id, model, pct
    const rows = screen.getAllByTestId("compact-manager-row");
    expect(rows).toHaveLength(1);
    const rowText = rows[0]?.textContent ?? "";
    expect(rowText).toContain("aaaa1111");
    expect(rowText).toContain("claude-fable-5");
    expect(rowText).toContain("12.3%");
    // unreadable row degrades to its id
    expect(screen.getByText("cccc3333")).toBeTruthy();
    // flagged watcher surfaces in the attention strip
    const flagStrip = screen.getByTestId("compact-manager-flags");
    expect(flagStrip.textContent).toContain("bbbb2222");
    expect(flagStrip.textContent).toContain("DEAD-LEASE");
  });
});
