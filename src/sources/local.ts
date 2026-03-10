/**
 * local.ts — 本地文件共享源
 * Local file-based shared context source
 *
 * 使用 JSON 文件存储上下文条目，按 agent/session 分类
 * Uses JSON files for context storage, organized by agent/session
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextEntry, PluginConfig } from "../config.js";
import { searchEntries, extractTags } from "../utils/search.js";
import { estimateTokens } from "../utils/tokens.js";

/** 本地共享源接口 / Local source interface */
export interface SharedSource {
  /** 读取共享上下文 / Read shared context entries */
  read(agentId: string, sessionId: string, query?: string, limit?: number): Promise<ContextEntry[]>;
  /** 写入共享上下文 / Write a shared context entry */
  write(entry: ContextEntry): Promise<void>;
  /** 获取条目总数 / Get total entry count */
  count(): Promise<number>;
  /** 清理过期条目 / Cleanup expired entries */
  cleanup(maxEntries: number): Promise<number>;
}

export class LocalSource implements SharedSource {
  private baseDir: string;
  private indexFile: string;
  private entries: ContextEntry[] = [];
  private loaded = false;

  constructor(config: PluginConfig) {
    this.baseDir = path.join(
      config.localDir.replace("~", process.env.HOME || "/root"),
      "entries"
    );
    this.indexFile = path.join(this.baseDir, "_index.json");
    this._ensureDir();
  }

  /** 确保目录存在 / Ensure directory exists */
  private _ensureDir(): void {
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
    } catch {
      // 忽略 / Ignore
    }
  }

  /** 延迟加载索引 / Lazy load index */
  private _loadIndex(): void {
    if (this.loaded) return;
    try {
      const content = fs.readFileSync(this.indexFile, "utf-8");
      this.entries = JSON.parse(content);
    } catch {
      this.entries = [];
    }
    this.loaded = true;
  }

  /** 保存索引 / Save index to disk */
  private _saveIndex(): void {
    try {
      fs.writeFileSync(this.indexFile, JSON.stringify(this.entries, null, 2), "utf-8");
    } catch {
      // 静默失败 / Silent failure
    }
  }

  async read(
    agentId: string,
    _sessionId: string,
    query?: string,
    limit: number = 20
  ): Promise<ContextEntry[]> {
    this._loadIndex();

    // 过滤：排除当前 agent 自己的条目（共享给其他 agent 的）
    // Filter: exclude current agent's own entries (shared with others)
    const candidates = this.entries.filter((e) => e.agentId !== agentId);

    if (query) {
      return searchEntries(candidates, query, limit);
    }

    // 默认返回最新的条目 / Default: return newest entries
    return candidates
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async write(entry: ContextEntry): Promise<void> {
    this._loadIndex();

    // 补充 tags / Add tags if missing
    if (!entry.tags || entry.tags.length === 0) {
      entry.tags = extractTags(entry.content);
    }
    if (!entry.tokens) {
      entry.tokens = estimateTokens(entry.content);
    }
    entry.source = "local";

    // 检查重复（按 id）/ Check duplicate by id
    const existIdx = this.entries.findIndex((e) => e.id === entry.id);
    if (existIdx >= 0) {
      this.entries[existIdx] = entry;
    } else {
      this.entries.push(entry);
    }

    // 同时写单独文件（按 agent 分类）/ Also write individual file by agent
    const agentDir = path.join(this.baseDir, entry.agentId);
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, `${entry.id}.json`),
        JSON.stringify(entry, null, 2),
        "utf-8"
      );
    } catch {
      // 静默 / Silent
    }

    this._saveIndex();
  }

  async count(): Promise<number> {
    this._loadIndex();
    return this.entries.length;
  }

  async cleanup(maxEntries: number, options?: {
    protectFilter?: (entry: ContextEntry) => boolean;
  }): Promise<number> {
    this._loadIndex();
    if (this.entries.length <= maxEntries) return 0;

    // 如果有保护过滤器，分离受保护条目
    // If protectFilter provided, separate protected entries
    const protectFn = options?.protectFilter;

    if (protectFn) {
      const protectedEntries: ContextEntry[] = [];
      const regularEntries: ContextEntry[] = [];
      for (const entry of this.entries) {
        if (protectFn(entry)) {
          protectedEntries.push(entry);
        } else {
          regularEntries.push(entry);
        }
      }
      const regularBudget = Math.max(0, maxEntries - protectedEntries.length);
      regularEntries.sort((a, b) => b.timestamp - a.timestamp);
      const removed = regularEntries.splice(regularBudget);
      this.entries = [...protectedEntries, ...regularEntries];
      this._saveIndex();
      this._cleanupFiles(removed);
      return removed.length;
    }

    // 默认：按时间排序，保留最新的 / Default: sort by time, keep newest
    this.entries.sort((a, b) => b.timestamp - a.timestamp);
    const removed = this.entries.splice(maxEntries);
    this._saveIndex();
    this._cleanupFiles(removed);
    return removed.length;
  }

  /** 清理单独文件 / Cleanup individual files */
  private _cleanupFiles(entries: ContextEntry[]): void {
    for (const entry of entries) {
      try {
        fs.unlinkSync(
          path.join(this.baseDir, entry.agentId, `${entry.id}.json`)
        );
      } catch {
        // 忽略 / Ignore
      }
    }
  }
}
