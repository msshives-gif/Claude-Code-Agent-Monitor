/**
 * @file Tests that transcript token accounting counts each API response's
 * `usage` exactly once, using the LAST record per message.id. Claude Code
 * writes one JSONL record per content block, so a single response (one
 * message.id) appears as several records carrying the message's usage —
 * summing every record inflates token totals 2-4x, and the copies are not
 * always identical (streaming writes partial usage first, so the final
 * record is authoritative). Covers full reads, evolving usage, incremental
 * reads whose boundary splits a message's records, and id-less records
 * (still counted).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TranscriptCache = require("../lib/transcript-cache");

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-dedup-"));
});
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const USAGE_A = {
  input_tokens: 10,
  output_tokens: 100,
  cache_read_input_tokens: 5000,
  cache_creation_input_tokens: 300,
};
const USAGE_B = {
  input_tokens: 7,
  output_tokens: 40,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 0,
};

function assistantRecord(msgId, usage, blockType = "text") {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: {
      id: msgId,
      model: "claude-test-1",
      usage,
      content: [{ type: blockType, [blockType === "text" ? "text" : "thinking"]: "x" }],
    },
  });
}

function totalsOf(result) {
  const buckets = Object.values(result.tokensByModel || {});
  assert.equal(buckets.length, 1, "expected a single model bucket");
  return buckets[0];
}

describe("usage dedup by message.id", () => {
  it("counts a message split across several records exactly once (full read)", () => {
    const p = path.join(tmpDir, "full.jsonl");
    fs.writeFileSync(
      p,
      [
        assistantRecord("msg_a", USAGE_A, "thinking"),
        assistantRecord("msg_a", USAGE_A),
        assistantRecord("msg_a", USAGE_A),
        assistantRecord("msg_b", USAGE_B),
      ].join("\n") + "\n"
    );
    const cache = new TranscriptCache();
    const t = totalsOf(cache.extract(p));
    assert.equal(t.output, USAGE_A.output_tokens + USAGE_B.output_tokens);
    assert.equal(t.cacheRead, USAGE_A.cache_read_input_tokens + USAGE_B.cache_read_input_tokens);
    assert.equal(t.input, USAGE_A.input_tokens + USAGE_B.input_tokens);
  });

  it("still counts thinking blocks on every record (blocks are distinct)", () => {
    const p = path.join(tmpDir, "blocks.jsonl");
    fs.writeFileSync(
      p,
      [assistantRecord("msg_a", USAGE_A, "thinking"), assistantRecord("msg_a", USAGE_A)].join(
        "\n"
      ) + "\n"
    );
    const cache = new TranscriptCache();
    const result = cache.extract(p);
    assert.equal(result.thinkingBlockCount, 1);
    assert.equal(totalsOf(result).output, USAGE_A.output_tokens);
  });

  it("uses the last record's usage when it evolves across records", () => {
    const p = path.join(tmpDir, "evolving.jsonl");
    const partial = { ...USAGE_A, output_tokens: 5, cache_read_input_tokens: 0 };
    fs.writeFileSync(
      p,
      [
        assistantRecord("msg_a", partial, "thinking"),
        assistantRecord("msg_a", USAGE_A), // final, authoritative
        assistantRecord("msg_b", USAGE_B),
      ].join("\n") + "\n"
    );
    const cache = new TranscriptCache();
    const t = totalsOf(cache.extract(p));
    assert.equal(t.output, USAGE_A.output_tokens + USAGE_B.output_tokens);
    assert.equal(t.cacheRead, USAGE_A.cache_read_input_tokens + USAGE_B.cache_read_input_tokens);
  });

  it("uses the final record when the evolution straddles an incremental boundary", () => {
    const p = path.join(tmpDir, "evolving-incremental.jsonl");
    const partial = { ...USAGE_A, output_tokens: 5, cache_read_input_tokens: 0 };
    fs.writeFileSync(p, assistantRecord("msg_a", partial) + "\n");
    const cache = new TranscriptCache();
    assert.equal(totalsOf(cache.extract(p)).output, 5);

    fs.appendFileSync(p, assistantRecord("msg_a", USAGE_A) + "\n");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(p, later, later);

    const t = totalsOf(cache.extract(p));
    assert.equal(t.output, USAGE_A.output_tokens);
    assert.equal(t.cacheRead, USAGE_A.cache_read_input_tokens);
  });

  it("skips duplicates that straddle an incremental read boundary", () => {
    const p = path.join(tmpDir, "incremental.jsonl");
    fs.writeFileSync(p, assistantRecord("msg_a", USAGE_A) + "\n");
    const cache = new TranscriptCache();
    const first = totalsOf(cache.extract(p));
    assert.equal(first.output, USAGE_A.output_tokens);

    // Append the same message's remaining records plus a new message; bump
    // mtime so the stat-based cache sees growth and takes the incremental path.
    fs.appendFileSync(
      p,
      [assistantRecord("msg_a", USAGE_A), assistantRecord("msg_b", USAGE_B)].join("\n") + "\n"
    );
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(p, later, later);

    const t = totalsOf(cache.extract(p));
    assert.equal(t.output, USAGE_A.output_tokens + USAGE_B.output_tokens);
    assert.equal(t.cacheRead, USAGE_A.cache_read_input_tokens + USAGE_B.cache_read_input_tokens);
  });

  it("counts records without a message id unconditionally", () => {
    const p = path.join(tmpDir, "no-id.jsonl");
    fs.writeFileSync(
      p,
      [assistantRecord(undefined, USAGE_A), assistantRecord(undefined, USAGE_A)].join("\n") + "\n"
    );
    const cache = new TranscriptCache();
    const t = totalsOf(cache.extract(p));
    assert.equal(t.output, USAGE_A.output_tokens * 2);
  });
});
