/**
 * engine.ts — ContextEngine 核心实现
 * Core ContextEngine implementation for shared context
 *
 * 实现 OpenClaw ContextEngine 接口，管理跨 Agent 共享上下文
 * Implements OpenClaw ContextEngine interface, manages cross-agent shared context
 */

import * as crypto from "node:crypto";
import type { PluginConfig, ContextEntry, AgentConfig } from "./config.js";
import { resolveConfig, getAgentConfig, extractAgentId } from "./config.js";
import { estimateTokens } from "./utils/tokens.js";
import { LocalSource } from "./sources/local.js";
import { OpenVikingSource } from "./sources/openviking.js";
import { DebugLogger } from "./debug/logger.js";
import { StatsTracker } from "./debug/stats.js";
import { generateCompare } from "./debug/compare.js";
import type { SharedSource } from "./sources/local.js";

/**
 * SharedContextEngine — 共享上下文引擎
 *
 * 核心逻辑：
 * 1. ingest: 将 agent 消息写入共享上下文池
 * 2. assemble: 从共享池中检索相关上下文，注入到消息流
 * 3. compact: 压缩共享上下文，控制 token 消耗
 */
export class SharedContextEngine {
  readonly info = {
    name: "context-shared-claw",
    version: "0.1.0",
    description: "Cross-agent shared context engine / 跨 Agent 共享上下文引擎",
  };

  private config: PluginConfig;
  private sources: Map<string, SharedSource> = new Map();
  private logger: DebugLogger;
  private stats: StatsTracker;
  private apiLogger: any;

  constructor(pluginConfig: Record<string, unknown>, api: any) {
    this.config = resolveConfig(pluginConfig);
    this.apiLogger = api?.logger;

    // 初始化来源 / Initialize sources
    this.sources.set("local", new LocalSource(this.config));
    this.sources.set("openviking", new OpenVikingSource(this.config.openviking));

    // 初始化调试工具 / Initialize debug tools
    this.logger = new DebugLogger(this.config, this.apiLogger);
    this.stats = new StatsTracker(this.config);

    this.apiLogger?.info?.(
      `[context-shared-claw] Initialized | agents=${Object.keys(this.config.agents).length} | compareMode=${this.config.compareMode}`
    );
  }

  /**
   * bootstrap — 会话初始化
   * Session initialization, load existing shared context
   */
  async bootstrap(params: {
    sessionId: string;
    sessionFile: string;
  }): Promise<{ messages?: any[] }> {
    const agentId = extractAgentId(params.sessionId);
    const agentCfg = getAgentConfig(this.config, params.sessionId);

    this.logger.log({
      timestamp: new Date().toISOString(),
      agentId,
      sessionId: params.sessionId,
      operation: "bootstrap",
      details: {
        shared: agentCfg?.shared ?? false,
        sources: agentCfg?.sources ?? [],
      },
    });

    // 未配置或未启用共享：透传 / Not configured or not enabled: passthrough
    if (!agentCfg?.shared) {
      return {};
    }

    return {};
  }

