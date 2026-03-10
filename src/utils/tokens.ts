/**
 * tokens.ts — Token 估算工具
 * Token estimation utilities
 *
 * 使用简单的字符计数估算（~4 chars per token for English, ~2 for CJK）
 * Simple char-count estimation (~4 chars/token English, ~2 chars/token CJK)
 */

// CJK Unicode 范围 / CJK Unicode ranges
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\uf900-\ufaff\u{2f800}-\u{2fa1f}\u3000-\u303f]/gu;

/**
 * 估算文本的 token 数量
 * Estimate token count for a text string
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // 计算 CJK 字符数 / Count CJK characters
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // 非 CJK 字符数 / Non-CJK character count
  const nonCjkLength = text.length - cjkCount;

  // CJK: ~2 chars/token, 非 CJK: ~4 chars/token
  const cjkTokens = Math.ceil(cjkCount / 2);
  const nonCjkTokens = Math.ceil(nonCjkLength / 4);

  return cjkTokens + nonCjkTokens;
}

/**
 * 按 token 预算截断上下文条目
 * Truncate context entries to fit within token budget
 */
export function truncateToTokenBudget(
  entries: Array<{ content: string; tokens: number }>,
  budget: number
): Array<{ content: string; tokens: number }> {
  const result: Array<{ content: string; tokens: number }> = [];
  let used = 0;

  for (const entry of entries) {
    if (used + entry.tokens > budget) break;
    result.push(entry);
    used += entry.tokens;
  }

  return result;
}
