/**
 * 搜索和去重测试 / Search and dedup tests
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { isSimilar, searchEntries } from "../src/utils/search.js";
import type { ContextEntry } from "../src/config.js";

describe("isSimilar", () => {
  it("should return true for identical strings", () => {
    assert.ok(isSimilar("hello world", "hello world"));
  });

  it("should return false for completely different strings", () => {
    assert.ok(!isSimilar("abcdefghij", "zyxwvutsrq"));
  });

  it("should return true for ~80% similar strings (threshold=0.8)", () => {
    // Create two strings that are ~80% similar
    const base = "The quick brown fox jumps over the lazy dog near the river";
    const modified = "The quick brown fox jumps over the lazy cat near the river";
    // Only "dog" -> "cat" changed, rest identical => very high similarity
    assert.ok(isSimilar(base, modified, 0.8), "Strings with minor changes should be similar");
  });

  it("should return false for strings below threshold", () => {
    const a = "This is a completely different sentence about programming";
    const b = "The weather today is sunny and warm with light breezes";
    assert.ok(!isSimilar(a, b, 0.8), "Very different strings should not be similar");
  });
});

describe("searchEntries", () => {
  const makeEntry = (content: string, ts: number): ContextEntry => ({
    id: `test-${ts}`,
    agentId: "test",
    sessionId: "agent:test:s1",
    content,
    role: "assistant",
    timestamp: ts,
    tokens: 50,
    tags: [],
    source: "local",
  });

  it("should rank entries by keyword relevance", () => {
    const now = Date.now();
    const entries = [
      makeEntry("The weather is nice today with sunshine", now),
      makeEntry("JavaScript programming language is great for web development", now),
      makeEntry("Programming in JavaScript and TypeScript for web apps", now),
    ];

    const results = searchEntries(entries, "JavaScript programming", 10);
    assert.ok(results.length >= 2, "Should match at least 2 entries");
    // The top result should contain "javascript" (case-insensitive match)
    assert.ok(
      results[0].content.toLowerCase().includes("javascript"),
      "Top result should contain JavaScript keyword"
    );
  });

  it("should return empty for query with no matches", () => {
    const now = Date.now();
    const entries = [
      makeEntry("The weather is nice today", now),
      makeEntry("Cooking recipes for dinner", now),
    ];

    const results = searchEntries(entries, "quantum physics", 10);
    assert.equal(results.length, 0, "No entries should match unrelated query");
  });
});
