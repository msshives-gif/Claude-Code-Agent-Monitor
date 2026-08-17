/**
 * @file HTTP route exposing the local compact-manager CLI's overview
 * (context auto-compaction state) to the dashboard. Fetches on demand —
 * the client panel polls this endpoint; a missing or broken CLI yields
 * { available: false } with HTTP 200 so the panel can quietly hide.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const { getOverviewCached } = require("../lib/compact-manager");

const router = Router();

function overviewProvider(req) {
  const injected = req.app?.locals?.compactManagerProvider;
  return typeof injected === "function" ? injected : getOverviewCached;
}

router.get("/status", async (req, res) => {
  try {
    const snapshot = await overviewProvider(req)();
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({
      error: {
        code: "COMPACT_MANAGER_STATUS_FAILED",
        message: (err && err.message) || String(err),
      },
    });
  }
});

module.exports = router;
