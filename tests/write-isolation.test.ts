/**
 * 写隔离测试 / Write isolation tests
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
      agents: {
        agentA: { shared: true, sources: ["local"] },
        agentB: { shared: true, sources: ["local"] },
      },
      localDir,
      debugLevel: "off",
      maxContextEntries: 100,
      defaultTokenBudget: 4000,
      sharedBudgetRatio: 0.3,
    },
    { logger: null }
  );
}

const longMsg = (prefix: string) =>
  `${prefix}: This is a sufficiently long message for testing the write isolation feature of the shared context engine.`;

describe("Write Isolation", () => {
  let tmpDir: string;
  let engine: SharedContextEngine;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    engine = makeEngine(tmpDir);
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  it("should store entries in agent-specific directories", async () => {
    await engine.ingest({
      sessionId: "agent:agentA:s1",
      message: { role: "assistant", content: longMsg("AgentA message 1") },
    });
    await engine.ingest({
      sessionId: "agent:agentB:s1",
      message: { role: "assistant", content: longMsg("AgentB message 1") },
    });

    const entriesDir = path.join(tmpDir, "entries");
    const agentADir = path.join(entriesDir, "agentA");
    const agentBDir = path.join(entriesDir, "agentB");

    assert.ok(fs.existsSync(agentADir), "agentA directory should exist");
    assert.ok(fs.existsSync(agentBDir), "agentB directory should exist");

    const indexA = JSON.parse(fs.readFileSync(path.join(agentADir, "_index.json"), "utf-8"));
    const indexB = JSON.parse(fs.readFileSync(path.join(agentBDir, "_index.json"), "utf-8"));
    assert.equal(indexA.length, 1);
    assert.equal(indexB.length, 1);
  });

  it("should allow Agent B to read Agent A's entries", async () => {
    await engine.ingest({
      sessionId: "agent:agentA:s1",
      message: { role: "assistant", content: longMsg("AgentA shared knowledge") },
    });

    // Agent B assembles and should see Agent A's content
    const result = await engine.assemble({
      sessionId: "agent:agentB:s1",
      messages: [{ role: "user", content: "Tell me about shared knowledge" }],
      tokenBudget: 4000,
    });

    assert.ok(result.systemMessage, "Agent B should get shared context");
    assert.ok(
      result.systemMessage!.includes("AgentA shared knowledge"),
      "Should contain Agent A's content"
    );
  });

  it("should NOT show agent's own entries in assemble", async () => {
    await engine.ingest({
      sessionId: "agent:agentA:s1",
      message: { role: "assistant", content: longMsg("AgentA own content only") },
    });

    // Agent A assembles - should NOT see own entries
    const result = await engine.assemble({
      sessionId: "agent:agentA:s1",
      messages: [{ role: "user", content: "Tell me about own content" }],
      tokenBudget: 4000,
    });

    // Should have no shared context (only agentA exists, and it's excluded)
    assert.equal(result.systemMessage, undefined, "Agent A should not see own entries");
  });

  it("should not lose entries on rapid sequential writes", async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        engine.ingest({
          sessionId: "agent:agentA:s1",
          message: {
            role: "assistant",
            content: longMsg(`Rapid write ${i} unique-${crypto.randomBytes(8).toString("hex")}`),
          },
        })
      );
    }
    // Serialize writes (engine uses sync fs internally)
    for (const p of promises) {
      await p;
    }

    const entriesDir = path.join(tmpDir, "entries", "agentA");
    const index = JSON.parse(fs.readFileSync(path.join(entriesDir, "_index.json"), "utf-8"));
    assert.equal(index.length, 10, `Expected 10 entries, got ${index.length}`);
  });
});
