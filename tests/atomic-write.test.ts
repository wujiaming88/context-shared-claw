/**
 * 原子写入测试 / Atomic write tests
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

const longMsg = "This is a sufficiently long message for atomic write testing purposes and it needs to be at least fifty characters.";

describe("Atomic Write", () => {
  let tmpDir: string;
  let engine: SharedContextEngine;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    engine = makeEngine(tmpDir);
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  it("should produce a parseable index file after write", async () => {
    await engine.ingest({
      sessionId: "agent:testAgent:s1",
      message: { role: "assistant", content: longMsg },
    });

    const indexPath = path.join(tmpDir, "entries", "testAgent", "_index.json");
    assert.ok(fs.existsSync(indexPath), "Index file should exist");

    const data = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    assert.ok(Array.isArray(data), "Index should be an array");
    assert.equal(data.length, 1);
    assert.ok(data[0].id, "Entry should have an id");
    assert.ok(data[0].content.includes("sufficiently long"), "Content should be preserved");
  });

  it("should not leave .tmp files after write", async () => {
    await engine.ingest({
      sessionId: "agent:testAgent:s1",
      message: { role: "assistant", content: longMsg },
    });

    const agentDir = path.join(tmpDir, "entries", "testAgent");
    const files = fs.readdirSync(agentDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    assert.equal(tmpFiles.length, 0, `Found residual .tmp files: ${tmpFiles.join(", ")}`);
  });
});
