/**
 * @file Tests for the watchdog's Claude Code and Codex process-liveness reap.
 * A session whose SessionEnd hook was lost must complete only when its matching
 * provider CLI is no longer alive in that working directory. Covers:
 *   - the provider command matchers,
 *   - probeLiveCwds shape + env escape hatch,
 *   - the reap itself: dead session → completed (agents completed, awaiting
 *     cleared, synthetic SessionEnd event), live session → untouched,
 *   - all fail-safe guards (probe unavailable, fresh activity, no cwd),
 *   - hook reactivation after a (hypothetical) false completion.
 * The probe is stubbed by swapping `liveness.probeLiveCwds` on the shared
 * module object — routes/hooks.js looks the function up at call time.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const STAMP = `liveness-${Date.now()}-${process.pid}`;
const TMP = path.join(os.tmpdir(), STAMP);
const CLAUDE_HOME = path.join(TMP, "home");
const DATA_DIR = path.join(TMP, "data");
const TEST_DB = path.join(TMP, "dashboard.db");
process.env.DASHBOARD_DB_PATH = TEST_DB;
process.env.CLAUDE_HOME = CLAUDE_HOME;
process.env.DASHBOARD_DATA_DIR = DATA_DIR;
// Keep the REAL probe inert for any watchdog interval tick that fires while
// this suite runs — stubbed probes below bypass this env check entirely.
process.env.DASHBOARD_LIVENESS_PROBE = "0";

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const liveness = require("../lib/session-liveness");
const hooksRouter = require("../routes/hooks");

const realProbe = liveness.probeLiveCwds;
const realRolloutProbe = liveness.probeLiveCodexRollouts;
const realProbeAgentPidLive = liveness.probeAgentPidLive;

const enc = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const PROJECTS = path.join(CLAUDE_HOME, "projects");

function writeTranscript(cwd, sessionId, lines) {
  const p = path.join(PROJECTS, enc(cwd), `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return p;
}

/** Backdate a session row + its transcript so the idle gate passes. */
function backdate(sessionId, tpath, ageMs = 10 * 60 * 1000) {
  const old = new Date(Date.now() - ageMs);
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(old.toISOString(), sessionId);
  if (tpath) fs.utimesSync(tpath, old, old);
}

