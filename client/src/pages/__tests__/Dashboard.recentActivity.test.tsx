/**
 * @file Dashboard.recentActivity.test.tsx
 * @description Regression test for issue #310: the Dashboard's Recent Activity
 * panel used a hand-rolled status mapping that knew only Stop / APIError /
 * PreToolUse, so every other event — and every Codex-native event type — got a
 * misleading yellow "Waiting" badge. Each row must now carry the badge the
 * shared mapping produces, matching what Activity Feed and Session Detail show
 * for the same event.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Dashboard } from "../Dashboard";
import type { DashboardEvent } from "../../lib/types";

// jsdom lacks the responsive-layout API the Dashboard observes.
class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver || (ObserverStub as unknown as typeof ResizeObserver);

let mockEvents: DashboardEvent[] = [];

function makeEvent(overrides: Partial<DashboardEvent> & { id: number }): DashboardEvent {
  return {
    session_id: "sess-codex",
    agent_id: "codex:sess-codex",
    event_type: "codex_task_started",
    tool_name: null,
    summary: null,
    data: null,
    created_at: "2026-08-26T10:00:00.000Z",
    ...overrides,
  } as DashboardEvent;
}

vi.mock("../../lib/api", () => ({
  api: {
    stats: {
      get: vi.fn(() =>
        Promise.resolve({
          total_sessions: 0,
          active_sessions: 0,
          active_agents: 0,
          total_agents: 0,
          total_events: 0,
          events_today: 0,
          ws_connections: 0,
          agents_by_status: {},
          sessions_by_status: {},
        })
      ),
    },
    agents: { list: vi.fn(() => Promise.resolve({ agents: [] })) },
    events: {
      list: vi.fn(() => Promise.resolve({ events: mockEvents, total: mockEvents.length })),
    },
    pricing: { totalCost: vi.fn(() => Promise.resolve({ total_cost: 0 })) },
    sessions: { list: vi.fn(() => Promise.resolve({ sessions: [] })) },
    settings: { info: vi.fn(() => Promise.resolve({})) },
    workflows: { get: vi.fn(() => Promise.resolve({})) },
  },
}));

vi.mock("../../lib/eventBus", () => ({
  eventBus: {
    subscribe: vi.fn(() => () => {}),
    onConnection: vi.fn(() => () => {}),
    connected: true,
  },
}));

/** The badge label rendered alongside a given row summary. */
async function badgeFor(summary: string): Promise<string> {
  const row = (await screen.findByText(summary)).closest("div.px-4") as HTMLElement;
  expect(row).toBeTruthy();
  // The badge is the first status pill in the row.
  const badge = within(row).getByText(/Working|Waiting|Completed|Error/);
  return badge.textContent?.trim() ?? "";
}

describe("Dashboard - Recent Activity status badges", () => {
  beforeEach(() => {
    mockEvents = [];
  });

  // jsdom reports clientHeight 0, so the panel's responsive row budget floors
  // at 3 visible rows — each case below stays within that.
  it("gives each Codex event a badge that matches its meaning", async () => {
    mockEvents = [
      makeEvent({ id: 1, event_type: "codex_task_started", summary: "task_started" }),
      makeEvent({
        id: 2,
        event_type: "codex_tool_call",
        summary: "Called exec",
        tool_name: "Bash",
      }),
      makeEvent({ id: 3, event_type: "codex_task_complete", summary: "task_complete" }),
    ];
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    // The exact three rows issue #310 reported as a misleading "Waiting".
    await waitFor(async () => expect(await badgeFor("task_started")).toBe("Working"));
    expect(await badgeFor("Called exec")).toBe("Working");
    expect(await badgeFor("task_complete")).toBe("Completed");
  });

  it("agrees with the other surfaces on Claude events too", async () => {
    // Fork note: consecutive tool-call events from ONE session roll up into a
    // single row (a complete Pre/Post pair renders as its newest event), so the
    // two tool events live in different sessions here to keep every row visible.
    mockEvents = [
      makeEvent({
        id: 4,
        event_type: "PreToolUse",
        summary: "Running Bash",
        session_id: "sess-claude-a",
      }),
      makeEvent({
        id: 5,
        event_type: "PostToolUse",
        summary: "Bash finished",
        session_id: "sess-claude-b",
      }),
      makeEvent({ id: 6, event_type: "SubagentStop", summary: "Subagent handed back" }),
    ];
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(async () => expect(await badgeFor("Running Bash")).toBe("Working"));
    expect(await badgeFor("Bash finished")).toBe("Waiting");
    // Previously "Waiting" here but "Completed" on the Activity Feed.
    expect(await badgeFor("Subagent handed back")).toBe("Completed");
  });

  it("surfaces failures, whether typed or only described in the summary", async () => {
    mockEvents = [
      makeEvent({ id: 7, event_type: "codex_error", summary: "codex blew up" }),
      makeEvent({ id: 8, event_type: "Stop", summary: "Stopped after an error" }),
      makeEvent({ id: 9, event_type: "Stop", summary: "Turn done" }),
    ];
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(async () => expect(await badgeFor("codex blew up")).toBe("Error"));
    expect(await badgeFor("Stopped after an error")).toBe("Error");
    expect(await badgeFor("Turn done")).toBe("Completed");
  });
});
