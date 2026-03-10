# context-shared-claw

跨 Agent 共享上下文引擎 —— 让多个 OpenClaw Agent 自动共享工作上下文，提升团队协作质量。  
Cross-agent shared context engine — automatically share working context across multiple OpenClaw agents to improve team collaboration.

---

## 目录 / Table of Contents

- [功能特性 / Features](#功能特性--features)
- [架构 / Architecture](#架构--architecture)
- [安装 / Installation](#安装--installation)
- [配置 / Configuration](#配置--configuration)
- [入池过滤规则 / Ingestion Filters](#入池过滤规则--ingestion-filters)
- [调试工具 / Debug Tools](#调试工具--debug-tools)
- [效果评估 / Evaluation](#效果评估--evaluation)
- [测试 / Testing](#测试--testing)
- [许可 / License](#许可--license)

---

## 功能特性 / Features

| 功能 | Feature | 说明 / Description |
|------|---------|-------------------|
| 写隔离 | Write Isolation | 每个 Agent 只写自己的目录，无写冲突 / Each agent writes only to its own directory, no contention |
| 读合并 | Read Merge | assemble 时合并所有 Agent 的条目（排除自身）/ Merge all agents' entries on assemble (excluding self) |
| 原子写入 | Atomic Writes | 先写临时文件再 rename，不会出现半写损坏 / Write to temp file then rename, preventing partial-write corruption |
| 弹性预算 | Elastic Budget | 共享上下文根据已用 token 自动伸缩预算 / Shared context budget dynamically adjusts based on used tokens |
| 入池过滤 | Ingestion Filters | 短消息、心跳、announce、重复内容自动过滤 / Auto-filter short messages, heartbeats, announces, duplicates |
| 工具输出截断 | Tool Output Truncation | role=tool 且超 2000 token 时自动截断 / Auto-truncate tool output exceeding 2000 tokens |
| 关键词搜索 | Keyword Search | 基于 bigram 的关键词匹配和相关性排序 / Bigram-based keyword matching with relevance ranking |
| 效果评估 | Evaluation Report | 池子健康度、命中率、Token 经济性、跨 Agent 流向 / Pool health, hit rate, token economics, cross-agent flow |
| OpenViking 支持 | OpenViking Support | 可选对接 OpenViking 服务端进行分布式上下文共享 / Optional OpenViking server integration for distributed sharing |
| 对比模式 | Compare Mode | 同时生成有/无共享上下文，对比 Token 消耗 / Generate both variants to compare token consumption |

---

## 架构 / Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    SharedContextEngine                      │
│                                                            │
│  ingest()          assemble()           compact()          │
│  ┌──────┐          ┌──────────┐         ┌────────┐        │
│  │Filter│──write──▶│Read Merge│──inject──│Cleanup │        │
│  │ Chain │          │(exclude  │          │(quota  │        │
│  └──────┘          │  self)   │          │ based) │        │
│                    └──────────┘          └────────┘        │
└─────────────────────────┬──────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌─────────────┐ ┌─────────────┐ ┌──────────────┐
   │ LocalSource  │ │ LocalSource  │ │  OpenViking   │
   │  (agentA/)   │ │  (agentB/)   │ │  (HTTP API)   │
   │ _index.json  │ │ _index.json  │ │  L0/L1/L2     │
   └─────────────┘ └─────────────┘ └──────────────┘

存储结构 / Storage Layout:
shared-context/entries/
├── agentA/
│   ├── _index.json          ← agentA 独占写入 / agentA exclusive write
│   └── agentA-*.json        ← 单条目文件(调试用) / individual entry files (debug)
├── agentB/
│   ├── _index.json          ← agentB 独占写入 / agentB exclusive write
│   └── agentB-*.json
└── ...

写隔离 / Write Isolation:  Agent 只写自己的 _index.json
读合并 / Read Merge:        assemble 遍历所有目录，排除自身
原子写入 / Atomic Write:    writeFileSync → tmp → renameSync → final
弹性预算 / Elastic Budget:  sharedBudget = min(ratio × budget, (budget − used) × 0.8)
```

---

## 安装 / Installation

将插件目录放到 OpenClaw 的 plugins 目录下：  
Place the plugin directory under OpenClaw's plugins path:

```bash
# 克隆仓库 / Clone the repo
git clone https://github.com/wujiaming88/context-shared-claw.git

# 移动到 OpenClaw plugins 目录 / Move to OpenClaw plugins directory
mv context-shared-claw ~/.openclaw/plugins/context-shared-claw

# 或者使用符号链接 / Or use a symlink
ln -s /path/to/context-shared-claw ~/.openclaw/plugins/context-shared-claw
```

OpenClaw 使用 jiti 即时编译 TypeScript，无需构建步骤。  
OpenClaw uses jiti for JIT TypeScript compilation — no build step needed.

---

## 配置 / Configuration

在 OpenClaw 配置文件中添加插件配置：  
Add plugin configuration to your OpenClaw config:

```json
{
  "plugins": {
    "context-shared-claw": {
      "agents": {
        "main": {
          "shared": true,
          "sources": ["local"],
          "writeTo": "local"
        },
        "waicode": {
          "shared": true,
          "sources": ["local"]
        },
        "wairesearch": {
          "shared": true,
          "sources": ["local", "openviking"]
        }
      },
      "localDir": "~/.openclaw/shared-context",
      "openviking": {
        "host": "http://localhost:1933",
        "apiKey": "your-api-key",
        "timeout": 5000
      },
      "compareMode": false,
      "debugLevel": "basic",
      "maxContextEntries": 100,
      "defaultTokenBudget": 4000,
      "sharedBudgetRatio": 0.3,
      "announceProtectTTL": 86400000
    }
  }
}
```

### 配置字段说明 / Configuration Fields

| 字段 / Field | 类型 / Type | 默认值 / Default | 说明 / Description |
|---|---|---|---|
| `agents` | `object` | `{}` | 每个 Agent 的共享配置 / Per-agent sharing config |
| `agents.*.shared` | `boolean` | `false` | 是否启用共享上下文 / Enable shared context |
| `agents.*.sources` | `string[]` | `["local"]` | 上下文来源（按优先级）/ Context sources in priority order |
| `agents.*.writeTo` | `string` | 首个 source | 写入目标 / Write destination |
| `localDir` | `string` | `~/.openclaw/shared-context` | 本地存储目录 / Local storage directory |
| `openviking.host` | `string` | `http://localhost:1933` | OpenViking 服务地址 / OpenViking server URL |
| `openviking.apiKey` | `string` | — | OpenViking API 密钥 / API key |
| `openviking.timeout` | `number` | `5000` | 请求超时(ms) / Request timeout (ms) |
| `compareMode` | `boolean` | `false` | 对比模式：生成有/无共享上下文的对比数据 / Compare mode |
| `debugLevel` | `string` | `"basic"` | 日志级别：`off` / `basic` / `verbose` |
| `maxContextEntries` | `number` | `100` | 最大保留条目数 / Max entries to keep |
| `defaultTokenBudget` | `number` | `4000` | 默认 Token 预算 / Default token budget |
| `sharedBudgetRatio` | `number` | `0.3` | 共享上下文占总预算的最大比例 (0-1) / Max ratio of budget for shared context |
| `announceProtectTTL` | `number` | `86400000` | Announce 保护 TTL (ms) / Announce protection TTL |

---

## 入池过滤规则 / Ingestion Filters

消息在写入共享池前会经过多级过滤，提高信噪比：  
Messages are filtered before entering the shared pool to improve signal-to-noise ratio:

| 序号 | 规则 / Rule | 条件 / Condition | 行为 / Behavior |
|:---:|---|---|---|
| 1 | 心跳过滤 / Heartbeat | `isHeartbeat === true` | 跳过 / Skip |
| 2 | 空内容 / Empty | `content.trim() === ""` | 跳过 / Skip |
| 3 | Announce 过滤 | 包含 `[Internal task completion event]` 或相关元数据 | 跳过（由 Runtime 管理）/ Skip (managed by Runtime) |
| 4 | 短内容 / Short | `content.length < 50` | 跳过 / Skip |
| 5 | 去重 / Dedup | 与最近 5 条条目的 Dice 相似度 > 80% | 跳过 / Skip |
| 6 | 工具截断 / Tool Truncation | `role === "tool"` 且 token > 2000 | 截断至约 2000 token / Truncate to ~2000 tokens |

---

## 调试工具 / Debug Tools

插件注册了 `context_debug` 工具，支持以下子命令：  
The plugin registers a `context_debug` tool with these subcommands:

### `pool_size` — 共享池大小 / Pool Size

```json
{ "command": "pool_size" }
```

示例输出 / Example output:
```json
{ "success": true, "data": { "local": 42, "openviking": 0 }, "summary": "local: 42 entries, openviking: 0 entries" }
```

### `recent_logs` — 最近操作日志 / Recent Logs

```json
{ "command": "recent_logs", "limit": 10, "agentId": "waicode" }
```

示例输出 / Example output:
```json
{
  "success": true,
  "data": [
    {
      "timestamp": "2025-01-15T10:30:00.000Z",
      "agentId": "waicode",
      "sessionId": "agent:waicode:s1",
      "operation": "ingest",
      "tokensUsed": 85,
      "duration": 12,
      "details": { "role": "assistant", "writeTo": "local", "contentLength": 340 }
    }
  ],
  "summary": "1 recent log entries"
}
```

### `stats` — 统计数据 / Statistics

```json
{ "command": "stats" }
```

```json
{ "command": "stats", "agentId": "waicode" }
```

### `config` — 当前配置 / Current Config

```json
{ "command": "config" }
```

### `compare` — Token 对比 / Token Comparison

```json
{ "command": "compare", "limit": 5 }
```

### `evaluate` — 效果评估报告 / Evaluation Report

```json
{ "command": "evaluate" }
```

---

## 效果评估 / Evaluation

使用 `evaluate` 命令生成完整报告：  
Use the `evaluate` command to generate a full report:

```
📊 共享上下文效果报告
─────────────────────

池子健康度:
  总条目: 42 | 有效条目(>50tok): 38 (90.5%)
  平均条目大小: 120 tok
  信噪比评分: 90.5% (建议 >70%)

使用情况:
  assemble 总次数: 156
  命中次数: 132 (84.6%)
  空命中: 24 (15.4%)

Token 经济性:
  共享上下文总注入 Token: 15840
  占总预算比例: 2.54% (配置上限 30%)

跨 Agent 流向:
  waicode → main: 45 条被使用
  wairesearch → waicode: 23 条被使用
  main → wairesearch: 12 条被使用
```

### 指标说明 / Metrics

| 指标 / Metric | 说明 / Description |
|---|---|
| 总条目 / Total Entries | 共享池中的所有条目数 / Total entries in the shared pool |
| 有效条目 / Effective Entries | token > 50 的条目，过滤掉残留短条目 / Entries with >50 tokens |
| 信噪比 / SNR Score | 有效条目占比，建议 >70% / Effective entry ratio, recommended >70% |
| 命中率 / Hit Rate | assemble 时成功注入共享上下文的比例 / Rate of successful shared context injection |
| Token 经济性 / Token Economics | 共享上下文实际消耗 vs 总预算 / Actual shared token usage vs total budget |
| 跨 Agent 流向 / Cross-Agent Flow | 哪些 Agent 的上下文被哪些 Agent 使用 / Which agents' context is consumed by whom |

---

## 测试 / Testing

测试使用 Node.js 内置 `node:test` 和 `node:assert` 模块，通过 tsx 运行：  
Tests use Node.js built-in `node:test` and `node:assert`, run via tsx:

```bash
# 安装开发依赖 / Install dev dependencies
npm install -D tsx

# 运行所有测试 / Run all tests
npx tsx --test tests/*.test.ts
```

### 测试套件 / Test Suites

| 文件 / File | 测试数 / Tests | 覆盖 / Coverage |
|---|:---:|---|
| `ingest-filter.test.ts` | 7 | 短内容、空内容、正常消息、心跳、announce、工具截断、去重 |
| `write-isolation.test.ts` | 4 | Agent 目录隔离、跨 Agent 读取、自身排除、快速写入 |
| `elastic-budget.test.ts` | 3 | 正常预算、预算紧张、预算耗尽 |
| `atomic-write.test.ts` | 2 | 文件可解析、无 .tmp 残留 |
| `evaluate.test.ts` | 2 | 报告格式、空池默认值 |
| `search.test.ts` | 6 | isSimilar (4) + searchEntries (2) |
| **合计 / Total** | **24** | |

---

## 许可 / License

MIT
