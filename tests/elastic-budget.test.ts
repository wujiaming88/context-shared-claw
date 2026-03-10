/**
 * 弹性预算测试 / Elastic budget tests
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

function makeEngine(localDir: string, opts: { sharedBudgetRatio?: number; defaultTokenBudget?: number } = {}): SharedContextEngine {
  return new SharedContextEngine(
    {
      agents: {
        writer: { shared: true, sources: ["local"] },
        reader: { shared: true, sources: ["local"] },
      },
      localDir,
      debugLevel: "off",
      maxContextEntries: 100,
      defaultTokenBudget: opts.defaultTokenBudget ?? 4000,
      sharedBudgetRatio: opts.sharedBudgetRatio ?? 0.3,
    },
    { logger: null }
  );
}

const longMsg = (i: number) =>
  `Entry ${i}: This is a long enough message for elastic budget testing with sufficient content to be meaningful. Unique ID: ${crypto.randomBytes(8).toString("hex")}`;

describe("Elastic Budget", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  it("should allocate sharedBudgetRatio of total budget under normal conditions", async () => {
    const engine = makeEngine(tmpDir, { sharedBudgetRatio: 0.3, defaultTokenBudget: 4000 });

    // Writer ingests some content
    for (let i = 0; i < 5; i++) {
      await engine.ingest({
        sessionId: "agent:writer:s1",
        message: { role: "assistant", content: longMsg(i) },
      });
    }

    // Reader assembles with small existing messages (plenty of budget left)
    // Use a query that matches the ingested content keywords
    const result = await engine.assemble({
      sessionId: "agent:reader:s1",
      messages: [{ role: "user", content: "Tell me about elastic budget testing entry message" }],
      tokenBudget: 4000,
    });

    // Should get some shared context
    assert.ok(result.tokens !== undefined && result.tokens > 0, "Should inject shared tokens");
    // Shared tokens should not exceed sharedBudgetRatio * budget = 1200
    assert.ok(result.tokens! <= 1200, `Shared tokens ${result.tokens} should be <= 1200`);
  });

  it("should shrink shared budget when existingTokens are high", async () => {
    const engine = makeEngine(tmpDir, { sharedBudgetRatio: 0.3, defaultTokenBudget: 4000 });

    for (let i = 0; i < 5; i++) {
      await engine.ingest({
        sessionId: "agent:writer:s1",
        message: { role: "assistant", content: longMsg(i) },
      });
    }

    // Create large existing messages that consume most of the budget (~3500 tokens)
    const bigMessages = [
      { role: "user" as const, content: "x".repeat(14000) }, // ~3500 tokens
    ];

    const result = await engine.assemble({
      sessionId: "agent:reader:s1",
      messages: bigMessages,
      tokenBudget: 4000,
    });

    // With 3500 tokens used, remaining = (4000-3500)*0.8 = 400
    // ratioBasedBudget = 4000*0.3 = 1200
    // sharedBudget = min(1200, 400) = 400
    // Should get reduced shared context or very little
    if (result.tokens !== undefined) {
      assert.ok(result.tokens <= 400, `Shared tokens ${result.tokens} should be <= 400`);
    }
  });

  it("should skip shared context when budget is exhausted", async () => {
    const engine = makeEngine(tmpDir, { sharedBudgetRatio: 0.3, defaultTokenBudget: 4000 });

    for (let i = 0; i < 5; i++) {
      await engine.ingest({
        sessionId: "agent:writer:s1",
        message: { role: "assistant", content: longMsg(i) },
      });
    }

    // Create messages that exceed the budget
    const hugeMessages = [
      { role: "user" as const, content: "x".repeat(20000) }, // ~5000 tokens, > 4000 budget
    ];

    const result = await engine.assemble({
      sessionId: "agent:reader:s1",
      messages: hugeMessages,
      tokenBudget: 4000,
    });

    // Budget exhausted - should skip
    assert.equal(result.systemMessage, undefined, "Should skip when budget exhausted");
  });
});
