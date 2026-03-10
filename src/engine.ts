/**
 * engine.ts — ContextEngine 核心实现（包装模式）
 * Core ContextEngine implementation (wrapper pattern)
 *
 * 包装 LegacyContextEngine，在其基础上增加跨 Agent 共享上下文能力。
 * Wraps LegacyContextEngine, adding cross-agent shared context on top.
 *
 * - 非共享 Agent → 100% 委托 legacy（完全不干预）
 * - 共享 Agent → legacy 基础工作 + 注入共享上下文
 *
 * - Non-shared agents → 100% delegated to legacy (zero interference)
 * - Shared agents → legacy base work + shared context injection
 */

import * as crypto from "node:crypto";
import type { PluginConfig, ContextEntry, AgentConfig } from "./config.js";
import { resolveConfig, getAgentConfig, extractAgentId } from "./config.js";
import { estimateTokens } from "./utils/tokens.js";
import { isSimilar } from "./utils/search.js";
import { LocalSource } from "./sources/local.js";
import { OpenVikingSource } from "./sources/openviking.js";
import { DebugLogger } from "./debug/logger.js";
import { StatsTracker } from "./debug/stats.js";
import { generateCompare } from "./debug/compare.js";
import type { SharedSource } from "./sources/local.js";

/**
 * 从 AgentMessage.content 提取纯文本
 * Extract plain text from AgentMessage.content (handles string, array, and other types)
 */
function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return String(content);
}

/**
 * SharedContextEngine — 包装模式共享上下文引擎
 * Wrapper-pattern shared context engine
 *
 * 架构 / Architecture:
 *
 *   用户消息 → SharedContextEngine
 *                │
 *                ├── 非共享 Agent → legacy.method() → 原始结果
 *                │
 *                └── 共享 Agent → legacy.method() → 原始结果
 *                                    + 共享上下文逻辑 → 增强结果
 */
export class SharedContextEngine {
  readonly info = {
    id: "context-shared-claw",
    name: "context-shared-claw",
    version: "0.2.0",
    description: "Cross-agent shared context engine (wrapper mode) / 跨 Agent 共享上下文引擎（包装模式）",
    ownsCompaction: false, // legacy 负责 compaction / legacy handles compaction
  };

  private config: PluginConfig;
  private sources: Map<string, SharedSource> = new Map();
  private logger: DebugLogger;
  private stats: StatsTracker;
  private apiLogger: any;

  constructor(pluginConfig: Record<string, unknown>, api: any) {
    this.config = resolveConfig(pluginConfig);
    this.apiLogger = api?.logger;

    // 不依赖 LegacyContextEngine 导入
    // LegacyContextEngine 的行为：
    //   ingest: no-op（Runtime/SessionManager 处理消息持久化）
    //   assemble: pass-through（返回原始消息，Runtime 处理 sanitize/validate/limit）
    //   compact: 委托 Runtime（ownsCompaction=false 时 Runtime 自动处理）
    //   afterTurn: no-op
    // 我们直接实现相同的透传行为，无需导入
    //
    // No LegacyContextEngine import needed.
    // Legacy behavior is essentially:
    //   ingest: no-op (Runtime handles persistence)
    //   assemble: pass-through (return original messages)
    //   compact: delegated (ownsCompaction=false lets Runtime handle it)
    //   afterTurn: no-op
    // We implement the same pass-through behavior directly.

    // 初始化来源 / Initialize sources
    this.sources.set("local", new LocalSource(this.config));
    this.sources.set("openviking", new OpenVikingSource(this.config.openviking));

    // 初始化调试工具 / Initialize debug tools
    this.logger = new DebugLogger(this.config, this.apiLogger);
    this.stats = new StatsTracker(this.config);

    this.apiLogger?.info?.(
      `[context-shared-claw] Initialized (wrapper mode) | agents=${Object.keys(this.config.agents).length} | compareMode=${this.config.compareMode}`
    );
  }