  /**
   * ingest — 消息摄入
   * Ingest a message into the shared context pool
   */
  async ingest(params: {
    sessionId: string;
    message: { role: string; content?: string };
    isHeartbeat?: boolean;
  }): Promise<{ tokens?: number }> {
    const agentId = extractAgentId(params.sessionId);
    const agentCfg = getAgentConfig(this.config, params.sessionId);

    // 未启用共享：透传 / Not enabled: passthrough
    if (!agentCfg?.shared) {
      return {};
    }

    // 心跳消息不处理 / Skip heartbeat messages
    if (params.isHeartbeat) return {};

    const content = params.message.content || "";
    if (!content.trim()) return {};

    const tokens = estimateTokens(content);
    const startTime = Date.now();

    // 创建上下文条目 / Create context entry
    const entry: ContextEntry = {
      id: `${agentId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      agentId,
      sessionId: params.sessionId,
      content,
      role: params.message.role,
      timestamp: Date.now(),
      tokens,
      tags: [],
      source: "local",
    };

    // 写入指定源 / Write to configured destination
    const writeTo = agentCfg.writeTo || agentCfg.sources[0] || "local";
    const source = this.sources.get(writeTo);
    if (source) {
      await source.write(entry);
    }

    // 统计和日志 / Stats and logging
    this.stats.recordIngest(agentId, tokens);
    this.logger.log({
      timestamp: new Date().toISOString(),
      agentId,
      sessionId: params.sessionId,
      operation: "ingest",
      tokensUsed: tokens,
      duration: Date.now() - startTime,
      details: {
        role: params.message.role,
        writeTo,
        entryId: entry.id,
        contentLength: content.length,
      },
    });

    return { tokens };
  }

  /**
   * ingestBatch — 批量消息摄入
   * Batch ingest messages into shared context pool
   */
  async ingestBatch(params: {
    sessionId: string;
    messages: Array<{ role: string; content?: string }>;
    isHeartbeat?: boolean;
  }): Promise<{ results: Array<{ tokens?: number }> }> {
    const results = [];
    for (const message of params.messages) {
      const result = await this.ingest({
        sessionId: params.sessionId,
        message,
        isHeartbeat: params.isHeartbeat,
      });
      results.push(result);
    }
    return { results };
  }

  /**
   * afterTurn — 轮次结束回调
   * Called after each conversation turn
   */
  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: Array<{ role: string; content?: string }>;
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }): Promise<void> {
    const agentId = extractAgentId(params.sessionId);
    const agentCfg = getAgentConfig(this.config, params.sessionId);

    if (!agentCfg?.shared) return;

    this.logger.log({
      timestamp: new Date().toISOString(),
      agentId,
      sessionId: params.sessionId,
      operation: "afterTurn",
      details: {
        messageCount: params.messages.length,
        prePromptMessageCount: params.prePromptMessageCount,
        hasAutoCompaction: !!params.autoCompactionSummary,
      },
    });

    // 清理过期条目 / Cleanup expired entries
    const localSource = this.sources.get("local") as LocalSource;
    if (localSource) {
      await localSource.cleanup(this.config.maxContextEntries);
    }
  }

  /**
   * assemble — 上下文组装
   * Assemble shared context into the message stream
   *
   * 这是核心方法：从共享池中检索相关上下文，注入到消息流
   * Core method: retrieve relevant shared context and inject into message stream
   */
  async assemble(params: {
    sessionId: string;
    messages: Array<{ role: string; content?: string }>;
    tokenBudget?: number;
  }): Promise<{
    messages?: Array<{ role: string; content: string }>;
    systemMessage?: string;
    tokens?: number;
  }> {
    const agentId = extractAgentId(params.sessionId);
    const agentCfg = getAgentConfig(this.config, params.sessionId);

    // 未启用共享：透传原始消息 / Not enabled: passthrough
    if (!agentCfg?.shared) {
      this.stats.recordAssemble(agentId, 0, false);
      return {};
    }

    const startTime = Date.now();
    const budget = params.tokenBudget || this.config.defaultTokenBudget;

    // 从最后几条消息提取查询关键词 / Extract query from recent messages
    const recentMessages = params.messages.slice(-5);
    const query = recentMessages
      .map((m) => m.content || "")
      .filter(Boolean)
      .join(" ");

    // 从所有配置的来源读取共享上下文 / Read from all configured sources
    const allEntries: ContextEntry[] = [];
    for (const sourceName of agentCfg.sources) {
      const source = this.sources.get(sourceName);
      if (source) {
        const entries = await source.read(agentId, params.sessionId, query, 20);
        allEntries.push(...entries);
      }
    }

    // 按相关性和时间排序，截断到 token 预算 / Sort and truncate to budget
    // 预留 50% 预算给共享上下文 / Reserve 50% budget for shared context
    const sharedBudget = Math.floor(budget * 0.5);
    let usedTokens = 0;
    const selectedEntries: ContextEntry[] = [];

    for (const entry of allEntries) {
      if (usedTokens + entry.tokens > sharedBudget) break;
      selectedEntries.push(entry);
      usedTokens += entry.tokens;
    }

    // 对比模式 / Compare mode
    if (this.config.compareMode && selectedEntries.length > 0) {
      generateCompare(
        params.messages,
        selectedEntries,
        agentId,
        params.sessionId,
        this.logger
      );
    }

    // 构建共享上下文系统消息 / Build shared context system message
    let systemMessage: string | undefined;
    if (selectedEntries.length > 0) {
      const contextParts = selectedEntries.map((e) => {
        const source = e.source === "openviking" ? "[OpenViking]" : "[Local]";
        return `${source} [${e.agentId}] (${new Date(e.timestamp).toISOString()}): ${e.content}`;
      });

      systemMessage = [
        "=== Shared Context from Other Agents / 其他 Agent 的共享上下文 ===",
        ...contextParts,
        "=== End Shared Context / 共享上下文结束 ===",
      ].join("\n");
    }

    // 统计和日志 / Stats and logging
    const sharedHit = selectedEntries.length > 0;
    this.stats.recordAssemble(agentId, usedTokens, sharedHit);

    this.logger.log({
      timestamp: new Date().toISOString(),
      agentId,
      sessionId: params.sessionId,
      operation: "assemble",
      tokensUsed: usedTokens,
      selectedContextCount: selectedEntries.length,
      selectedContextIds: selectedEntries.map((e) => e.id),
      selectionReason: query
        ? `keyword search: "${query.slice(0, 100)}"`
        : "recent entries (no query)",
      duration: Date.now() - startTime,
      details: {
        budget,
        sharedBudget,
        totalCandidates: allEntries.length,
        sources: agentCfg.sources,
      },
    });

    return {
      systemMessage,
      tokens: usedTokens,
    };
  }

  /**
   * compact — 上下文压缩
   * Compact shared context to save tokens
   */
  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<{
    compacted?: boolean;
    removedTokens?: number;
    summary?: string;
  }> {
    const agentId = extractAgentId(params.sessionId);
    const agentCfg = getAgentConfig(this.config, params.sessionId);

    if (!agentCfg?.shared) {
      return { compacted: false };
    }

    const startTime = Date.now();
    const localSource = this.sources.get("local") as LocalSource;
    if (!localSource) return { compacted: false };

    const preCount = await localSource.count();
    const preTokens = params.currentTokenCount || 0;

    // 清理过期条目 / Cleanup old entries
    const removed = await localSource.cleanup(this.config.maxContextEntries);

    const postCount = await localSource.count();
    const estimatedRemovedTokens = removed * 50; // 估算每条约50 token

    this.stats.recordCompact(agentId, preTokens, preTokens - estimatedRemovedTokens);

    this.logger.log({
      timestamp: new Date().toISOString(),
      agentId,
      sessionId: params.sessionId,
      operation: "compact",
      tokensUsed: estimatedRemovedTokens,
      duration: Date.now() - startTime,
      details: {
        preCount,
        postCount,
        removedEntries: removed,
        force: params.force,
      },
    });

    return {
      compacted: removed > 0,
      removedTokens: estimatedRemovedTokens,
      summary: removed > 0
        ? `Compacted shared context: removed ${removed} entries (est. ${estimatedRemovedTokens} tokens)`
        : "No compaction needed",
    };
  }

  /**
   * prepareSubagentSpawn — 子代理生成准备
   * Prepare context sharing for a subagent spawn
   */
  async prepareSubagentSpawn(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<{ inheritedContext?: string } | undefined> {
    const parentAgent = extractAgentId(params.parentSessionKey);
    const parentCfg = getAgentConfig(this.config, params.parentSessionKey);

    if (!parentCfg?.shared) return undefined;

    // 将父 agent 的最新上下文标记为可继承 / Mark parent's recent context as inheritable
    this.apiLogger?.debug?.(
      `[context-shared-claw] Preparing subagent spawn: ${parentAgent} -> ${extractAgentId(params.childSessionKey)}`
    );

    return {
      inheritedContext: `Shared context from parent agent: ${parentAgent}`,
    };
  }

  /**
   * onSubagentEnded — 子代理结束回调
   * Callback when a subagent session ends
   */
  async onSubagentEnded(params: {
    childSessionKey: string;
    reason: string;
  }): Promise<void> {
    this.apiLogger?.debug?.(
      `[context-shared-claw] Subagent ended: ${params.childSessionKey} (${params.reason})`
    );
  }

  /**
   * dispose — 清理资源
   * Cleanup resources on shutdown
   */
  async dispose(): Promise<void> {
    this.stats.flush();
    this.apiLogger?.info?.("[context-shared-claw] Disposed");
  }

  // ============================================================
  // 调试工具方法（供 context_debug 工具调用）
  // Debug tool methods (called by context_debug tool)
  // ============================================================

  /** 获取共享上下文池大小 / Get shared context pool size */
  async getPoolSize(): Promise<Record<string, number>> {
    const sizes: Record<string, number> = {};
    for (const [name, source] of this.sources) {
      sizes[name] = await source.count();
    }
    return sizes;
  }

  /** 获取最近的操作日志 / Get recent operation logs */
  getRecentLogs(limit?: number) {
    return this.logger.getRecentLogs(limit);
  }

  /** 获取统计数据 / Get statistics */
  getStatistics() {
    return this.stats.getStats();
  }

  /** 获取配置信息 / Get config info */
  getConfig() {
    return {
      agents: this.config.agents,
      compareMode: this.config.compareMode,
      debugLevel: this.config.debugLevel,
      maxContextEntries: this.config.maxContextEntries,
      defaultTokenBudget: this.config.defaultTokenBudget,
    };
  }
}
