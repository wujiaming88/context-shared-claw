/**
 * openviking.ts — OpenViking 共享源
 * OpenViking HTTP API-based shared context source
 *
 * 通过 HTTP API（端口 1933）与 OpenViking Server 交互
 * Interacts with OpenViking Server via HTTP API (port 1933)
 *
 * 支持 L0/L1/L2 三级上下文加载:
 *   L0 - 核心上下文（始终加载）/ Core context (always loaded)
 *   L1 - 相关上下文（按需加载）/ Related context (loaded on demand)
 *   L2 - 扩展上下文（搜索加载）/ Extended context (loaded via search)
 */

import * as http from "node:http";
import * as https from "node:https";
import type { ContextEntry, OpenVikingConfig } from "../config.js";
import { estimateTokens } from "../utils/tokens.js";
import type { SharedSource } from "./local.js";

/** OpenViking API 响应 / API response types */
interface OVSearchResult {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  score?: number;
}

interface OVContentItem {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  level?: number; // L0=0, L1=1, L2=2
}

export class OpenVikingSource implements SharedSource {
  private config: OpenVikingConfig;

  constructor(config: OpenVikingConfig) {
    this.config = config;
  }

  /**
   * HTTP 请求工具 / HTTP request helper
   */
  private async _request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const url = new URL(endpoint, this.config.host);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(this.config.apiKey
            ? { Authorization: `Bearer ${this.config.apiKey}` }
            : {}),
        },
        timeout: this.config.timeout,
      };

      const req = lib.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(`OpenViking: invalid JSON response from ${endpoint}`));
          }
        });
      });

      req.on("error", (err) =>
        reject(new Error(`OpenViking: request failed - ${err.message}`))
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`OpenViking: request timeout (${this.config.timeout}ms)`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * 读取共享上下文（支持 L0/L1/L2 三级）
   * Read shared context with L0/L1/L2 level support
   */
  async read(
    agentId: string,
    sessionId: string,
    query?: string,
    limit: number = 20
  ): Promise<ContextEntry[]> {
    try {
      const entries: ContextEntry[] = [];

      // L0: 核心上下文（始终加载）/ Core context (always loaded)
      const l0Items = await this._request<OVContentItem[]>(
        "GET",
        `/api/v1/content/?level=0&limit=${Math.ceil(limit / 3)}`
      );
      entries.push(...this._toContextEntries(l0Items, "openviking"));

      // L1: 相关上下文 / Related context
      if (query) {
        const l1Items = await this._request<OVSearchResult[]>(
          "POST",
          "/api/v1/search/",
          { query, limit: Math.ceil(limit / 3), level: 1 }
        );
        entries.push(
          ...l1Items.map((item) => this._searchResultToEntry(item))
        );
      }

      // L2: 扩展上下文（仅在有具体查询时）/ Extended context (only with specific query)
      if (query && entries.length < limit) {
        const l2Items = await this._request<OVSearchResult[]>(
          "POST",
          "/api/v1/search/",
          { query, limit: limit - entries.length, level: 2 }
        );
        entries.push(
          ...l2Items.map((item) => this._searchResultToEntry(item))
        );
      }

      return entries.slice(0, limit);
    } catch (err) {
      // OpenViking 不可用时返回空 / Return empty when OpenViking unavailable
      return [];
    }
  }

  /**
   * 写入共享上下文到 OpenViking
   * Write shared context entry to OpenViking
   */
  async write(entry: ContextEntry): Promise<void> {
    try {
      await this._request("POST", "/api/v1/content/", {
        id: entry.id,
        content: entry.content,
        metadata: {
          agentId: entry.agentId,
          sessionId: entry.sessionId,
          role: entry.role,
          timestamp: entry.timestamp,
          tokens: entry.tokens,
          tags: entry.tags,
        },
      });
    } catch {
      // 写入失败静默处理 / Silent failure on write
    }
  }

  async count(): Promise<number> {
    try {
      const result = await this._request<{ count: number }>(
        "GET",
        "/api/v1/fs/?count=true"
      );
      return result.count || 0;
    } catch {
      return 0;
    }
  }

  async cleanup(_maxEntries: number): Promise<number> {
    // OpenViking 自行管理存储 / OpenViking manages its own storage
    return 0;
  }

  /** 转换 OpenViking 内容到 ContextEntry / Convert OV content to ContextEntry */
  private _toContextEntries(
    items: OVContentItem[],
    source: "openviking"
  ): ContextEntry[] {
    if (!Array.isArray(items)) return [];
    return items.map((item) => ({
      id: item.id || `ov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentId: (item.metadata?.agentId as string) || "unknown",
      sessionId: (item.metadata?.sessionId as string) || "unknown",
      content: item.content || "",
      role: (item.metadata?.role as string) || "system",
      timestamp: (item.metadata?.timestamp as number) || Date.now(),
      tokens: estimateTokens(item.content || ""),
      tags: (item.metadata?.tags as string[]) || [],
      source,
    }));
  }

  /** 转换搜索结果到 ContextEntry / Convert search result to ContextEntry */
  private _searchResultToEntry(item: OVSearchResult): ContextEntry {
    return {
      id: item.id || `ov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentId: (item.metadata?.agentId as string) || "unknown",
      sessionId: (item.metadata?.sessionId as string) || "unknown",
      content: item.content || "",
      role: (item.metadata?.role as string) || "system",
      timestamp: (item.metadata?.timestamp as number) || Date.now(),
      tokens: estimateTokens(item.content || ""),
      tags: (item.metadata?.tags as string[]) || [],
      source: "openviking",
    };
  }
}
