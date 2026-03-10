/**
 * stats.ts — 统计指标模块
 * Statistics and metrics tracking
 *
 * 统计文件：~/.openclaw/shared-context/stats.json
 * Stats file: ~/.openclaw/shared-context/stats.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginConfig } from "../config.js";

/** Agent 统计 / Per-agent statistics */
export interface AgentStats {
  assembleCount: number;
  ingestCount: number;
  compactCount: number;
  totalAssembleTokens: number;
  totalIngestTokens: number;
  sharedContextHits: number;
  sharedContextMisses: number;
  /** 压缩前总 token / Total tokens before compaction */
  preCompactTokens: number;
  /** 压缩后总 token / Total tokens after compaction */
  postCompactTokens: number;
  lastActivity: string;
}

/** 全局统计 / Global statistics */
export interface GlobalStats {
  agents: Record<string, AgentStats>;
  totalOperations: number;
  startTime: string;
  lastUpdated: string;

  // === 新增：效果评估字段 / New: evaluation metrics ===

  /** 每个 Agent 的入池条目统计 / Per-agent pool entry stats */
  poolByAgent: Record<string, { count: number; totalTokens: number }>;

  /** assemble 命中统计 / Assemble hit statistics */
  assembleHits: number;
  assembleMisses: number;

  /** 跨 Agent 流向：sourceAgent -> targetAgent -> count / Cross-agent flow */
  crossAgentFlow: Record<string, Record<string, number>>;

  /** Token 经济性 / Token economics */
  totalSharedTokensInjected: number;
  totalBudgetUsed: number;
}

export class StatsTracker {
  private statsFile: string;
  private stats: GlobalStats;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: PluginConfig) {
    const baseDir = config.localDir.replace("~", process.env.HOME || "/root");
    this.statsFile = path.join(baseDir, "stats.json");
    this.stats = this._load();
  }

  /** 加载统计文件（向后兼容）/ Load stats from file (backward compatible) */
  private _load(): GlobalStats {
    try {
      const content = fs.readFileSync(this.statsFile, "utf-8");
      const raw = JSON.parse(content);
      // 向后兼容：旧文件缺少新字段时用默认值
      // Backward compatible: use defaults for missing fields in old stats files
      return {
        agents: raw.agents || {},
        totalOperations: raw.totalOperations || 0,
        startTime: raw.startTime || new Date().toISOString(),
        lastUpdated: raw.lastUpdated || new Date().toISOString(),
        poolByAgent: raw.poolByAgent || {},
        assembleHits: raw.assembleHits || 0,
        assembleMisses: raw.assembleMisses || 0,
        crossAgentFlow: raw.crossAgentFlow || {},
        totalSharedTokensInjected: raw.totalSharedTokensInjected || 0,
        totalBudgetUsed: raw.totalBudgetUsed || 0,
      };
    } catch {
      return this._defaultStats();
    }
  }

  /** 默认统计数据 / Default stats */
  private _defaultStats(): GlobalStats {
    return {
      agents: {},
      totalOperations: 0,
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      poolByAgent: {},
      assembleHits: 0,
      assembleMisses: 0,
      crossAgentFlow: {},
      totalSharedTokensInjected: 0,
      totalBudgetUsed: 0,
    };
  }

  /** 获取或创建 Agent 统计 / Get or create agent stats */
  private _agent(agentId: string): AgentStats {
    if (!this.stats.agents[agentId]) {
      this.stats.agents[agentId] = {
        assembleCount: 0,
        ingestCount: 0,
        compactCount: 0,
        totalAssembleTokens: 0,
        totalIngestTokens: 0,
        sharedContextHits: 0,
        sharedContextMisses: 0,
        preCompactTokens: 0,
        postCompactTokens: 0,
        lastActivity: new Date().toISOString(),
      };
    }
    return this.stats.agents[agentId];
  }

  /** 记录 assemble 操作 / Record assemble operation */
  recordAssemble(agentId: string, tokens: number, sharedHit: boolean): void {
    const a = this._agent(agentId);
    a.assembleCount++;
    a.totalAssembleTokens += tokens;
    if (sharedHit) {
      a.sharedContextHits++;
      this.stats.assembleHits++;
    } else {
      a.sharedContextMisses++;
      this.stats.assembleMisses++;
    }
    this.stats.totalSharedTokensInjected += tokens;
    a.lastActivity = new Date().toISOString();
    this.stats.totalOperations++;
    this._scheduleSave();
  }

  /** 记录入池条目统计 / Record pool entry stats */
  recordPoolEntry(agentId: string, tokens: number): void {
    if (!this.stats.poolByAgent[agentId]) {
      this.stats.poolByAgent[agentId] = { count: 0, totalTokens: 0 };
    }
    this.stats.poolByAgent[agentId].count++;
    this.stats.poolByAgent[agentId].totalTokens += tokens;
    this._scheduleSave();
  }

  /**
   * 记录跨 Agent 流向 / Record cross-agent flow
   * @param sourceAgent - 条目来源 Agent / Source agent of the entry
   * @param targetAgent - 请求者 Agent / Requesting agent
   * @param count - 条目数 / Number of entries
   */
  recordCrossAgentFlow(sourceAgent: string, targetAgent: string, count: number): void {
    if (!this.stats.crossAgentFlow[sourceAgent]) {
      this.stats.crossAgentFlow[sourceAgent] = {};
    }
    if (!this.stats.crossAgentFlow[sourceAgent][targetAgent]) {
      this.stats.crossAgentFlow[sourceAgent][targetAgent] = 0;
    }
    this.stats.crossAgentFlow[sourceAgent][targetAgent] += count;
    this._scheduleSave();
  }

  /** 记录预算使用 / Record budget usage */
  recordBudgetUsed(budget: number): void {
    this.stats.totalBudgetUsed += budget;
    this._scheduleSave();
  }

  /** 记录 ingest 操作 / Record ingest operation */
  recordIngest(agentId: string, tokens: number): void {
    const a = this._agent(agentId);
    a.ingestCount++;
    a.totalIngestTokens += tokens;
    a.lastActivity = new Date().toISOString();
    this.stats.totalOperations++;
    this._scheduleSave();
  }

  /** 记录 compact 操作 / Record compact operation */
  recordCompact(agentId: string, preTokens: number, postTokens: number): void {
    const a = this._agent(agentId);
    a.compactCount++;
    a.preCompactTokens += preTokens;
    a.postCompactTokens += postTokens;
    a.lastActivity = new Date().toISOString();
    this.stats.totalOperations++;
    this._scheduleSave();
  }

  /** 获取全局统计 / Get global stats */
  getStats(): GlobalStats {
    return { ...this.stats };
  }

  /** 获取 Agent 统计 / Get agent stats */
  getAgentStats(agentId: string): AgentStats | undefined {
    return this.stats.agents[agentId];
  }

  /** 延迟保存（避免频繁写盘）/ Deferred save (avoid frequent disk writes) */
  private _scheduleSave(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this._save();
      this.flushTimer = null;
    }, 2000);
  }

  /** 保存到磁盘 / Save to disk */
  private _save(): void {
    if (!this.dirty) return;
    this.stats.lastUpdated = new Date().toISOString();
    try {
      const dir = path.dirname(this.statsFile);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2), "utf-8");
      this.dirty = false;
    } catch {
      // 静默失败 / Silent failure
    }
  }

  /** 强制保存 / Force save */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this._save();
  }
}
