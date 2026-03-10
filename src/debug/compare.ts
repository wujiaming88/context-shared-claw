/**
 * compare.ts — 对比模式
 * Compare mode: generate both shared and non-shared context for comparison
 *
 * 开启后每次 assemble 同时生成两份上下文，记录 token 差异
 * When enabled, each assemble generates both variants and logs token difference
 */

import type { ContextEntry } from "../config.js";
import { estimateTokens } from "../utils/tokens.js";
import type { DebugLogger } from "./logger.js";

/** 对比结果 / Compare result */
export interface CompareResult {
  /** 含共享上下文的 token 数 / Tokens with shared context */
  tokensWithShared: number;
  /** 不含共享上下文的 token 数 / Tokens without shared context */
  tokensWithoutShared: number;
  /** token 差异 / Token difference */
  difference: number;
  /** 百分比增长 / Percentage increase */
  percentageIncrease: string;
  /** 含共享的条目数 / Entry count with shared */
  entriesWithShared: number;
  /** 不含共享的条目数 / Entry count without shared */
  entriesWithoutShared: number;
}

/**
 * 生成对比数据
 * Generate comparison data between shared and non-shared context assembly
 *
 * @param originalMessages - 原始消息 / Original messages
 * @param sharedEntries - 共享上下文条目 / Shared context entries
 * @param agentId - Agent ID
 * @param sessionId - Session ID
 * @param logger - 调试日志 / Debug logger
 */
export function generateCompare(
  originalMessages: Array<{ role: string; content?: string }>,
  sharedEntries: ContextEntry[],
  agentId: string,
  sessionId: string,
  logger: DebugLogger
): CompareResult {
  // 不含共享的 token / Tokens without shared context
  const originalContent = originalMessages
    .map((m) => m.content || "")
    .join("\n");
  const tokensWithoutShared = estimateTokens(originalContent);

  // 含共享的 token / Tokens with shared context
  const sharedContent = sharedEntries.map((e) => e.content).join("\n");
  const tokensWithShared = tokensWithoutShared + estimateTokens(sharedContent);

  const difference = tokensWithShared - tokensWithoutShared;
  const percentageIncrease =
    tokensWithoutShared > 0
      ? ((difference / tokensWithoutShared) * 100).toFixed(1) + "%"
      : "N/A";

  // 记录到日志 / Log the comparison
  logger.logCompare(agentId, sessionId, tokensWithShared, tokensWithoutShared);

  return {
    tokensWithShared,
    tokensWithoutShared,
    difference,
    percentageIncrease,
    entriesWithShared: originalMessages.length + sharedEntries.length,
    entriesWithoutShared: originalMessages.length,
  };
}
