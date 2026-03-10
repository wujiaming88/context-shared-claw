/**
 * index.ts — 插件入口
 * Plugin entry point: registers ContextEngine and context_debug tool
 *
 * OpenClaw 使用 jiti 即时编译，不需要构建步骤
 * OpenClaw uses jiti for JIT compilation, no build step needed
 */

import { SharedContextEngine } from "./engine.js";

/**
 * 插件激活函数
 * Plugin activation function — called by OpenClaw plugin loader
 *
 * @param api - OpenClaw Plugin API
 */
export function activate(api: any): void {
  const logger = api.logger;
  logger?.info?.("[context-shared-claw] Activating plugin...");

  // 获取插件配置 / Get plugin configuration
  // api.pluginConfig = plugins.entries["context-shared-claw"].config
  // api.config = 全局 OpenClaw 配置 / global OpenClaw config
  const config = api.pluginConfig || {};

  // 创建共享上下文引擎实例 / Create shared context engine instance
  const engine = new SharedContextEngine(config, api);

  // ================================================
  // 1. 注册 Context Engine / Register Context Engine
  // ================================================
  // registerContextEngine(id, factory) — id 必须与 plugins.slots.contextEngine 匹配
  // registerContextEngine(id, factory) — id must match plugins.slots.contextEngine
  if (api.registerContextEngine) {
    api.registerContextEngine("context-shared-claw", () => engine);
    logger?.info?.("[context-shared-claw] Context engine registered with id 'context-shared-claw'");
  } else {
    logger?.warn?.(
      "[context-shared-claw] api.registerContextEngine not available — running in degraded mode"
    );
  }

  // ================================================
  // 2. 注册调试工具 / Register debug tool
  // ================================================
  if (api.registerTool) {
    api.registerTool({
      name: "context_debug",
      description:
        "查询共享上下文的调试信息 / Query shared context debug information.\n" +
        "Subcommands: pool_size, recent_logs, stats, config, compare",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: ["pool_size", "recent_logs", "stats", "config", "compare", "evaluate"],
            description:
              "调试命令 / Debug command:\n" +
              "- pool_size: 共享上下文池大小 / Shared context pool size\n" +
              "- recent_logs: 最近的操作日志 / Recent operation logs\n" +
              "- stats: 各 Agent 的统计数据 / Per-agent statistics\n" +
              "- config: 当前配置 / Current configuration\n" +
              "- compare: Token 消耗对比 / Token consumption comparison\n" +
              "- evaluate: 共享上下文效果评估报告 / Shared context effectiveness report",
          },
          limit: {
            type: "number",
            description: "结果数量限制（用于 recent_logs）/ Result limit (for recent_logs)",
            default: 20,
          },
          agentId: {
            type: "string",
            description: "指定 Agent ID（用于过滤）/ Agent ID filter",
          },
        },
        required: ["command"],
      },
      handler: async (args: {
        command: string;
        limit?: number;
        agentId?: string;
      }) => {
        try {
          switch (args.command) {
            case "pool_size": {
              const sizes = await engine.getPoolSize();
              return {
                success: true,
                data: sizes,
                summary: Object.entries(sizes)
                  .map(([name, count]) => `${name}: ${count} entries`)
                  .join(", "),
              };
            }

            case "recent_logs": {
              const logs = engine.getRecentLogs(args.limit || 20);
              const filtered = args.agentId
                ? logs.filter((l) => l.agentId === args.agentId)
                : logs;
              return {
                success: true,
                data: filtered,
                summary: `${filtered.length} recent log entries`,
              };
            }

            case "stats": {
              const stats = engine.getStatistics();
              if (args.agentId) {
                const agentStats = stats.agents[args.agentId];
                return {
                  success: true,
                  data: agentStats || null,
                  summary: agentStats
                    ? `Agent ${args.agentId}: ${agentStats.assembleCount} assembles, ${agentStats.ingestCount} ingests, hit rate: ${
                        agentStats.sharedContextHits + agentStats.sharedContextMisses > 0
                          ? (
                              (agentStats.sharedContextHits /
                                (agentStats.sharedContextHits + agentStats.sharedContextMisses)) *
                              100
                            ).toFixed(1) + "%"
                          : "N/A"
                      }`
                    : `No stats for agent ${args.agentId}`,
                };
              }
              return {
                success: true,
                data: stats,
                summary: `${stats.totalOperations} total operations across ${Object.keys(stats.agents).length} agents`,
              };
            }

            case "config": {
              return {
                success: true,
                data: engine.getConfig(),
              };
            }

            case "compare": {
              const stats = engine.getStatistics();
              const logs = engine
                .getRecentLogs(100)
                .filter(
                  (l) =>
                    l.operation === "assemble" &&
                    (l as any).details?.compareMode === true
                );

              return {
                success: true,
                data: {
                  recentComparisons: logs.slice(0, args.limit || 10),
                  agentStats: Object.entries(stats.agents).map(
                    ([id, s]) => ({
                      agentId: id,
                      totalAssembleTokens: s.totalAssembleTokens,
                      hitRate:
                        s.sharedContextHits + s.sharedContextMisses > 0
                          ? (
                              (s.sharedContextHits /
                                (s.sharedContextHits + s.sharedContextMisses)) *
                              100
                            ).toFixed(1) + "%"
                          : "N/A",
                      compactSavings:
                        s.preCompactTokens > 0
                          ? s.preCompactTokens - s.postCompactTokens
                          : 0,
                    })
                  ),
                },
                summary: `${logs.length} compare-mode entries found`,
              };
            }

            case "evaluate": {
              const report = await engine.evaluate();
              return {
                success: true,
                data: report,
                summary: report,
              };
            }

            default:
              return {
                success: false,
                error: `Unknown command: ${args.command}. Available: pool_size, recent_logs, stats, config, compare, evaluate`,
              };
          }
        } catch (err: any) {
          return {
            success: false,
            error: `Debug command failed: ${err.message}`,
          };
        }
      },
    });

    logger?.info?.("[context-shared-claw] Debug tool 'context_debug' registered");
  }

  logger?.info?.("[context-shared-claw] Plugin activated successfully");
}

/**
 * 插件停用函数
 * Plugin deactivation function
 */
export function deactivate(): void {
  // 清理由 dispose() 处理 / Cleanup handled by engine.dispose()
}