function req(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(b || "{}");
          } catch {
            parsed = b;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Create a session + transcript via a real hook event, then backdate it. */
async function seedSession(sid, cwd, { old = true } = {}) {
  const tpath = writeTranscript(cwd, sid, [
    { type: "user", message: { role: "user", content: "hello" } },
  ]);
  const res = await req("POST", "/api/hooks/event", {
    hook_type: "Stop",
    data: { session_id: sid, cwd, transcript_path: tpath },
  });
  assert.equal(res.status, 200);
  if (old) backdate(sid, tpath);
  return tpath;
}

function seedCodexSession(sid, cwd, { old = true } = {}) {
  const tpath = writeTranscript(cwd, sid, [
    { type: "event_msg", payload: { type: "task_complete" } },
  ]);
  const now = new Date().toISOString();
  const metadata = JSON.stringify({ provider: "codex", transcript_path: tpath });
  stmts.insertCodexSession.run(
    sid,
    "Codex session",
    "active",
    cwd,
    "gpt-5",
    "local",
    now,
    now,
    metadata
  );
  stmts.setSessionTranscriptPath.run(tpath, sid);
  stmts.insertAgent.run(
    `codex:${sid}`,
    sid,
    "Codex",
    "main",
    null,
    "waiting",
    null,
    null,
    metadata
  );
  stmts.setSessionAwaitingInput.run(now, "stop", sid);
  stmts.setAgentAwaitingInput.run(now, "stop", `codex:${sid}`);
  if (old) backdate(sid, tpath);
  return tpath;
}

let server;
let BASE;

before(async () => {
  const app = createApp();
  server = await startServer(app, 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  liveness.probeLiveCwds = realProbe;
  liveness.probeLiveCodexRollouts = realRolloutProbe;
  liveness.probeAgentPidLive = realProbeAgentPidLive;
  if (server) server.close();
  if (db) db.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  liveness.probeLiveCwds = realProbe;
  liveness.probeLiveCodexRollouts = realRolloutProbe;
  liveness.probeAgentPidLive = realProbeAgentPidLive;
});

describe("isClaudeCommand — claude CLI process matcher", () => {
  const yes = [
    "claude",
    "claude --dangerously-skip-permissions",
    "/usr/local/bin/claude -p hello",
    "/Users/x/.local/bin/claude --resume abc",
    "node /Users/x/.nvm/versions/node/v22.0.0/bin/claude",
    "bun /opt/homebrew/bin/claude --model opus",
  ];
  const no = [
    "claude-mem --daemon",
    "/Applications/Claude.app/Contents/MacOS/Claude",
    "grep claude",
    "node /app/server/index.js",
    "node /Users/x/claude-dashboard/index.js",
    "tail -f claude.log",
    "",
  ];
  for (const cmd of yes) {
    it(`matches: ${cmd || "(empty)"}`, () => assert.equal(liveness.isClaudeCommand(cmd), true));
  }
  for (const cmd of no) {
    it(`rejects: ${cmd || "(empty)"}`, () => assert.equal(liveness.isClaudeCommand(cmd), false));
  }
});

describe("isCodexCommand — Codex CLI process matcher", () => {
  for (const cmd of [
    "codex",
    "codex resume --last",
    "/usr/local/bin/codex --model gpt-5",
    "bun /opt/bin/codex",
  ]) {
    it(`matches: ${cmd}`, () => assert.equal(liveness.isCodexCommand(cmd), true));
  }
  for (const cmd of ["codex-helper", "grep codex", "node /app/codex-dashboard/index.js"]) {
    it(`rejects: ${cmd}`, () => assert.equal(liveness.isCodexCommand(cmd), false));
  }
});

describe("probeLiveCwds — probe availability", () => {
  it("returns a well-formed result without throwing", () => {
    delete process.env.DASHBOARD_LIVENESS_PROBE;
    try {
      const r = realProbe();
      assert.equal(typeof r.available, "boolean");
      assert.ok(r.cwds instanceof Set);
    } finally {
      process.env.DASHBOARD_LIVENESS_PROBE = "0";
    }
  });

  it("is disabled by DASHBOARD_LIVENESS_PROBE=0", () => {
    const r = realProbe(); // env is "0" for this whole suite
    assert.equal(r.available, false);
    assert.equal(r.cwds.size, 0);
  });

  it("is disabled inside a container (CCAM_FORCE_CONTAINER)", () => {
    delete process.env.DASHBOARD_LIVENESS_PROBE;
    process.env.CCAM_FORCE_CONTAINER = "1";
    try {
      assert.equal(realProbe().available, false);
    } finally {
      delete process.env.CCAM_FORCE_CONTAINER;
      process.env.DASHBOARD_LIVENESS_PROBE = "0";
    }
  });
});

describe("watchdog liveness reap", () => {
  it("reaps an idle Codex session with no live codex process using the same safe guard", () => {
    const sid = "cdead000-0000-0000-0000-000000000001";
    const cwd = "/tmp/liveness-codex-dead";
    seedCodexSession(sid, cwd);

    let probedBinary = null;
    liveness.probeLiveCwds = (binary) => {
      probedBinary = binary;
      return { available: true, cwds: new Set() };
    };
    hooksRouter.livenessReap({ provider: "codex" });

    assert.equal(probedBinary, "codex");
    assert.equal(stmts.getSession.get(sid).status, "completed");
    assert.equal(stmts.getSession.get(sid).awaiting_input_since, null);
    assert.equal(stmts.getAgent.get(`codex:${sid}`).status, "completed");
    const event = db
      .prepare(
        "SELECT * FROM events WHERE session_id = ? AND event_type = 'SessionEnd' ORDER BY id DESC LIMIT 1"
      )
      .get(sid);
    assert.match(event.summary, /no running codex process/);
    assert.equal(JSON.parse(event.data).provider, "codex");
  });

  it("completes an idle active session whose cwd has no live claude process", async () => {
    const sid = "dead0000-0000-0000-0000-000000000001";
    const cwd = "/tmp/liveness-dead";
    await seedSession(sid, cwd);
    assert.equal(stmts.getSession.get(sid).status, "active");
    assert.ok(stmts.getSession.get(sid).awaiting_input_since, "seeded as Waiting");
    assert.equal(stmts.getSession.get(sid).awaiting_reason, "stop", "seeded via Stop hook");

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.livenessReap();

    const sess = stmts.getSession.get(sid);
    assert.equal(sess.status, "completed");
    assert.ok(sess.ended_at, "ended_at stamped");
    assert.equal(sess.awaiting_input_since, null, "Waiting flag cleared");
    assert.equal(sess.awaiting_reason, null, "awaiting_reason cleared alongside the flag");
    const main = stmts.getAgent.get(`${sid}-main`);
    assert.equal(main.status, "completed");
    assert.equal(main.awaiting_input_since, null);
    assert.equal(main.awaiting_reason, null);
    const evt = db
      .prepare(
        "SELECT * FROM events WHERE session_id = ? AND event_type = 'SessionEnd' ORDER BY created_at DESC LIMIT 1"
      )
      .get(sid);
    assert.ok(evt, "synthetic SessionEnd event recorded");
    assert.match(evt.summary, /no running claude process/);
    assert.equal(JSON.parse(evt.data).source, "liveness-probe");
  });

  it("leaves a session alone when a claude process runs in its cwd", async () => {
    const sid = "live0000-0000-0000-0000-000000000002";
    const cwd = "/tmp/liveness-alive";
    await seedSession(sid, cwd);

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set([path.resolve(cwd)]) });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "active");
  });

  it("spares a household-hook session with a non-POSIX (Windows) cwd, even with zero live local processes", async () => {
    // A session forwarded from a Windows machine reports cwd in that origin
    // machine's own syntax. path.resolve() on this (POSIX) host doesn't
    // recognize it as absolute, so it can never match anything the local
    // /proc or lsof scan produces — that mismatch must not be treated as
    // "process is dead".
    const sid = "wind0000-0000-0000-0000-00000000000c";
    const cwd = "D:\\Git\\ai-deck";
    await seedSession(sid, cwd);

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "active");
  });

  it("still reaps a genuinely local (POSIX) cwd not in probe.cwds — regression guard", async () => {
    const sid = "posx0000-0000-0000-0000-00000000000d";
    const cwd = "/home/claude/projects/some-repo";
    await seedSession(sid, cwd);

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "completed");
  });

  it("distinguishes old and live Codex rollouts that share the same cwd", () => {
    const cwd = "/tmp/liveness-shared-codex";
    const liveId = "cliv0000-0000-0000-0000-000000000011";
    const deadId = "cded0000-0000-0000-0000-000000000012";
    const livePath = seedCodexSession(liveId, cwd);
    seedCodexSession(deadId, cwd);

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set([path.resolve(cwd)]) });
    liveness.probeLiveCodexRollouts = () => ({
      available: true,
      paths: new Set([path.resolve(livePath)]),
    });
    hooksRouter.livenessReap({ provider: "codex" });

    assert.equal(stmts.getSession.get(liveId).status, "active");
    assert.equal(stmts.getSession.get(deadId).status, "completed");
  });

  it("does nothing when the probe is unavailable", async () => {
    const sid = "unav0000-0000-0000-0000-000000000003";
    const cwd = "/tmp/liveness-unavailable";
    await seedSession(sid, cwd);

    liveness.probeLiveCwds = () => ({ available: false, cwds: new Set() });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "active");
  });

  it("spares sessions with recent activity (idle gate)", async () => {
    const sid = "frsh0000-0000-0000-0000-000000000004";
    const cwd = "/tmp/liveness-fresh";
    await seedSession(sid, cwd, { old: false }); // updated_at + mtime are NOW

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "active");
  });

  it("reaps a just-imported dead session: fresh updated_at, old transcript mtime", async () => {
    // The boot shape: the startup sync imports a transcript last touched when
    // the user quit (old mtime) but stamps updated_at = NOW. The gate must key
    // on the transcript mtime, or the dead session sits in Waiting for a full
    // extra LIVENESS_IDLE_SECONDS after every dashboard start.
    const sid = "boot0000-0000-0000-0000-000000000009";
    const cwd = "/tmp/liveness-boot-import";
    const tpath = await seedSession(sid, cwd, { old: false });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(tpath, old, old); // transcript stopped moving 10 min ago
    // updated_at stays fresh (the import just wrote the row).

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "completed");
  });

  it("boot pass (ignoreIdleGate) reaps a session quit seconds before launch", async () => {
    // The reported flow: quit the session, IMMEDIATELY start the dashboard.
    // Transcript mtime is only seconds old, so the gated reap would wait a
    // full LIVENESS_IDLE_SECONDS — the boot passes must skip the gate and
    // trust the probe alone.
    const sid = "qikq0000-0000-0000-0000-00000000000a";
    const cwd = "/tmp/liveness-quick-quit";
    await seedSession(sid, cwd, { old: false }); // mtime + updated_at are NOW

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.livenessReap({ ignoreIdleGate: true });

    assert.equal(stmts.getSession.get(sid).status, "completed");
  });

  it("boot pass still spares a session whose claude process is alive", async () => {
    const sid = "qikl0000-0000-0000-0000-00000000000b";
    const cwd = "/tmp/liveness-quick-live";
    await seedSession(sid, cwd, { old: false });

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set([path.resolve(cwd)]) });
    hooksRouter.livenessReap({ ignoreIdleGate: true });

    assert.equal(stmts.getSession.get(sid).status, "active");
  });

  it("skips sessions without a cwd", async () => {
    const sid = "nocw0000-0000-0000-0000-000000000005";
    await req("POST", "/api/hooks/event", {
      hook_type: "Stop",
      data: { session_id: sid },
    });
    backdate(sid, null);

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "active");
  });

  it("spares a remote-source session with a POSIX cwd and no live local process", async () => {
    // A Remote Data Source session (source = a remote id) legitimately reports a
    // POSIX-absolute cwd on another machine (e.g. /home/ubuntu/matroid) that no
    // local claude process owns. The posix-cwd guard can't catch it, so the
    // source guard must: local process liveness says nothing about a remote box.
    const sid = "rmt00000-0000-0000-0000-00000000000e";
    const cwd = "/home/ubuntu/matroid";
    const tpath = await seedSession(sid, cwd);
    db.prepare("UPDATE sessions SET source = ? WHERE id = ?").run("src_remotebox", sid);
    backdate(sid, tpath);

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "active", "remote session must not be reaped");
  });

  it("does not touch error sessions", async () => {
    const sid = "errr0000-0000-0000-0000-000000000006";
    const cwd = "/tmp/liveness-error";
    const tpath = await seedSession(sid, cwd);
    stmts.updateSession.run(null, "error", null, null, sid);
    backdate(sid, tpath);

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "error");
  });

  it("a reaped session reactivates on the next hook event (self-heal)", async () => {
    const sid = "heal0000-0000-0000-0000-000000000007";
    const cwd = "/tmp/liveness-heal";
    const tpath = await seedSession(sid, cwd);

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.livenessReap();
    assert.equal(stmts.getSession.get(sid).status, "completed");

    const res = await req("POST", "/api/hooks/event", {
      hook_type: "UserPromptSubmit",
      data: { session_id: sid, cwd, transcript_path: tpath },
    });
    assert.equal(res.status, 200);
    assert.equal(stmts.getSession.get(sid).status, "active");
    assert.equal(stmts.getAgent.get(`${sid}-main`).status, "working");
  });

  it("full watchdogCheck runs the reap end-to-end", async () => {
    const sid = "wdog0000-0000-0000-0000-000000000008";
    const cwd = "/tmp/liveness-watchdog";
    await seedSession(sid, cwd);

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.watchdogCheck();

    assert.equal(stmts.getSession.get(sid).status, "completed");
  });
});