  /**
   * 判断是否为共享 Agent / Check if agent has shared enabled
   */
  private _isShared(sessionId: string): { shared: boolean; agentId: string; agentCfg?: AgentConfig } {
    const agentId = extractAgentId(sessionId);
    const agentCfg = getAgentConfig(this.config, sessionId);
    return { shared: !!agentCfg?.shared, agentId, agentCfg };
  }

  // ════════════════════════════════════════════════════════════
  // ContextEngine 接口方法 / ContextEngine interface methods
  // ════════════════════════════════════════════════════════════

  /**
   * bootstrap — 会话初始化
   * 非共享：委托 legacy | 共享：委托 legacy + 记录日志
   */
  async bootstrap(params: {
    sessionId: string;
    sessionFile: string;
  }) {
    const { shared, agentId } = this._isShared(params.sessionId);

    if (shared) {
      this.logger.log({
        timestamp: new Date().toISOString(),
        agentId,
        sessionId: params.sessionId,
        operation: "bootstrap",
        details: { shared: true },
      });
    }

    // Legacy behavior: no-op, return bootstrapped
    return { bootstrapped: true };
  }

  /**
   * ingest — 消息摄入
   * 非共享：委托 legacy | 共享：委托 legacy + 写入共享池
   */
  async ingest(params: {
    sessionId: string;
    message: { role: string; content?: string };
    isHeartbeat?: boolean;
  }) {
    // 诊断日志：确认 Runtime 是否调用了 ingest / Diagnostic: confirm runtime calls ingest
    this.apiLogger?.info?.(`[context-shared-claw] ingest called | sessionId=${params.sessionId} | role=${params.message?.role} | contentType=${typeof params.message?.content} | contentLen=${String(params.message?.content || '').length}`);

    try {
    const { shared, agentId, agentCfg } = this._isShared(params.sessionId);

    // Legacy behavior: no-op (Runtime handles message persistence)
    const passthrough = { ingested: true };

    // 非共享 Agent：直接返回 / Non-shared: return immediately
    if (!shared || !agentCfg) return passthrough;

    // 以下是共享逻辑 / Below is shared-only logic
    if (params.isHeartbeat) return passthrough;

    const content = extractText(params.message.content);
    if (!content.trim()) return passthrough;

    // Announce 检测
    const msg = params.message as any;
    const isAnnounce =
      msg.type === "agent_internal_event" ||
      msg.metadata?.eventType === "task_completion" ||
      msg.metadata?.source === "subagent" ||
      (typeof content === "string" && content.includes("[Internal task completion event]"));

    if (isAnnounce) {
      this.logger.log({
        timestamp: new Date().toISOString(),
        agentId,
        sessionId: params.sessionId,
        operation: "ingest_skip_announce",
        details: { reason: "Managed by Runtime", contentPreview: content.slice(0, 100) },
      });
      return passthrough;
    }

    const tokens = estimateTokens(content);

    // 入池过滤 / Ingestion filters
    if (content.length < 50) {
      this.logger.log({
        timestamp: new Date().toISOString(), agentId, sessionId: params.sessionId,
        operation: "ingest_skip_short", details: { length: content.length },
      });
      return passthrough;
    }

    // 去重 / Dedup
    const localSource = this.sources.get("local") as LocalSource;
    if (localSource) {
      const recentEntries = await localSource.getRecentByAgent(agentId, 5);
      if (recentEntries.some((e) => isSimilar(e.content, content, 0.8))) {
        this.logger.log({
          timestamp: new Date().toISOString(), agentId, sessionId: params.sessionId,
          operation: "ingest_skip_duplicate", details: { contentPreview: content.slice(0, 100) },
        });
        return passthrough;
      }
    }

    // 创建并写入共享条目 / Create and write shared entry
    const entry: ContextEntry = {
      id: `${agentId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      agentId,
      sessionId: params.sessionId,
      content: params.message.role === "tool" && tokens > 2000
        ? content.slice(0, 6000) + "\n[... truncated for shared context]"
        : content,
      role: params.message.role,
      timestamp: Date.now(),
      tokens: params.message.role === "tool" && tokens > 2000
        ? estimateTokens(content.slice(0, 6000))
        : tokens,
      tags: [],
      source: "local",
    };

    const writeTo = agentCfg.writeTo || agentCfg.sources[0] || "local";
    const source = this.sources.get(writeTo);
    if (source) await source.write(entry);

    this.stats.recordIngest(agentId, entry.tokens);
    this.stats.recordPoolEntry(agentId, entry.tokens);

    return passthrough;
  }

  /**
   * ingestBatch — 批量摄入
   * 始终委托 legacy + 共享 Agent 额外写入共享池
   */
  async ingestBatch(params: {
    sessionId: string;
    messages: Array<{ role: string; content?: string }>;
    isHeartbeat?: boolean;
  }) {
    // Legacy behavior: no-op
    const passthrough = { ingestedCount: 0 };

    // 共享逻辑：逐条写入共享池 / Shared logic: write each to pool
    const { shared } = this._isShared(params.sessionId);
    if (shared) {
      for (const message of params.messages) {
        await this.ingest({
          sessionId: params.sessionId,
          message,
          isHeartbeat: params.isHeartbeat,
        });
      }
    }

    return passthrough;
    } catch (err: any) {
      this.apiLogger?.error?.(`[context-shared-claw] ingest ERROR: ${err?.message || err}`);
      return { ingested: false };
    }
  }
   * 始终委托 legacy + 共享 Agent 清理共享池
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
    // Legacy behavior: no-op (Runtime handles persistence)

    // 共享 Agent：清理共享池 / Shared agent: cleanup pool
    const { shared, agentId } = this._isShared(params.sessionId);
    if (shared) {
      const localSource = this.sources.get("local") as LocalSource;
      if (localSource) {
        await localSource.cleanup(this.config.maxContextEntries);
      }
    }
  }

  /**
   * assemble — 上下文组装（核心）
   * 始终委托 legacy + 共享 Agent 在 legacy 结果上注入共享上下文
   *
   * Non-shared: legacy result only
   * Shared: legacy result + systemPromptAddition with shared context
   */
  async assemble(params: {
    sessionId: string;
    messages: Array<{ role: string; content?: string }>;
    tokenBudget?: number;
  }) {
    // 诊断日志 / Diagnostic
    this.apiLogger?.info?.(`[context-shared-claw] assemble called | sessionId=${params.sessionId} | msgCount=${params.messages?.length} | budget=${params.tokenBudget}`);

    try {
    // Legacy behavior: pass-through (return original messages as-is)
    // Runtime handles sanitize/validate/limit pipeline
    const estimatedTokens = params.messages.reduce(
      (sum, m) => sum + estimateTokens(m.content), 0
    );
    const legacyResult = {
      messages: params.messages,
      estimatedTokens,
    };

    const { shared, agentId, agentCfg } = this._isShared(params.sessionId);

    // 非共享 Agent：直接返回 legacy 结果 / Non-shared: return legacy as-is
    if (!shared || !agentCfg) {
      return legacyResult;
    }

    // ═══ 以下是共享 Agent 的增强逻辑 ═══

    const startTime = Date.now();
    const budget = params.tokenBudget || this.config.defaultTokenBudget;

    // 弹性预算 / Elastic budget
    const existingTokens = legacyResult.estimatedTokens || 0;
    const ratioBasedBudget = Math.floor(budget * this.config.sharedBudgetRatio);
    const remainingBudget = Math.floor((budget - existingTokens) * 0.8);
    const sharedBudget = Math.max(0, Math.min(ratioBasedBudget, remainingBudget));

    if (sharedBudget === 0) {
      this.stats.recordAssemble(agentId, 0, false);
      return legacyResult;
    }

    // 检索共享上下文 / Retrieve shared context
    const recentMessages = params.messages.slice(-5);
    const query = recentMessages.map((m) => extractText(m.content)).filter(Boolean).join(" ");

    const allEntries: ContextEntry[] = [];
    for (const sourceName of agentCfg.sources) {
      const source = this.sources.get(sourceName);
      if (source) {
        const entries = await source.read(agentId, params.sessionId, query, 20);
        allEntries.push(...entries);
      }
    }

    let usedTokens = 0;
    const selectedEntries: ContextEntry[] = [];
    for (const entry of allEntries) {
      if (usedTokens + entry.tokens > sharedBudget) break;
      selectedEntries.push(entry);
      usedTokens += entry.tokens;
    }

    // 对比模式 / Compare mode
    if (this.config.compareMode && selectedEntries.length > 0) {
      generateCompare(params.messages, selectedEntries, agentId, params.sessionId, this.logger);
    }

    // 构建 systemPromptAddition / Build systemPromptAddition
    const sharedHit = selectedEntries.length > 0;
    this.stats.recordAssemble(agentId, usedTokens, sharedHit);
    this.stats.recordBudgetUsed(budget);

    if (sharedHit) {
      // 记录流向 / Record flow
      const flowBySource: Record<string, number> = {};
      for (const entry of selectedEntries) {
        flowBySource[entry.agentId] = (flowBySource[entry.agentId] || 0) + 1;
      }
      for (const [sourceAgent, count] of Object.entries(flowBySource)) {
        this.stats.recordCrossAgentFlow(sourceAgent, agentId, count);
      }
    }

    this.logger.log({
      timestamp: new Date().toISOString(),
      agentId,
      sessionId: params.sessionId,
      operation: "assemble",
      tokensUsed: usedTokens,
      selectedContextCount: selectedEntries.length,
      duration: Date.now() - startTime,
      details: { budget, sharedBudget, existingTokens, totalCandidates: allEntries.length },
    });

    // 在 legacy 结果上追加共享上下文 / Append shared context to legacy result
    if (selectedEntries.length > 0) {
      const contextParts = selectedEntries.map((e) => {
        const src = e.source === "openviking" ? "[OpenViking]" : "[Local]";
        return `${src} [${e.agentId}] (${new Date(e.timestamp).toISOString()}): ${e.content}`;
      });
      const sharedMessage = [
        "=== Shared Context from Other Agents ===",
        ...contextParts,
        "=== End Shared Context ===",
      ].join("\n");

      return {
        ...legacyResult,
        estimatedTokens: (legacyResult.estimatedTokens || 0) + usedTokens,
        systemPromptAddition: legacyResult.systemPromptAddition
          ? legacyResult.systemPromptAddition + "\n\n" + sharedMessage
          : sharedMessage,
      };
    }

    return legacyResult;
  }

  /**
   * compact — 上下文压缩
   * 始终委托 legacy + 共享 Agent 清理共享池
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
  }) {
    // Legacy behavior: no-op (ownsCompaction=false, Runtime handles compaction)
    const legacyResult = { ok: true, compacted: false, reason: "delegated to runtime" } as any;

    // 共享 Agent：额外清理共享池 / Shared agent: also cleanup shared pool
    const { shared, agentId } = this._isShared(params.sessionId);
    if (shared) {
      const localSource = this.sources.get("local") as LocalSource;
      if (localSource) {
        const targetEntries = params.force
          ? Math.floor(this.config.maxContextEntries * 0.5)
          : this.config.maxContextEntries;
        await localSource.cleanup(targetEntries);
      }
    }

    return legacyResult;
    } catch (err: any) {
      this.apiLogger?.error?.(`[context-shared-claw] assemble ERROR: ${err?.message || err}`);
      return { messages: params.messages, estimatedTokens: 0 };
    }
  }

  /**
   * prepareSubagentSpawn — 委托 legacy
   */
  async prepareSubagentSpawn(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }) {
    return undefined;
  }

  /**
   * onSubagentEnded — no-op
   */
  async onSubagentEnded(params: {
    childSessionKey: string;
    reason: string;
  }): Promise<void> {
    // no-op
  }

  /**
   * dispose — 清理
   */
  async dispose(): Promise<void> {
    this.stats.flush();
    this.apiLogger?.info?.("[context-shared-claw] Disposed");
  }

  // ============================================================
  // 调试工具方法（供 context_debug 工具调用）
  // Debug tool methods (called by context_debug tool)
  // ============================================================

  /**
   * evaluate — 生成共享上下文效果评估报告
   * Generate shared context effectiveness evaluation report
   */
  async evaluate(): Promise<string> {
    const localSource = this.sources.get("local") as LocalSource;
    const allEntries = localSource ? localSource.getAllEntries() : [];
    const stats = this.stats.getStats();

    // 池子健康度 / Pool health
    const total = allEntries.length;
    const effective = allEntries.filter((e) => e.tokens > 50).length;
    const effectiveRatio = total > 0 ? ((effective / total) * 100).toFixed(1) : "0.0";
    const totalTokens = allEntries.reduce((sum, e) => sum + e.tokens, 0);
    const avgTokens = total > 0 ? Math.round(totalTokens / total) : 0;

    // 信噪比评分：有效条目占比 / SNR score: effective entry ratio
    const snr = total > 0 ? ((effective / total) * 100).toFixed(1) : "0.0";

    // 使用情况 / Usage stats
    const totalAssembles = stats.assembleHits + stats.assembleMisses;
    const hitRate = totalAssembles > 0
      ? ((stats.assembleHits / totalAssembles) * 100).toFixed(1)
      : "0.0";
    const missRate = totalAssembles > 0
      ? ((stats.assembleMisses / totalAssembles) * 100).toFixed(1)
      : "0.0";

    // Token 经济性 / Token economics
    const injectedTokens = stats.totalSharedTokensInjected;
    const budgetUsed = stats.totalBudgetUsed;
    const budgetRatio = budgetUsed > 0
      ? ((injectedTokens / budgetUsed) * 100).toFixed(2)
      : "0.00";
    const maxRatio = (this.config.sharedBudgetRatio * 100).toFixed(0);

    // 跨 Agent 流向 / Cross-agent flow
    const flowLines: string[] = [];
    for (const [source, targets] of Object.entries(stats.crossAgentFlow)) {
      for (const [target, count] of Object.entries(targets)) {
        flowLines.push(`  ${source} → ${target}: ${count} 条被使用`);
      }
    }

    const report = [
      "📊 共享上下文效果报告",
      "─────────────────────",
      "",
      "池子健康度:",
      `  总条目: ${total} | 有效条目(>50tok): ${effective} (${effectiveRatio}%)`,
      `  平均条目大小: ${avgTokens} tok`,
      `  信噪比评分: ${snr}% (建议 >70%)`,
      "",
      "使用情况:",
      `  assemble 总次数: ${totalAssembles}`,
      `  命中次数: ${stats.assembleHits} (${hitRate}%)`,
      `  空命中: ${stats.assembleMisses} (${missRate}%)`,
      "",
      "Token 经济性:",
      `  共享上下文总注入 Token: ${injectedTokens}`,
      `  占总预算比例: ${budgetRatio}% (配置上限 ${maxRatio}%)`,
      "",
      "跨 Agent 流向:",
      flowLines.length > 0 ? flowLines.join("\n") : "  (暂无数据)",
    ].join("\n");

    return report;
  }

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
      sharedBudgetRatio: this.config.sharedBudgetRatio,
      announceProtectTTL: this.config.announceProtectTTL,
    };
  }
}
