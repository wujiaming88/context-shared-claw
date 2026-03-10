/**
 * search.ts — 搜索工具
 * Search utilities for context entries (keyword-based MVP)
 */

import type { ContextEntry } from "../config.js";

/**
 * 简单关键词匹配搜索
 * Simple keyword-based search (MVP stage)
 *
 * @param entries - 候选条目 / Candidate entries
 * @param query - 搜索关键词 / Search query keywords
 * @param limit - 最大返回数 / Max results
 * @returns 匹配的条目（按相关性排序）/ Matched entries sorted by relevance
 */
export function searchEntries(
  entries: ContextEntry[],
  query: string,
  limit: number = 10
): ContextEntry[] {
  if (!query.trim()) return entries.slice(0, limit);

  // 分词（按空格和标点）/ Tokenize query by spaces and punctuation
  const keywords = query
    .toLowerCase()
    .split(/[\s,;.!?，。；！？]+/)
    .filter((w) => w.length > 0);

  if (keywords.length === 0) return entries.slice(0, limit);

  // 计算每个条目的匹配分数 / Score each entry
  const scored = entries.map((entry) => {
    const text = entry.content.toLowerCase();
    const tagText = entry.tags.join(" ").toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      // 内容匹配 / Content match
      const contentMatches = countOccurrences(text, kw);
      score += contentMatches * 2;

      // 标签匹配（权重更高）/ Tag match (higher weight)
      const tagMatches = countOccurrences(tagText, kw);
      score += tagMatches * 5;
    }

    // 时间衰减：越新的条目分数越高 / Time decay: newer entries score higher
    const ageHours = (Date.now() - entry.timestamp) / (1000 * 60 * 60);
    const timeFactor = Math.max(0.1, 1 - ageHours / 720); // 30天衰减到0.1
    score *= timeFactor;

    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
}

/**
 * 计算子串出现次数
 * Count occurrences of substring
 */
function countOccurrences(text: string, sub: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(sub, pos)) !== -1) {
    count++;
    pos += sub.length;
  }
  return count;
}

/**
 * 判断两段文本是否相似（基于 bigram 相似度）
 * Check if two texts are similar using bigram similarity (Dice coefficient)
 *
 * 不依赖外部库，使用简单的字符 bigram 重叠比率
 * No external dependencies, uses simple character bigram overlap ratio
 *
 * @param a - 第一段文本 / First text
 * @param b - 第二段文本 / Second text
 * @param threshold - 相似度阈值 (0-1)，超过则视为相似 / Similarity threshold (0-1)
 * @returns 是否相似 / Whether the texts are similar
 */
export function isSimilar(a: string, b: string, threshold: number = 0.8): boolean {
  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);

  if (bigramsA.size === 0 && bigramsB.size === 0) return true;
  if (bigramsA.size === 0 || bigramsB.size === 0) return false;

  let intersection = 0;
  for (const [bigram, countA] of bigramsA) {
    const countB = bigramsB.get(bigram) || 0;
    intersection += Math.min(countA, countB);
  }

  const totalA = Array.from(bigramsA.values()).reduce((s, v) => s + v, 0);
  const totalB = Array.from(bigramsB.values()).reduce((s, v) => s + v, 0);

  // Dice coefficient: 2 * |intersection| / (|A| + |B|)
  const dice = (2 * intersection) / (totalA + totalB);
  return dice >= threshold;
}

/**
 * 提取文本的 bigram 集合（带计数）
 * Extract bigram multiset from text
 */
function getBigrams(text: string): Map<string, number> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const bigrams = new Map<string, number>();
  for (let i = 0; i < normalized.length - 1; i++) {
    const bigram = normalized.slice(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
  }
  return bigrams;
}

/**
 * 从消息中提取关键词/标签
 * Extract keywords/tags from a message
 */
export function extractTags(content: string): string[] {
  // 提取有意义的词（长度 >= 2）/ Extract meaningful words (length >= 2)
  const words = content
    .replace(/[^\w\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  // 去重并取前20个 / Deduplicate and take top 20
  return [...new Set(words)].slice(0, 20);
}
