#!/usr/bin/env node

/**
 * cli.ts — context-shared-claw CLI 入口
 * CLI entry point for context-shared-claw
 *
 * 用法 / Usage:
 *   npx tsx src/cli.ts <command> [options]
 *   context-shared-claw <command> [options]
 *
 * 命令 / Commands:
 *   evaluate       效果评估报告 / Evaluation report
 *   stats          统计数据 / Statistics
 *   pool-size      共享池大小 / Pool size
 *   recent-logs    最近操作日志 / Recent logs
 *   config         当前配置 / Current config
 *   compare        Token 对比 / Token comparison
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfig } from "./config.js";
import { SharedContextEngine } from "./engine.js";

// ─── 配置加载 / Config loading ───

function loadPluginConfig(): Record<string, unknown> {
  // 依次查找配置文件 / Search config files in order
  const home = process.env.HOME || "/root";
  const candidates = [
    process.env.CONTEXT_SHARED_CONFIG,
    path.join(home, ".openclaw", "plugins", "context-shared-claw", "config.json"),
    path.join(home, ".openclaw", "shared-context", "config.json"),
    path.join(process.cwd(), "config.json"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, "utf-8");
      return JSON.parse(content);
    } catch {
      // 继续尝试 / Try next
    }
  }

  // 尝试从 OpenClaw 主配置中提取 / Try extracting from OpenClaw main config
  const openclawConfig = path.join(home, ".openclaw", "config.json");
  try {
    const content = fs.readFileSync(openclawConfig, "utf-8");
    const config = JSON.parse(content);
    if (config?.plugins?.["context-shared-claw"]) {
      return config.plugins["context-shared-claw"];
    }
  } catch {
    // 忽略 / Ignore
  }

  // 返回默认配置 / Return defaults
  return {};
}

// ─── 日志模拟 / Logger mock ───

const mockApi = {
  logger: {
    info: (..._args: unknown[]) => {},
    debug: (..._args: unknown[]) => {},
    warn: (...args: unknown[]) => console.error("[WARN]", ...args),
    error: (...args: unknown[]) => console.error("[ERROR]", ...args),
  },
};

// ─── 命令处理 / Command handlers ───

async function cmdEvaluate(engine: SharedContextEngine) {
  const report = await engine.evaluate();
  console.log(report);
}

async function cmdStats(engine: SharedContextEngine, agentId?: string) {
  const stats = engine.getStatistics();
  if (agentId) {
    // 过滤特定 Agent / Filter specific agent
    console.log(JSON.stringify({ agentId, stats }, null, 2));
  } else {
    console.log(JSON.stringify(stats, null, 2));
  }
}

async function cmdPoolSize(engine: SharedContextEngine) {
  const sizes = await engine.getPoolSize();
  console.log("\n📦 共享池大小 / Pool Size\n");
  let total = 0;
  for (const [source, count] of Object.entries(sizes)) {
    console.log(`  ${source}: ${count} entries`);
    total += count;
  }
  console.log(`\n  Total: ${total} entries\n`);
}

async function cmdRecentLogs(engine: SharedContextEngine, limit: number) {
  const logs = engine.getRecentLogs(limit);
  if (logs.length === 0) {
    console.log("\n📋 No recent logs\n");
    return;
  }
  console.log(`\n📋 最近 ${logs.length} 条操作日志 / Recent ${logs.length} Logs\n`);
  for (const log of logs) {
    const ts = (log as any).timestamp || "?";
    const op = (log as any).operation || "?";
    const agent = (log as any).agentId || "?";
    const tokens = (log as any).tokensUsed ?? "-";
    const dur = (log as any).duration ?? "-";
    console.log(`  [${ts}] ${agent} | ${op} | ${tokens} tok | ${dur}ms`);
  }
  console.log();
}

function cmdConfig(engine: SharedContextEngine) {
  const config = engine.getConfig();
  console.log(JSON.stringify(config, null, 2));
}

// ─── 帮助 / Help ───

function printHelp() {
  console.log(`
context-shared-claw — 跨 Agent 共享上下文引擎 CLI

用法 / Usage:
  context-shared-claw <command> [options]

命令 / Commands:
  evaluate                    效果评估报告 / Evaluation report
  stats [--agent <id>]        统计数据 / Statistics
  pool-size                   共享池大小 / Pool size
  recent-logs [--limit <n>]   最近操作日志 / Recent logs (default: 20)
  config                      当前配置 / Current config
  help                        显示帮助 / Show help

环境变量 / Environment:
  CONTEXT_SHARED_CONFIG       自定义配置文件路径 / Custom config file path

示例 / Examples:
  context-shared-claw evaluate
  context-shared-claw stats --agent waicode
  context-shared-claw recent-logs --limit 10
  context-shared-claw pool-size
`);
}

// ─── 主入口 / Main ───

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  // 解析选项 / Parse options
  const options: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      options[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }

  // 加载配置和创建引擎 / Load config and create engine
  const pluginConfig = loadPluginConfig();
  const engine = new SharedContextEngine(pluginConfig, mockApi);

  try {
    switch (command) {
      case "evaluate":
        await cmdEvaluate(engine);
        break;

      case "stats":
        await cmdStats(engine, options.agent);
        break;

      case "pool-size":
      case "pool_size":
      case "poolsize":
        await cmdPoolSize(engine);
        break;

      case "recent-logs":
      case "recent_logs":
      case "logs":
        await cmdRecentLogs(engine, parseInt(options.limit || "20", 10));
        break;

      case "config":
        cmdConfig(engine);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    await engine.dispose();
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
