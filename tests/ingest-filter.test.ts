/**
 * 入池过滤测试 / Ingestion filter tests
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SharedContextEngine } from "../src/engine.js";

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `csc-test-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmDir(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeEngine(localDir: string): SharedContextEngine {
  return new SharedContextEngine(
    {
      agents: { testAgent: { shared: true, sources: ["local"] } },
      localDir,
      debugLevel: "off",
      maxContextEntries: 100,
      defaultTokenBudget: 4000,
      sharedBudgetRatio: 0.3,
    },
    { logger: null }
  );
}

const SESSION = "agent:testAgent:session1";
const longContent = "A".repeat(60) + " This is a sufficiently long message for ingestion testing purposes.";

describe("Ingest Filter", () => {
  let tmpDir: string;
  let engine: SharedContextEngine;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    engine = makeEngine(tmpDir);
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  it("should skip short content (< 50 chars)", async () => {
    const result = await engine.ingest({
      sessionId: SESSION,
      message: { role: "assistant", content: "Short msg" },
    });
    assert.equal(result.tokens, undefined);
  });

  it("should skip empty content", async () => {
    const result = await engine.ingest({
      sessionId: SESSION,
      message: { role: "assistant", content: "" },
    });
    assert.equal(result.tokens, undefined);
  });

  it("should ingest normal messages successfully", async () => {
    const result = await engine.ingest({
      sessionId: SESSION,
      message: { role: "assistant", content: longContent },
    });
    assert.ok(result.tokens && result.tokens > 0, "Should return positive token count");
  });

  it("should skip heartbeat messages", async () => {
    const result = await engine.ingest({
      sessionId: SESSION,
      message: { role: "assistant", content: longContent },
      isHeartbeat: true,
    });
    assert.equal(result.tokens, undefined);
  });

  it("should skip announce messages (contains [Internal task completion event])", async () => {
    const announceContent =
      "[Internal task completion event] The sub-agent has completed its task successfully with all tests passing.";
    const result = await engine.ingest({
      sessionId: SESSION,
      message: { role: "assistant", content: announceContent },
    });
    assert.equal(result.tokens, undefined);
  });

  it("should truncate tool output when tokens > 2000", async () => {
    // Create content that's clearly > 2000 tokens (~8000 chars for English)
    const bigToolContent = "x".repeat(12000);
    const result = await engine.ingest({
      sessionId: SESSION,
      message: { role: "tool", content: bigToolContent },
    });
    assert.ok(result.tokens && result.tokens > 0, "Should be ingested");
    // The truncated content should be significantly smaller than original
    assert.ok(result.tokens! < 3500, `Expected truncated tokens < 3500, got ${result.tokens}`);
  });

  it("should skip duplicate messages (similarity > 80%)", async () => {
    // First ingest
    const result1 = await engine.ingest({
      sessionId: SESSION,
      message: { role: "assistant", content: longContent },
    });
    assert.ok(result1.tokens && result1.tokens > 0);

    // Second ingest with nearly identical content
    const result2 = await engine.ingest({
      sessionId: SESSION,
      message: { role: "assistant", content: longContent + "." },
    });
    assert.equal(result2.tokens, undefined, "Duplicate should be skipped");
  });
});
