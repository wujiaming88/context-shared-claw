/**
 * config.ts — 配置类型定义和验证
 * Configuration types and validation for context-shared-claw
 */

/** Agent 配置 / Per-agent config */
export interface AgentConfig {
  /** 是否启用共享上下文 / Whether shared context is enabled */
  shared: boolean;
  /** 上下文来源（按优先级）/ Context sources in priority order */
  sources: Array<"local" | "openviking">;
  /** 写入目标 / Write destination */
  writeTo?: "local" | "openviking";
}

/** OpenViking 服务器配置 / OpenViking server config */
export interface OpenVikingConfig {
  host: string;
  apiKey?: string;
  timeout: number;
}

/** 插件完整配置 / Full plugin config */
export interface PluginConfig {
  agents: Record<string, AgentConfig>;
  localDir: string;
  openviking: OpenVikingConfig;
  compareMode: boolean;
  debugLevel: "off" | "basic" | "verbose";
  maxContextEntries: number;
  defaultTokenBudget: number;
  /** 共享上下文占总预算的最大比例 (0-1) / Max ratio of budget for shared context */
  sharedBudgetRatio: number;
  /** Announce 条目保护 TTL（毫秒）/ TTL for protected announce entries (ms) */
  announceProtectTTL: number;
}

/** 共享上下文条目 / Shared context entry */
export interface ContextEntry {
  id: string;
  agentId: string;
  sessionId: string;
  content: string;
  role: string;
  timestamp: number;
  tokens: number;
  tags: string[];
  /** 来源 / Source of this entry */
  source: "local" | "openviking";
}

/**
 * 从原始配置构建完整配置（带默认值）
 * Build full config from raw input with defaults
 */
export function resolveConfig(raw: Record<string, unknown> = {}): PluginConfig {
  const agents: Record<string, AgentConfig> = {};
  const rawAgents = (raw.agents as Record<string, any>) || {};

  for (const [name, cfg] of Object.entries(rawAgents)) {
    agents[name] = {
      shared: cfg?.shared ?? false,
      sources: cfg?.sources ?? ["local"],
      writeTo: cfg?.writeTo,
    };
  }

  const rawOV = (raw.openviking as Record<string, any>) || {};

  return {
    agents,
    localDir: (raw.localDir as string) || "~/.openclaw/shared-context",
    openviking: {
      host: rawOV.host || "http://localhost:1933",
      apiKey: rawOV.apiKey,
      timeout: rawOV.timeout ?? 5000,
    },
    compareMode: (raw.compareMode as boolean) ?? false,
    debugLevel: (raw.debugLevel as PluginConfig["debugLevel"]) || "basic",
    maxContextEntries: (raw.maxContextEntries as number) ?? 100,
    defaultTokenBudget: (raw.defaultTokenBudget as number) ?? 4000,
    sharedBudgetRatio: Math.min(1, Math.max(0, (raw.sharedBudgetRatio as number) ?? 0.3)),
    announceProtectTTL: (raw.announceProtectTTL as number) ?? 24 * 60 * 60 * 1000, // 默认 24h
  };
}

/**
 * 获取指定 Agent 的配置（未配置则返回 undefined）
 * Get config for a specific agent, undefined if not configured
 */
export function getAgentConfig(
  config: PluginConfig,
  sessionId: string
): AgentConfig | undefined {
  // sessionId 格式通常是 "agent:<agentId>:..." / sessionId format is typically "agent:<agentId>:..."
  const agentId = extractAgentId(sessionId);
  return config.agents[agentId];
}

/**
 * 从 sessionId 提取 agentId
 * Extract agentId from sessionId
 *
 * 支持的格式 / Supported formats:
 *   "session:agent:<agentId>:..."  → agentId
 *   "agent:<agentId>:..."          → agentId
 *   "<agentId>"                    → agentId (直接使用)
 */
export function extractAgentId(sessionId: string): string {
  const parts = sessionId.split(":");

  // 格式: "session:agent:<agentId>:..."
  if (parts[0] === "session" && parts[1] === "agent" && parts.length >= 3) {
    return parts[2];
  }

  // 格式: "agent:<agentId>:..."
  if (parts[0] === "agent" && parts.length >= 2) {
    return parts[1];
  }

  return sessionId;
}
