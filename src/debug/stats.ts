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

  /** 加载统计文件 / Load stats from file */
  private _load(): GlobalStats {
    try {
      const content = fs.readFileSync(this.statsFile, "utf-8");
      return JSON.parse(content);
    } catch {
      return {
        agents: {},
        totalOperations: 0,
        startTime: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      };
    }
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
    if (sharedHit) a.sharedContextHits++;
    else a.sharedContextMisses++;
    a.lastActivity = new Date().toISOString();
    this.stats.totalOperations++;
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
