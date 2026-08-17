/**
 * @file Tests for the compact-manager readout endpoint: provider injection,
 * unavailable-CLI degradation, and the lib's spawn-failure handling.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const TEST_DB = path.join(os.tmpdir(), `dashboard-compact-manager-${Date.now()}-${process.pid}.db`);
process.env.DASHBOARD_DB_PATH = TEST_DB;

const { createApp, startServer } = require("../index");
const { db } = require("../db");
const { fetchOverview } = require("../lib/compact-manager");

let app;
let server;
let BASE;

function httpFetch(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", ...options.headers },
    };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

before(async () => {
  app = createApp();
  server = await startServer(app, 0);
  const addr = server.address();
  BASE = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  try {
    fs.unlinkSync(TEST_DB);
    fs.unlinkSync(`${TEST_DB}-wal`);
    fs.unlinkSync(`${TEST_DB}-shm`);
  } catch {
    // ignore
  }
});

describe("GET /api/compact-manager/status", () => {
  it("returns the injected provider's snapshot verbatim", async () => {
    const snapshot = {
      available: true,
      fetched_at: 123,
      overview: {
        schema: 1,
        mode: "managed",
        watchers: [],
        sessions: [{ session_id: "abc", pct: 12.5 }],
      },
    };
    app.locals.compactManagerProvider = async () => snapshot;
    try {
      const res = await httpFetch("/api/compact-manager/status");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, snapshot);
    } finally {
      delete app.locals.compactManagerProvider;
    }
  });

  it("maps a throwing provider to a 500 error envelope", async () => {
    app.locals.compactManagerProvider = async () => {
      throw new Error("boom");
    };
    try {
      const res = await httpFetch("/api/compact-manager/status");
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "COMPACT_MANAGER_STATUS_FAILED");
    } finally {
      delete app.locals.compactManagerProvider;
    }
  });

  it("degrades to available:false when the CLI is absent (real lib)", async () => {
    const prev = process.env.DASHBOARD_COMPACT_MANAGER_BIN;
    process.env.DASHBOARD_COMPACT_MANAGER_BIN = path.join(
      os.tmpdir(),
      `no-such-compact-manager-${process.pid}`
    );
    try {
      const res = await httpFetch("/api/compact-manager/status");
      assert.equal(res.status, 200);
      assert.equal(res.body.available, false);
      assert.equal(typeof res.body.reason, "string");
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_COMPACT_MANAGER_BIN;
      else process.env.DASHBOARD_COMPACT_MANAGER_BIN = prev;
    }
  });
});

describe("fetchOverview", () => {
  it("parses well-formed CLI JSON output", async () => {
    const prev = process.env.DASHBOARD_COMPACT_MANAGER_BIN;
    const fake = path.join(os.tmpdir(), `fake-compact-manager-${process.pid}`);
    fs.writeFileSync(
      fake,
      '#!/bin/sh\necho \'{"schema":1,"mode":"advisory","watchers":[],"sessions":[]}\'\n',
      { mode: 0o755 }
    );
    process.env.DASHBOARD_COMPACT_MANAGER_BIN = fake;
    try {
      const snap = await fetchOverview();
      assert.equal(snap.available, true);
      assert.equal(snap.overview.mode, "advisory");
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_COMPACT_MANAGER_BIN;
      else process.env.DASHBOARD_COMPACT_MANAGER_BIN = prev;
      fs.unlinkSync(fake);
    }
  });

  it("degrades on non-JSON output and non-zero exit", async () => {
    const prev = process.env.DASHBOARD_COMPACT_MANAGER_BIN;
    const fake = path.join(os.tmpdir(), `fake-compact-manager-bad-${process.pid}`);
    fs.writeFileSync(fake, "#!/bin/sh\necho not-json\n", { mode: 0o755 });
    process.env.DASHBOARD_COMPACT_MANAGER_BIN = fake;
    try {
      const bad = await fetchOverview();
      assert.equal(bad.available, false);
      fs.writeFileSync(fake, "#!/bin/sh\necho oops >&2\nexit 3\n", { mode: 0o755 });
      const failed = await fetchOverview();
      assert.equal(failed.available, false);
      assert.match(failed.reason, /exit 3/);
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_COMPACT_MANAGER_BIN;
      else process.env.DASHBOARD_COMPACT_MANAGER_BIN = prev;
      fs.unlinkSync(fake);
    }
  });

  it("times out a hung CLI without throwing", async () => {
    const prev = process.env.DASHBOARD_COMPACT_MANAGER_BIN;
    const fake = path.join(os.tmpdir(), `fake-compact-manager-hang-${process.pid}`);
    fs.writeFileSync(fake, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    process.env.DASHBOARD_COMPACT_MANAGER_BIN = fake;
    try {
      const snap = await fetchOverview({ timeoutMs: 300 });
      assert.equal(snap.available, false);
      assert.equal(snap.reason, "timeout");
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_COMPACT_MANAGER_BIN;
      else process.env.DASHBOARD_COMPACT_MANAGER_BIN = prev;
      fs.unlinkSync(fake);
    }
  });
});
