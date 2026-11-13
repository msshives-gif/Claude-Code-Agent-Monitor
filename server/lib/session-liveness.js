/**
 * @file Process-liveness probes for Claude Code and Codex sessions. Answers
 * "could a live provider CLI own this session?" by listing matching processes
 * and their working directories. Used by the hooks watchdog to reap sessions
 * whose SessionEnd hook was lost while the dashboard was offline.
 *
 * Fail-safe by design: whenever the probe cannot produce a trustworthy
 * answer it reports `available: false` and the caller must change nothing.
 * That covers Windows (no probe implementation), containers (host processes
 * are invisible, so an empty process list would be a lie), missing `ps` /
 * `lsof` binaries, and the DASHBOARD_LIVENESS_PROBE=0 escape hatch for
 * setups where hooks arrive from another machine.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { execFileSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const fs = require("node:fs");
const path = require("node:path");
const { isInsideContainer } = require("../../scripts/install-hooks");

const UNAVAILABLE = () => ({ available: false, cwds: new Set() });

/**
 * True when a `ps` args string launches the requested agent CLI. Matches the
 * bare binary and interpreter-launched shims while requiring an exact basename
 * so lookalike commands never make a stale session appear alive.
 */
function isAgentCommand(args, binary) {
  if (typeof args !== "string") return false;
  if (typeof binary !== "string" || !binary) return false;
  const tokens = args.trim().split(/\s+/);
  if (tokens.length === 0 || !tokens[0]) return false;
  if (path.basename(tokens[0]) === binary) return true;
  const interpreter = path.basename(tokens[0]);
  if ((interpreter === "node" || interpreter === "bun") && tokens[1]) {
    return path.basename(tokens[1]) === binary;
  }
  return false;
}

function isClaudeCommand(args) {
  return isAgentCommand(args, "claude");
}

function isCodexCommand(args) {
  return isAgentCommand(args, "codex");
}

/** True when the probe is explicitly disabled via env. */
function probeDisabledByEnv() {
  const raw = (process.env.DASHBOARD_LIVENESS_PROBE || "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
}

/**
 * Read a process's command line, or `null` when the process is gone.
 * Throws on non-ENOENT/ESRCH errors so callers can distinguish "dead"
 * (an authoritative answer) from "couldn't look" (no answer).
 */
function readProcessArgs(pid) {
  if (process.platform === "linux") {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return raw.split("\0").filter(Boolean).join(" ") || null;
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ESRCH")) return null;
      throw err;
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    return out || null;
  } catch (err) {
    // ps exits non-zero (with empty stdout) when the pid doesn't exist —
    // that's an authoritative "dead". A missing/failed ps binary is not.
    if (err && typeof err.status === "number") return null;
    throw err;
  }
}

/**
 * Opaque start-of-process token used to detect PID reuse: Linux uses the
 * kernel starttime field (clock ticks since boot, field 22 of /proc/pid/stat);
 * other POSIX hosts use `ps -o lstart=`. Returns `null` when unavailable.
 * Two reads of the same live process always return the same token; a reused
 * PID practically never does.
 */
function readProcessStartToken(pid) {
  if (process.platform === "linux") {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm (field 2) may contain spaces/parens — split after the LAST ')'.
      const close = raw.lastIndexOf(")");
      if (close < 0) return null;
      const rest = raw
        .slice(close + 1)
        .trim()
        .split(/\s+/);
      // rest[0] = state (field 3) … starttime is overall field 22 → rest[19].
      return rest[19] || null;
    } catch {
      return null;
    }
  }
  try {
    // LC_ALL=C pins the date format; whitespace is collapsed so the token
    // compares stably against snapshot-derived captures (ps pads day-of-month).
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, LC_ALL: "C" },
    })
      .trim()
      .replace(/\s+/g, " ");
    return out || null;
  } catch {
    return null;
  }
}

