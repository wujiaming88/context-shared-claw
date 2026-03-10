/**
 * 效果评估测试 / Evaluate tests
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

const longMsg = (i: number) =>
  `Entry ${i}: This is a meaningful context entry with enough content to pass ingestion filters. Unique: ${crypto.randomBytes(8).toString("hex")}`;

describe("Evaluate", () => {
  let tmpDir: string;
  let engine: SharedContextEngine;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    engine = makeEngine(tmpDir);
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  it("should return a formatted report string", async () => {
    // Ingest some entries first
    for (let i = 0; i < 3; i++) {
      await engine.ingest({
        sessionId: "agent:testAgent:s1",
        message: { role: "assistant", content: longMsg(i) },
      });
    }

    const report = await engine.evaluate();
    assert.ok(typeof report === "string", "Should return a string");
    assert.ok(report.includes("共享上下文效果报告"), "Should contain report title");
    assert.ok(report.includes("池子健康度"), "Should contain pool health section");
    assert.ok(report.includes("Token 经济性"), "Should contain token economics section");
    assert.ok(report.includes("跨 Agent 流向"), "Should contain cross-agent flow section");
  });

  it("should return reasonable defaults for empty pool", async () => {
    const report = await engine.evaluate();
    assert.ok(typeof report === "string", "Should return a string");
    assert.ok(report.includes("总条目: 0"), "Should show 0 entries");
    assert.ok(report.includes("assemble 总次数: 0"), "Should show 0 assembles");
  });
});