describe("owner-pid exact liveness (cwd-drift fix)", () => {
  // The regression that motivated owner_pid: the session's recorded cwd
  // follows in-session `cd` (hook payload cwd), while the claude process's
  // /proc cwd stays at the launch directory — so the cwd-set match reaped
  // LIVE sessions whenever the user changed directory in the Bash tool.
  it("spares a live session whose recorded cwd drifted away from the process cwd", async () => {
    const sid = "opid0000-0000-0000-0000-000000000001";
    const cwd = "/tmp/liveness-drifted-recorded-cwd";
    await seedSession(sid, cwd);
    stmts.setSessionOwnerPid.run(4242, "start-token", sid);

    // cwd probe says "no claude here" (the false-positive input)…
    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    // …but the exact process check says the owner is alive.
    liveness.probeAgentPidLive = () => ({ available: true, alive: true });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "active");
  });

  it("reaps a dead session even when an unrelated claude runs in the same cwd", async () => {
    const sid = "opid0000-0000-0000-0000-000000000002";
    const cwd = "/tmp/liveness-shared-cwd";
    await seedSession(sid, cwd);
    stmts.setSessionOwnerPid.run(4243, "start-token", sid);

    // cwd probe would have spared it (another claude lives in this dir)…
    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set([path.resolve(cwd)]) });
    // …but the exact process check proves THIS session's process is gone.
    liveness.probeAgentPidLive = () => ({ available: true, alive: false });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "completed");
  });

  it("falls back to the cwd probe when the owner verdict is unavailable", async () => {
    const sid = "opid0000-0000-0000-0000-000000000003";
    const cwd = "/tmp/liveness-owner-unavailable";
    await seedSession(sid, cwd);
    stmts.setSessionOwnerPid.run(4244, null, sid);

    liveness.probeAgentPidLive = () => ({ available: false, alive: false });
    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set([path.resolve(cwd)]) });
    hooksRouter.livenessReap();
    assert.equal(stmts.getSession.get(sid).status, "active", "cwd match spares it");

    liveness.probeLiveCwds = () => ({ available: true, cwds: new Set() });
    hooksRouter.livenessReap();
    assert.equal(stmts.getSession.get(sid).status, "completed", "cwd mismatch reaps it");
  });

  it("owner-dead verdict still respects the idle gate on watchdog ticks", async () => {
    const sid = "opid0000-0000-0000-0000-000000000004";
    const cwd = "/tmp/liveness-owner-idle-gate";
    await seedSession(sid, cwd, { old: false }); // fresh activity
    stmts.setSessionOwnerPid.run(4245, null, sid);

    liveness.probeAgentPidLive = () => ({ available: true, alive: false });
    hooksRouter.livenessReap();

    assert.equal(stmts.getSession.get(sid).status, "active");
  });

  it("hook ingestion records the sender's owner pid onto the session (loopback)", async () => {
    const sid = "opid0000-0000-0000-0000-000000000005";
    const cwd = "/tmp/liveness-owner-record";
    const res = await req("POST", "/api/hooks/event", {
      hook_type: "UserPromptSubmit",
      data: { session_id: sid, cwd },
      sender: { pid: 31337, start: "9876543" },
    });
    assert.equal(res.status, 200);
    const sess = stmts.getSession.get(sid);
    assert.equal(sess.owner_pid, 31337);
    assert.equal(sess.owner_pid_start, "9876543");
  });

  it("ignores malformed sender reports", async () => {
    const sid = "opid0000-0000-0000-0000-000000000006";
    const cwd = "/tmp/liveness-owner-malformed";
    const res = await req("POST", "/api/hooks/event", {
      hook_type: "UserPromptSubmit",
      data: { session_id: sid, cwd },
      sender: { pid: "not-a-number", start: 12345 },
    });
    assert.equal(res.status, 200);
    const sess = stmts.getSession.get(sid);
    assert.equal(sess.owner_pid, null);
    assert.equal(sess.owner_pid_start, null);
  });

  it("a resumed session's new process replaces the recorded owner", async () => {
    const sid = "opid0000-0000-0000-0000-000000000007";
    const cwd = "/tmp/liveness-owner-resume";
    await req("POST", "/api/hooks/event", {
      hook_type: "SessionStart",
      data: { session_id: sid, cwd },
      sender: { pid: 100, start: "a" },
    });
    await req("POST", "/api/hooks/event", {
      hook_type: "UserPromptSubmit",
      data: { session_id: sid, cwd },
      sender: { pid: 200, start: "b" },
    });
    const sess = stmts.getSession.get(sid);
    assert.equal(sess.owner_pid, 200);
    assert.equal(sess.owner_pid_start, "b");
  });

  it("a loopback event without a sender clears a stale recorded owner", async () => {
    // Resume path whose ancestry lookup failed: keeping the OLD process's
    // identity would let its death reap the live resumed session.
    const sid = "opid0000-0000-0000-0000-000000000008";
    const cwd = "/tmp/liveness-owner-clear";
    await req("POST", "/api/hooks/event", {
      hook_type: "SessionStart",
      data: { session_id: sid, cwd },
      sender: { pid: 300, start: "c" },
    });
    assert.equal(stmts.getSession.get(sid).owner_pid, 300);

    await req("POST", "/api/hooks/event", {
      hook_type: "UserPromptSubmit",
      data: { session_id: sid, cwd },
    });
    const sess = stmts.getSession.get(sid);
    assert.equal(sess.owner_pid, null);
    assert.equal(sess.owner_pid_start, null);
  });

  it("rejects a sender without a start token (no reuse guard, no exact probe)", async () => {
    const sid = "opid0000-0000-0000-0000-000000000009";
    const cwd = "/tmp/liveness-owner-tokenless";
    await req("POST", "/api/hooks/event", {
      hook_type: "SessionStart",
      data: { session_id: sid, cwd },
      sender: { pid: 400 },
    });
    assert.equal(stmts.getSession.get(sid).owner_pid, null);
  });

  it("ignores sender reports on proxied requests (forwarding header present)", async () => {
    const sid = "opid0000-0000-0000-0000-00000000000a";
    const cwd = "/tmp/liveness-owner-proxied";
    await req(
      "POST",
      "/api/hooks/event",
      {
        hook_type: "SessionStart",
        data: { session_id: sid, cwd },
        sender: { pid: 500, start: "e" },
      },
      { "X-Forwarded-For": "192.168.1.50" }
    );
    const sess = stmts.getSession.get(sid);
    assert.equal(sess.owner_pid, null);
    assert.equal(sess.owner_pid_start, null);
  });
});

