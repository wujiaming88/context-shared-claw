/**
 * local.ts — 本地文件共享源（无冲突版）
 * Local file-based shared context source (conflict-free)
 *
 * 架构：写隔离 + 读合并 + 原子写入
 * Architecture: Write isolation + Read merge + Atomic writes
 *
 * 存储结构：
 * shared-context/entries/
 * ├── main/                    ← Agent main 的专属目录
 * │   ├── _index.json          ← main 自己的索引（只有 main 写）
 * │   ├── main-1710...-a1b2.json
 * │   └── main-1710...-c3d4.json
 * ├── waicode/                 ← Agent waicode 的专属目录
 * │   ├── _index.json          ← waicode 自己的索引（只有 waicode 写）
 * │   └── waicode-1710...-e5f6.json
 * ├── wairesearch/
 * │   └── _index.json
 * └── ...
 *
 * 写入：每个 Agent 只写自己目录下的 _index.json（无竞争）
 * 读取：合并所有 Agent 目录的 _index.json（只读，无竞争）
 * 清理：每个 Agent 只清理自己的条目
 *
 * Write: Each agent only writes to its own _index.json (no contention)
 * Read: Merge all agents' _index.json files (read-only, no contention)
 * Cleanup: Each agent only cleans up its own entries
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
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
  cleanup(maxEntries: number, options?: { protectFilter?: (entry: ContextEntry) => boolean }): Promise<number>;
}

export class LocalSource implements SharedSource {
  private baseDir: string;

  constructor(config: PluginConfig) {
    this.baseDir = path.join(
      config.localDir.replace("~", process.env.HOME || "/root"),
      "entries"
    );
    this._ensureDir(this.baseDir);
  }

  /** 确保目录存在 / Ensure directory exists */
  private _ensureDir(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // 忽略 / Ignore
    }
  }

  /** 获取某个 Agent 的目录 / Get agent-specific directory */
  private _agentDir(agentId: string): string {
    return path.join(this.baseDir, agentId);
  }

  /** 获取某个 Agent 的索引文件路径 / Get agent-specific index path */
  private _agentIndexPath(agentId: string): string {
    return path.join(this._agentDir(agentId), "_index.json");
  }

  /**
   * 读取单个 Agent 的索引 / Read a single agent's index
   * 只读操作，无写冲突风险 / Read-only, no write contention
   */
  private _readAgentIndex(agentId: string): ContextEntry[] {
    try {
      const content = fs.readFileSync(this._agentIndexPath(agentId), "utf-8");
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  /**
   * 原子写入 Agent 索引 / Atomic write to agent index
   *
   * 写入流程：先写临时文件，再 rename 覆盖
   * Process: Write to temp file first, then rename to overwrite
   *
   * 为什么用 rename：
   * - rename 在同一文件系统上是原子操作（POSIX 保证）
   * - 即使进程在写入中途崩溃，索引文件要么是旧版本，要么是新版本
   * - 不会出现半写（partial write）导致 JSON 损坏
   *
   * Why rename:
   * - rename on same filesystem is atomic (POSIX guarantee)
   * - If process crashes mid-write, index is either old or new version
   * - No partial writes that corrupt JSON
   */
  private _writeAgentIndex(agentId: string, entries: ContextEntry[]): void {
    const indexPath = this._agentIndexPath(agentId);
    const tmpPath = `${indexPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf-8");
      fs.renameSync(tmpPath, indexPath);
    } catch {
      // 清理残留临时文件 / Cleanup leftover temp file
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  /**
   * 列出所有 Agent 目录 / List all agent directories
   */
  private _listAgentIds(): string[] {
    try {
      return fs.readdirSync(this.baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  /**
   * 读取所有 Agent 的条目（合并）/ Read all agents' entries (merged)
   * 只读操作：遍历所有 Agent 目录，读取各自的 _index.json
   * Read-only: iterate all agent dirs, read each _index.json
   */
  private _readAllEntries(): ContextEntry[] {
    const allEntries: ContextEntry[] = [];
    for (const agentId of this._listAgentIds()) {
      allEntries.push(...this._readAgentIndex(agentId));
    }
    return allEntries;
  }

  /**
   * read — 读取共享上下文
   *
   * 合并所有 Agent 的索引，排除请求者自己的条目
   * Merge all agents' indexes, exclude the requester's own entries
   */
  async read(
    agentId: string,
    _sessionId: string,
    query?: string,
    limit: number = 20
  ): Promise<ContextEntry[]> {
    // 读取其他所有 Agent 的条目（排除自己）
    // Read all other agents' entries (exclude self)
    const candidates: ContextEntry[] = [];
    for (const otherId of this._listAgentIds()) {
      if (otherId === agentId) continue; // 跳过自己 / Skip self
      candidates.push(...this._readAgentIndex(otherId));
    }

    if (query) {
      return searchEntries(candidates, query, limit);
    }

    // 默认返回最新的条目 / Default: return newest entries
    return candidates
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * write — 写入共享上下文
   *
   * 只写入当前 Agent 自己的索引和文件，无跨 Agent 写竞争
   * Only writes to current agent's own index and files, no cross-agent contention
   */
  async write(entry: ContextEntry): Promise<void> {
    // 补充 tags / Add tags if missing
    if (!entry.tags || entry.tags.length === 0) {
      entry.tags = extractTags(entry.content);
    }
    if (!entry.tokens) {
      entry.tokens = estimateTokens(entry.content);
    }
    entry.source = "local";

    const agentId = entry.agentId;
    const agentDir = this._agentDir(agentId);
    this._ensureDir(agentDir);

    // 读取当前 Agent 自己的索引 / Read current agent's own index
    const entries = this._readAgentIndex(agentId);

    // 检查重复（按 id）/ Check duplicate by id
    const existIdx = entries.findIndex((e) => e.id === entry.id);
    if (existIdx >= 0) {
      entries[existIdx] = entry;
    } else {
      entries.push(entry);
    }

    // 原子写入索引 / Atomic write index
    this._writeAgentIndex(agentId, entries);

    // 写单独文件（可选，方便调试查看）/ Write individual file (optional, for debug)
    try {
      const tmpEntry = path.join(agentDir, `${entry.id}.json.tmp`);
      const finalEntry = path.join(agentDir, `${entry.id}.json`);
      fs.writeFileSync(tmpEntry, JSON.stringify(entry, null, 2), "utf-8");
      fs.renameSync(tmpEntry, finalEntry);
    } catch {
      // 静默 / Silent
    }
  }

  /**
   * count — 获取所有 Agent 的条目总数
   * Get total entry count across all agents
   */
  async count(): Promise<number> {
    let total = 0;
    for (const agentId of this._listAgentIds()) {
      total += this._readAgentIndex(agentId).length;
    }
    return total;
  }

  /**
   * cleanup — 清理过期条目
   *
   * 每个 Agent 独立清理自己的条目，均摊 maxEntries 配额
   * Each agent cleans its own entries independently, sharing the maxEntries quota
   *
   * 分配策略：按条目数比例分配配额
   * Allocation: proportional quota based on entry count
   */
  async cleanup(maxEntries: number, options?: {
    protectFilter?: (entry: ContextEntry) => boolean;
  }): Promise<number> {
    const agentIds = this._listAgentIds();
    if (agentIds.length === 0) return 0;

    // 统计各 Agent 的条目数 / Count entries per agent
    const agentEntries = new Map<string, ContextEntry[]>();
    let totalCount = 0;
    for (const agentId of agentIds) {
      const entries = this._readAgentIndex(agentId);
      agentEntries.set(agentId, entries);
      totalCount += entries.length;
    }

    if (totalCount <= maxEntries) return 0;

    let totalRemoved = 0;
    const protectFn = options?.protectFilter;

    for (const [agentId, entries] of agentEntries) {
      // 按比例分配配额（至少保留 1 条）/ Proportional quota (min 1)
      const quota = Math.max(1, Math.floor((entries.length / totalCount) * maxEntries));

      if (entries.length <= quota) continue;

      let toKeep: ContextEntry[];
      let removed: ContextEntry[];

      if (protectFn) {
        const protectedEntries = entries.filter(protectFn);
        const regular = entries.filter((e) => !protectFn(e));
        const regularQuota = Math.max(0, quota - protectedEntries.length);
        regular.sort((a, b) => b.timestamp - a.timestamp);
        removed = regular.splice(regularQuota);
        toKeep = [...protectedEntries, ...regular];
      } else {
        entries.sort((a, b) => b.timestamp - a.timestamp);
        removed = entries.splice(quota);
        toKeep = entries;
      }

      // 原子写入清理后的索引 / Atomic write cleaned index
      this._writeAgentIndex(agentId, toKeep);

      // 清理单独文件 / Cleanup individual files
      for (const entry of removed) {
        try {
          fs.unlinkSync(path.join(this._agentDir(agentId), `${entry.id}.json`));
        } catch {
          // 忽略 / Ignore
        }
      }

      totalRemoved += removed.length;
    }

    return totalRemoved;
  }
}
