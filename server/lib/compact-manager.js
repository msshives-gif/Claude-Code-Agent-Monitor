/**
 * @file Reads the local compact-manager CLI's structured overview (context
 * auto-compaction state: mode, thresholds, per-model overrides, watcher
 * health, per-session usage). The CLI being absent, failing, or printing
 * garbage degrades to an { available: false } snapshot — this module never
 * throws and never blocks beyond its timeout, so a machine without
 * compact-manager installed simply shows no panel.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const spawn = require("cross-spawn");

// Caps are measured in JS string characters, not bytes — the CLI emits
// ensure_ascii JSON so the two coincide in practice, and a truncated
// payload just fails JSON.parse into an unavailable snapshot.
const MAX_STDOUT_CHARS = 1_000_000;
const MAX_STDERR_CHARS = 10_000;
// Short server-side TTL + in-flight coalescing so N open dashboard tabs
// (each polling every 15s) cost one CLI spawn per window, not N.
const CACHE_TTL_MS = 10_000;

let cachedSnapshot = null;
let inFlight = null;

function clearOverviewCache() {
  cachedSnapshot = null;
  inFlight = null;
}

/** Cached wrapper around fetchOverview — the route's default provider. */
function getOverviewCached() {
  if (cachedSnapshot && Date.now() - cachedSnapshot.fetched_at < CACHE_TTL_MS) {
    return Promise.resolve(cachedSnapshot);
  }
  if (!inFlight) {
    inFlight = fetchOverview().then((snapshot) => {
      cachedSnapshot = snapshot;
      inFlight = null;
      return snapshot;
    });
  }
  return inFlight;
}

function resolveBin() {
  return process.env.DASHBOARD_COMPACT_MANAGER_BIN || "compact-manager";
}

function unavailable(reason) {
  return { available: false, fetched_at: Date.now(), reason };
}

/**
 * Run `compact-manager overview --json` and parse it. Resolves (never
 * rejects) with either { available: true, overview } or
 * { available: false, reason }.
 */
function fetchOverview({ timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveBin(), ["overview", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve(unavailable(`spawn failed: ${err.message || String(err)}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (snapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(snapshot);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(unavailable("timeout"));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_STDOUT_CHARS) {
        stdout = (stdout + chunk).slice(0, MAX_STDOUT_CHARS);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr = (stderr + chunk).slice(0, MAX_STDERR_CHARS);
      }
    });
    child.on("error", (err) => {
      finish(
        unavailable(
          err && err.code === "ENOENT"
            ? "cli_not_found"
            : `spawn error: ${(err && err.message) || String(err)}`
        )
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 200);
        finish(unavailable(`exit ${code}${detail ? `: ${detail}` : ""}`));
        return;
      }
      try {
        const overview = JSON.parse(stdout);
        // Structural contract, enforced at the trust boundary: the client
        // panel dereferences these arrays during render and the app has no
        // error boundary, so a shape-nonconforming producer (wrong binary
        // behind DASHBOARD_COMPACT_MANAGER_BIN, future schema drift) must
        // degrade to unavailable here — never white-screen the Dashboard.
        if (
          !overview ||
          typeof overview !== "object" ||
          Array.isArray(overview) ||
          !Array.isArray(overview.watchers) ||
          !Array.isArray(overview.sessions)
        ) {
          finish(unavailable("unexpected output shape"));
          return;
        }
        finish({ available: true, fetched_at: Date.now(), overview });
      } catch {
        finish(unavailable("unparseable output"));
      }
    });
  });
}

module.exports = { fetchOverview, getOverviewCached, clearOverviewCache };
