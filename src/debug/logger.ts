/**
 * logger.ts — 调试日志模块
 * Debug logging module for context operations
 *
 * 日志存储在 ~/.openclaw/shared-context/debug/ 目录
 * Logs stored in ~/.openclaw/shared-context/debug/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginConfig } from "../config.js";

/** 日志条目 / Log entry */
export interface DebugLogEntry {
  timestamp: string;
  agentId: string;
  sessionId: string;
  operation: "assemble" | "ingest" | "compact" | "bootstrap" | "afterTurn" | "search";
  tokensUsed?: number;
  tokensWithShared?: number;
  tokensWithoutShared?: number;
  selectedContextCount?: number;
  selectedContextIds?: string[];
  selectionReason?: string;
  duration?: number;
  details?: Record<string, unknown>;
}

export class DebugLogger {
  private debugDir: string;
  private config: PluginConfig;
  private apiLogger: any;

  constructor(config: PluginConfig, apiLogger?: any) {
    this.config = config;
    this.apiLogger = apiLogger;
    this.debugDir = path.join(
      config.localDir.replace("~", process.env.HOME || "/root"),
      "debug"
    );
    this._ensureDir();
  }

  /** 确保调试目录存在 / Ensure debug directory exists */
  private _ensureDir(): void {
    try {
      fs.mkdirSync(this.debugDir, { recursive: true });
    } catch {
      // 忽略 / Ignore
    }
  }

  /**
   * 记录调试日志 / Write debug log entry
   */
  log(entry: DebugLogEntry): void {
    if (this.config.debugLevel === "off") return;

    const logEntry = {
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    };

    // 写入文件 / Write to file
    const dateStr = new Date().toISOString().split("T")[0];
    const logFile = path.join(this.debugDir, `${dateStr}.jsonl`);

    try {
      fs.appendFileSync(logFile, JSON.stringify(logEntry) + "\n", "utf-8");
    } catch (err) {
      this.apiLogger?.warn?.(`[context-shared-claw] Failed to write debug log: ${err}`);
    }

    // 使用 api.logger 输出 / Also log via api.logger
    if (this.config.debugLevel === "verbose") {
      this.apiLogger?.debug?.(
        `[context-shared-claw] ${entry.operation} | agent=${entry.agentId} | session=${entry.sessionId} | tokens=${entry.tokensUsed ?? "?"}`
      );
    }
  }

  /**
   * 读取最近的调试日志 / Read recent debug logs
   */
  getRecentLogs(limit: number = 50): DebugLogEntry[] {
    try {
      const files = fs
        .readdirSync(this.debugDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();

      const entries: DebugLogEntry[] = [];

      for (const file of files) {
        if (entries.length >= limit) break;
        const content = fs.readFileSync(path.join(this.debugDir, file), "utf-8");
        const lines = content.trim().split("\n").filter(Boolean).reverse();
        for (const line of lines) {
          if (entries.length >= limit) break;
          try {
            entries.push(JSON.parse(line));
          } catch {
            // 跳过损坏行 / Skip corrupt lines
          }
        }
      }

      return entries;
    } catch {
      return [];
    }
  }

  /**
   * 记录对比模式日志 / Log compare mode results
   */
  logCompare(
    agentId: string,
    sessionId: string,
    tokensWithShared: number,
    tokensWithoutShared: number
  ): void {
    this.log({
      timestamp: new Date().toISOString(),
      agentId,
      sessionId,
      operation: "assemble",
      tokensWithShared,
      tokensWithoutShared,
      details: {
        compareMode: true,
        tokenDifference: tokensWithShared - tokensWithoutShared,
        percentageIncrease:
          tokensWithoutShared > 0
            ? (((tokensWithShared - tokensWithoutShared) / tokensWithoutShared) * 100).toFixed(1)
            : "N/A",
      },
    });
  }
}