describe("probeAgentPidLive / findAgentAncestor — real-process behavior", () => {
  // These run against the REAL implementations (no stubs). The suite sets
  // DASHBOARD_LIVENESS_PROBE=0 globally, so flip it on per-test and restore.
  function withProbeEnabled(fn) {
    const saved = process.env.DASHBOARD_LIVENESS_PROBE;
    process.env.DASHBOARD_LIVENESS_PROBE = "1";
    try {
      return fn();
    } finally {
      process.env.DASHBOARD_LIVENESS_PROBE = saved;
    }
  }
  const posixOnly = process.platform === "win32" ? it.skip : it;

  it("is disabled by DASHBOARD_LIVENESS_PROBE=0", () => {
    assert.deepEqual(realProbeAgentPidLive(process.pid, null, "node"), {
      available: false,
      alive: false,
    });
  });

  posixOnly("reports the test's own node process alive when matched as 'node'", () => {
    withProbeEnabled(() => {
      // findAgentAncestor("node", own pid) resolves to this process and its
      // real start token — the same pair the hook handler would report.
      const self = liveness.findAgentAncestor("node", process.pid);
      assert.ok(self && self.start, "resolved own process with a start token");
      const verdict = realProbeAgentPidLive(self.pid, self.start, "node");
      assert.deepEqual(verdict, { available: true, alive: true });
    });
  });

  posixOnly("refuses to answer without a start token (reuse guard mandatory)", () => {
    withProbeEnabled(() => {
      const verdict = realProbeAgentPidLive(process.pid, null, "node");
      assert.deepEqual(verdict, { available: false, alive: false });
    });
  });

  posixOnly("treats an args mismatch (pid reused by another command) as dead", () => {
    withProbeEnabled(() => {
      const verdict = realProbeAgentPidLive(process.pid, "any-token", "claude");
      assert.deepEqual(verdict, { available: true, alive: false });
    });
  });

  posixOnly("treats a start-token mismatch (pid reuse by same CLI) as dead", () => {
    withProbeEnabled(() => {
      const verdict = realProbeAgentPidLive(process.pid, "not-the-real-start-token", "node");
      assert.deepEqual(verdict, { available: true, alive: false });
    });
  });

  posixOnly("reports a long-gone pid as authoritatively dead", () => {
    withProbeEnabled(() => {
      // PID 2^22 is beyond the default pid_max on Linux and unused in practice;
      // if it happens to exist it won't be a claude process.
      const verdict = realProbeAgentPidLive(4194304, "any-token", "claude");
      assert.deepEqual(verdict, { available: true, alive: false });
    });
  });

  posixOnly("findAgentAncestor locates an ancestor by CLI name", () => {
    // Walking up from our own pid with binary 'node' finds the test process
    // itself (tokens[0] is the node binary).
    const found = liveness.findAgentAncestor("node", process.pid);
    assert.ok(found, "expected to find the node test process");
    assert.equal(found.pid, process.pid);
    assert.ok(found.start, "start token captured");
  });

  posixOnly("findAgentAncestor returns null when no ancestor matches", () => {
    // NOT "claude": when this suite runs from inside a Claude Code session
    // (e.g. the pre-commit hook), claude genuinely IS an ancestor.
    assert.equal(liveness.findAgentAncestor("no-such-cli-binary", process.pid), null);
  });
});