/** Parent pid of `pid`, or null when it can't be determined. */
function readParentPid(pid) {
  if (process.platform === "linux") {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      if (close < 0) return null;
      const rest = raw
        .slice(close + 1)
        .trim()
        .split(/\s+/);
      const ppid = parseInt(rest[1], 10);
      return Number.isInteger(ppid) ? ppid : null;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    const ppid = parseInt(out, 10);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Walk up the process ancestry from `fromPid` looking for the provider CLI
 * that owns this process tree. Hook handlers are always descendants of the
 * CLI (claude → sh → node hook-handler), so this identifies the exact process
 * whose death means the session ended — immune to the cwd drift that breaks
 * cwd-set matching (the session's recorded cwd follows in-session `cd`; the
 * CLI process's cwd does not). Returns `{ pid, start }` — with `start` always
 * a non-empty reuse-guard token — or `null`; never throws. A `null` simply
 * means callers fall back to the cwd heuristic.
 *
 * On Linux the walk reads /proc directly (a few µs per hop). Elsewhere it
 * takes ONE `ps` snapshot and walks it in memory — per-hop `ps` spawns would
 * cost hundreds of ms on the hook path, which must never block Claude Code.
 */
function findAgentAncestor(binary = "claude", fromPid = process.ppid) {
  if (process.platform === "win32") return null;
  const finish = (pid) => {
    const start = readProcessStartToken(pid);
    // Without a reuse-guard token the report is not exact enough to act on.
    return start ? { pid, start } : null;
  };

  if (process.platform === "linux") {
    let pid = fromPid;
    for (let hops = 0; hops < 25 && Number.isInteger(pid) && pid > 1; hops++) {
      let args;
      try {
        args = readProcessArgs(pid);
      } catch {
        return null;
      }
      if (args === null) return null;
      if (isAgentCommand(args, binary)) return finish(pid);
      pid = readParentPid(pid);
    }
    return null;
  }

  // Non-Linux POSIX: ONE bounded snapshot carrying everything the walk and
  // the reuse-guard token need — a second per-match `ps` would double the
  // worst-case synchronous stall on the hook path. lstart under LC_ALL=C is
  // a fixed 5-token date ("Thu Aug 15 04:00:00 2026"); whitespace-collapsed
  // to match readProcessStartToken's normalization.
  let psOut;
  try {
    psOut = execFileSync("ps", ["-Ao", "pid=,ppid=,lstart=,args="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
  } catch {
    return null;
  }
  const parentOf = new Map();
  const argsOf = new Map();
  const startOf = new Map();
  for (const line of psOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (!m) continue;
    const p = Number(m[1]);
    parentOf.set(p, Number(m[2]));
    startOf.set(p, m[3].replace(/\s+/g, " "));
    argsOf.set(p, m[4]);
  }
  let pid = fromPid;
  for (let hops = 0; hops < 25 && Number.isInteger(pid) && pid > 1; hops++) {
    const args = argsOf.get(pid);
    if (args === undefined) return null;
    if (isAgentCommand(args, binary)) {
      const start = startOf.get(pid);
      return start ? { pid, start } : null;
    }
    pid = parentOf.get(pid);
  }
  return null;
}

/**
 * Exact per-session liveness: is the recorded owner process still this
 * session's provider CLI? `available: false` means "no trustworthy answer —
 * fall back to the cwd probe"; `available: true, alive: false` is an
 * authoritative death verdict (process gone, or its PID was reused by an
 * unrelated command / a different CLI instance per the start token).
 *
 * A start token is REQUIRED: without the reuse guard, a recycled PID that
 * happens to be another `claude` would wrongly pin a dead session alive.
 * (The recorder never stores a token-less owner, so this only rejects rows
 * written by out-of-tree callers.)
 */
function probeAgentPidLive(pid, startToken, binary = "claude") {
  const NO_ANSWER = { available: false, alive: false };
  if (probeDisabledByEnv()) return NO_ANSWER;
  if (process.platform === "win32") return NO_ANSWER;
  if (isInsideContainer()) return NO_ANSWER;
  if (!Number.isInteger(pid) || pid <= 1) return NO_ANSWER;
  if (typeof startToken !== "string" || !startToken) return NO_ANSWER;

  // Signal-0 existence check first: ESRCH is an authoritative "gone" on every
  // POSIX platform, independent of `ps` exit-code ambiguity (a numeric ps
  // failure could also mean a permission or operational error, which must
  // read as "no answer", not "dead").
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err && err.code === "ESRCH") return { available: true, alive: false };
    // EPERM: the process exists but we can't signal it. That usually means
    // PID reuse by another user's process — but nothing guarantees the
    // dashboard and the CLI share a UID (daemonized dashboard, `sudo claude`),
    // so an authoritative "dead" here could reap a live session. No answer;
    // the conservative cwd fallback decides.
    return NO_ANSWER;
  }

  let args;
  try {
    args = readProcessArgs(pid);
  } catch {
    return NO_ANSWER;
  }
  // kill(0) said it exists, so a null args read here is a race or lookup
  // failure — no trustworthy answer rather than "dead".
  if (args === null) return NO_ANSWER;
  if (!isAgentCommand(args, binary)) return { available: true, alive: false };
  const current = readProcessStartToken(pid);
  // Race: the process died between the two reads — no trustworthy answer.
  if (!current) return NO_ANSWER;
  if (current !== startToken) return { available: true, alive: false };
  return { available: true, alive: true };
}

/**
 * Enumerate the working directories of every live provider CLI process.
 *
 * @returns {{ available: boolean, cwds: Set<string> }} `available: false`
 * means "no trustworthy answer — do not act"; an `available: true` result
 * with an empty set genuinely means no claude process is running.
 */
function probeLiveCwds(binary = "claude") {
  if (probeDisabledByEnv()) return UNAVAILABLE();
  if (process.platform === "win32") return UNAVAILABLE();
  if (isInsideContainer()) return UNAVAILABLE();

  let psOut;
  try {
    psOut = execFileSync("ps", PS_ARGS, {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return UNAVAILABLE();
  }

  const pids = ownProcessRows(psOut)
    .filter((row) => isAgentCommand(row.args, binary))
    .map((row) => row.pid);
  const cwds = new Set();
  if (pids.length === 0) return { available: true, cwds };

  if (process.platform === "linux") {
    // /proc is authoritative and needs no external binary.
    for (const pid of pids) {
      try {
        cwds.add(path.resolve(fs.readlinkSync(`/proc/${pid}/cwd`)));
      } catch {
        /* process exited between ps and readlink — skip */
      }
    }
    return { available: true, cwds };
  }

  // macOS (and other BSD-likes): resolve each pid's cwd via lsof. `-Fn`
  // machine format emits `p<pid>` / `f cwd` / `n<path>` records.
  let lsofOut;
  try {
    lsofOut = execFileSync("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    // lsof exits non-zero when SOME of the pids vanished between ps and
    // lsof but still prints records for the rest — keep that partial
    // output. No stdout at all (binary missing, hard failure) → no answer.
    lsofOut = err && typeof err.stdout === "string" && err.stdout ? err.stdout : null;
    if (lsofOut === null) return UNAVAILABLE();
  }
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("n") && line.length > 1) cwds.add(path.resolve(line.slice(1)));
  }
  return { available: true, cwds };
}

/**
 * Enumerate the exact rollout JSONL files held open by live Codex processes.
 * This is stronger than cwd matching: multiple historical and live Codex
 * sessions commonly share one repository, while each live native process keeps
 * only its own rollout open. Unavailable means callers must fall back to the
 * conservative cwd probe and must not infer that any session is dead.
 */
function probeLiveCodexRollouts() {
  if (probeDisabledByEnv() || process.platform === "win32" || isInsideContainer()) {
    return { available: false, paths: new Set() };
  }

  let psOut;
  try {
    psOut = execFileSync("ps", PS_ARGS, {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return { available: false, paths: new Set() };
  }
  const pids = ownProcessRows(psOut)
    .filter((row) => isCodexCommand(row.args))
    .map((row) => row.pid);
  const paths = new Set();
  if (pids.length === 0) return { available: true, paths };

  const remember = (candidate) => {
    if (typeof candidate !== "string") return false;
    if (!candidate.endsWith(".jsonl") || !path.basename(candidate).startsWith("rollout-"))
      return false;
    paths.add(path.resolve(candidate));
    return true;
  };

  if (process.platform === "linux") {
    for (const pid of pids) {
      let descriptors;
      try {
        descriptors = fs.readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const descriptor of descriptors) {
        try {
          remember(fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`));
        } catch {
          /* descriptor closed between listing and read */
        }
      }
    }
    return { available: true, paths };
  }

  let lsofOut;
  try {
    lsofOut = execFileSync("lsof", ["-a", "-p", pids.join(","), "-Fn"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    lsofOut = err && typeof err.stdout === "string" && err.stdout ? err.stdout : null;
    if (lsofOut === null) return { available: false, paths: new Set() };
  }
  const resolvedPids = new Set();
  let currentPid = null;
  for (const line of lsofOut.split("\n")) {
    if (/^p\d+$/.test(line)) currentPid = line.slice(1);
    if (line.startsWith("n") && remember(line.slice(1)) && currentPid) resolvedPids.add(currentPid);
  }
  // A live Codex process with no usable rollout path is incomplete evidence,
  // not proof that its session ended. Only a process that exited during the
  // census may be absent from the resolved rollout set.
  const unresolved = pids.filter((pid) => !resolvedPids.has(pid));
  if (unresolved.some((pid) => !processGone(pid))) return { available: false, paths: new Set() };
  return { available: true, paths };
}

// Each consumer starts its census after capturing its own lifecycle fence.
// Watchdog/reaper and discovery callers bound their complete work separately;
// sharing an older discovery census could close a newly active session at boot.
// A process that exited between ps and the per-pid read holds nothing open, so
// skipping it keeps the census complete. A pid that still exists but cannot be
// read (another user's process, a timeout) still makes the census unavailable.
function processGone(pid) {
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}
function exitedBeforeRead(error, pid) {
  return error?.code === "ENOENT" || error?.code === "ESRCH" || processGone(pid);
}
// Only this user's processes can be this dashboard's sessions, and another
// user's cwd and descriptors are unreadable; listing them would leave every
// census incomplete on a shared host. Without getuid (Windows) keep all rows.
const PS_ARGS = ["-Ao", "pid=,uid=,args="];
function ownProcessRows(psOut) {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : null;
  const rows = [];
  for (const line of psOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m && (uid === null || m[2] === uid)) rows.push({ pid: m[1], args: m[3] });
  }
  return rows;
}

// lsof exits 1 when some requested pids vanished but still prints the rest.
// A killed or truncated run is never usable; a completed non-zero exit is
// usable only when the caller finds exited pids that explain it.
async function lsofRecords(args, maxBuffer) {
  try {
    const { stdout } = await execFileAsync("lsof", args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer,
    });
    return { stdout, failed: false };
  } catch (error) {
    const exited = typeof error?.code === "number" && !error.killed && !error.signal;
    return exited && typeof error.stdout === "string"
      ? { stdout: error.stdout, failed: true }
      : null;
  }
}

function probeLiveCwdsAsync(binary = "claude") {
  return probeLiveCwdsAsyncImpl(binary);
}
function probeLiveCodexRolloutsAsync() {
  return probeLiveCodexRolloutsAsyncImpl();
}
async function probeLiveCwdsAsyncImpl(binary = "claude") {
  if (probeDisabledByEnv()) return UNAVAILABLE();
  if (process.platform === "win32") return UNAVAILABLE();
  if (isInsideContainer()) return UNAVAILABLE();

  let psOut;
  try {
    psOut = (
      await execFileAsync("ps", PS_ARGS, {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    return UNAVAILABLE();
  }

  const pids = ownProcessRows(psOut)
    .filter((row) => isAgentCommand(row.args, binary))
    .map((row) => row.pid);
  const cwds = new Set();
  if (pids.length === 0) return { available: true, cwds };

  if (process.platform === "linux") {
    // /proc is authoritative and needs no external binary.
    for (const pid of pids) {
      try {
        cwds.add(path.resolve(await fs.promises.readlink(`/proc/${pid}/cwd`)));
      } catch (error) {
        if (exitedBeforeRead(error, pid)) continue;
        return UNAVAILABLE(); // An incomplete census cannot prove absence.
      }
    }
    return { available: true, cwds };
  }

  // macOS (and other BSD-likes): resolve each pid's cwd via lsof. `-Fn`
  // machine format emits `p<pid>` / `f cwd` / `n<path>` records.
  const census = await lsofRecords(
    ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"],
    16 * 1024 * 1024
  );
  if (!census) return UNAVAILABLE();
  const lsofOut = census.stdout;
  const resolvedPids = new Set();
  let currentPid = null;
  for (const line of lsofOut.split("\n")) {
    if (/^p\d+$/.test(line)) currentPid = line.slice(1);
    if (line.startsWith("n") && path.posix.isAbsolute(line.slice(1))) {
      cwds.add(path.resolve(line.slice(1)));
      resolvedPids.add(currentPid);
    }
  }
  // Partial output proves absence only for pids that no longer exist.
  const missing = pids.filter((pid) => !resolvedPids.has(pid));
  if (missing.some((pid) => !processGone(pid))) return UNAVAILABLE();
  if (census.failed && missing.length === 0) return UNAVAILABLE();
  return { available: true, cwds };
}

async function probeLiveCodexRolloutsAsyncImpl() {
  if (probeDisabledByEnv() || process.platform === "win32" || isInsideContainer()) {
    return { available: false, paths: new Set() };
  }

  let psOut;
  try {
    psOut = (
      await execFileAsync("ps", PS_ARGS, {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    return { available: false, paths: new Set() };
  }
  const pids = ownProcessRows(psOut)
    .filter((row) => isCodexCommand(row.args))
    .map((row) => row.pid);
  const paths = new Set();
  if (pids.length === 0) return { available: true, paths };

  const remember = (candidate) => {
    if (typeof candidate !== "string") return false;
    if (!candidate.endsWith(".jsonl") || !path.basename(candidate).startsWith("rollout-"))
      return false;
    paths.add(path.resolve(candidate));
    return true;
  };

  if (process.platform === "linux") {
    for (const pid of pids) {
      let descriptors;
      try {
        descriptors = await fs.promises.readdir(`/proc/${pid}/fd`);
      } catch (error) {
        if (exitedBeforeRead(error, pid)) continue;
        return { available: false, paths: new Set() };
      }
      for (const descriptor of descriptors) {
        try {
          remember(await fs.promises.readlink(`/proc/${pid}/fd/${descriptor}`));
        } catch (error) {
          // A descriptor closed between readdir and readlink is skipped: the file
          // it held is no longer open, so it cannot prove the session live.
          if (error?.code === "ENOENT" || processGone(pid)) continue;
          return { available: false, paths: new Set() };
        }
      }
    }
    return { available: true, paths };
  }

  const census = await lsofRecords(["-a", "-p", pids.join(","), "-Fn"], 32 * 1024 * 1024);
  if (!census) return { available: false, paths: new Set() };
  const lsofOut = census.stdout;
  const observedPids = new Set(
    lsofOut
      .split("\n")
      .filter((line) => /^p\d+$/.test(line))
      .map((line) => line.slice(1))
  );
  const missing = pids.filter((pid) => !observedPids.has(pid));
  if (missing.some((pid) => !processGone(pid)) || (census.failed && missing.length === 0))
    return { available: false, paths: new Set() };
  const resolvedPids = new Set();
  let currentPid = null;
  for (const line of lsofOut.split("\n")) {
    if (/^p\d+$/.test(line)) currentPid = line.slice(1);
    if (line.startsWith("n") && remember(line.slice(1)) && currentPid) resolvedPids.add(currentPid);
  }
  const unresolved = pids.filter((pid) => !resolvedPids.has(pid));
  if (unresolved.some((pid) => !processGone(pid))) return { available: false, paths: new Set() };
  return { available: true, paths };
}

module.exports = {
  probeLiveCwds,
  probeLiveCwdsAsync,
  probeLiveCodexRolloutsAsync,
  probeLiveCodexRollouts,
  findAgentAncestor,
  probeAgentPidLive,
  isAgentCommand,
  isClaudeCommand,
  isCodexCommand,
};
