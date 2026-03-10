# context-shared-claw

跨 Agent 共享上下文引擎 —— 让多个 [OpenClaw](https://github.com/openclaw/openclaw) Agent 自动共享工作上下文，提升团队协作质量。

> 📖 [English Documentation](./README.md)

---

## 目录

- [功能特性](#功能特性)
- [架构](#架构)
- [安装](#安装)
- [配置](#配置)
- [入池过滤规则](#入池过滤规则)
- [调试工具](#调试工具)
- [效果评估](#效果评估)
- [测试](#测试)
- [许可](#许可)

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **写隔离** | 每个 Agent 只写自己的目录，无写冲突 |
| **读合并** | assemble 时合并所有 Agent 的条目（排除自身） |
| **原子写入** | 先写临时文件再 rename，不会出现半写损坏 |
| **弹性预算** | 共享上下文根据已用 Token 自动伸缩预算 |
| **入池过滤** | 短消息、心跳、Announce、重复内容自动过滤 |
| **工具输出截断** | role=tool 且超 2000 token 时自动截断 |
| **关键词搜索** | 基于 bigram 的关键词匹配和相关性排序 |
| **效果评估** | 池子健康度、命中率、Token 经济性、跨 Agent 流向 |
| **OpenViking 支持** | 可选对接 OpenViking 服务端进行分布式上下文共享 |
| **对比模式** | 同时生成有/无共享上下文的对比数据，量化收益 |

---

## 架构

```
┌────────────────────────────────────────────────────────────┐
│                    SharedContextEngine                      │
│                                                            │
│  ingest()          assemble()           compact()          │
│  ┌──────┐          ┌──────────┐         ┌────────┐        │
│  │过滤链 │──写入──▶│ 读取合并  │──注入──│ 清理   │        │
│  │      │          │(排除自身) │          │(按配额) │        │
│  └──────┘          └──────────┘          └────────┘        │
└─────────────────────────┬──────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌─────────────┐ ┌─────────────┐ ┌──────────────┐
   │ LocalSource  │ │ LocalSource  │ │  OpenViking   │
   │  (agentA/)   │ │  (agentB/)   │ │  (HTTP API)   │
   │ _index.json  │ │ _index.json  │ │  L0/L1/L2     │
   └─────────────┘ └─────────────┘ └──────────────┘
```

### 存储结构

```
shared-context/entries/
├── agentA/
│   ├── _index.json          ← agentA 独占写入
│   └── agentA-*.json        ← 单条目文件（调试用）
├── agentB/
│   ├── _index.json          ← agentB 独占写入
│   └── agentB-*.json
└── ...
```

**核心原则：**

- **写隔离**：每个 Agent 只写自己的 `_index.json`
- **读合并**：`assemble()` 遍历所有目录，排除自身
- **原子写入**：`writeFileSync` → tmp → `renameSync` → 最终文件
- **弹性预算**：`sharedBudget = min(ratio × budget, (budget − used) × 0.8)`

---

## 安装

将插件放到 OpenClaw 的扩展目录下：

```bash
# 方式 A：直接 clone 到扩展目录
cd ~/.openclaw/extensions
git clone https://github.com/wujiaming88/context-shared-claw.git

# 方式 B：符号链接
ln -s /path/to/context-shared-claw ~/.openclaw/extensions/context-shared-claw
```

OpenClaw 使用 jiti 即时编译 TypeScript，无需构建步骤。

---

## 配置

在 OpenClaw 配置文件（`~/.openclaw/openclaw.json`）中添加插件配置：

```json
{
  "plugins": {
    "entries": {
      "context-shared-claw": {
        "enabled": true,
        "config": {
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
    },
    "slots": {
      "contextEngine": "context-shared-claw"
    }
  }
}
```

> **注意**：插件配置放在 `plugins.entries.<id>.config` 下，不是直接放在 `plugins` 下。`plugins.slots.contextEngine` 告诉 OpenClaw 使用此插件作为上下文引擎，替换默认的 `legacy` 引擎。
```

### 配置字段说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `agents` | `object` | `{}` | 每个 Agent 的共享配置 |
| `agents.*.shared` | `boolean` | `false` | 是否启用共享上下文 |
| `agents.*.sources` | `string[]` | `["local"]` | 上下文来源（按优先级排列） |
| `agents.*.writeTo` | `string` | 首个 source | 写入目标 |
| `localDir` | `string` | `~/.openclaw/shared-context` | 本地存储目录 |
| `openviking.host` | `string` | `http://localhost:1933` | OpenViking 服务地址 |
| `openviking.apiKey` | `string` | — | OpenViking API 密钥 |
| `openviking.timeout` | `number` | `5000` | 请求超时（毫秒） |
| `compareMode` | `boolean` | `false` | 对比模式：同时生成有/无共享上下文的对比数据 |
| `debugLevel` | `string` | `"basic"` | 日志级别：`off` / `basic` / `verbose` |
| `maxContextEntries` | `number` | `100` | 最大保留条目数 |
| `defaultTokenBudget` | `number` | `4000` | 默认 Token 预算 |
| `sharedBudgetRatio` | `number` | `0.3` | 共享上下文占总预算的最大比例（0–1） |
| `announceProtectTTL` | `number` | `86400000` | Announce 保护 TTL（毫秒） |

---

## 入池过滤规则

消息在写入共享池前会经过多级过滤，提高信噪比：

| 序号 | 规则 | 条件 | 行为 |
|:---:|------|------|------|
| 1 | 心跳过滤 | `isHeartbeat === true` | 跳过 |
| 2 | 空内容 | `content.trim() === ""` | 跳过 |
| 3 | Announce 过滤 | 包含 `[Internal task completion event]` 或相关元数据 | 跳过（由 Runtime 管理） |
| 4 | 短内容 | `content.length < 50` | 跳过 |
| 5 | 去重 | 与最近 5 条条目的 Dice 相似度 > 80% | 跳过 |
| 6 | 工具截断 | `role === "tool"` 且 token > 2000 | 截断至约 2000 token |

---

## 调试工具

插件注册了 `context_debug` 工具，支持以下子命令：

### `pool_size` — 共享池大小

```json
{ "command": "pool_size" }
// → { "local": 42, "openviking": 0 }
```

### `recent_logs` — 最近操作日志

```json
{ "command": "recent_logs", "limit": 10, "agentId": "waicode" }
```

### `stats` — 统计数据

```json
{ "command": "stats" }
{ "command": "stats", "agentId": "waicode" }
```

### `config` — 当前配置

```json
{ "command": "config" }
```

### `compare` — Token 对比

```json
{ "command": "compare", "limit": 5 }
```

### `evaluate` — 效果评估报告

```json
{ "command": "evaluate" }
```

详细报告格式见[效果评估](#效果评估)。

---

## 效果评估

使用 `evaluate` 命令生成完整的效果报告：

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
  共享上下文总注入 Token: 15,840
  占总预算比例: 2.54% (配置上限 30%)

跨 Agent 流向:
  waicode → main: 45 条被使用
  wairesearch → waicode: 23 条被使用
  main → wairesearch: 12 条被使用
```

### 指标说明

| 指标 | 说明 |
|------|------|
| **总条目** | 共享池中的所有条目数 |
| **有效条目** | Token > 50 的条目，过滤掉残留短条目 |
| **信噪比** | 有效条目占比，建议 >70% |
| **命中率** | assemble 时成功注入共享上下文的比例 |
| **Token 经济性** | 共享上下文实际消耗 vs 总预算 |
| **跨 Agent 流向** | 哪些 Agent 的上下文被哪些 Agent 使用 |

---

## CLI 命令行工具

插件自带 CLI，可直接在终端使用调试工具：

```bash
# 用 tsx 直接运行
npx tsx src/cli.ts <命令>

# 或全局安装
npm link
context-shared-claw <命令>
```

### 命令列表

```bash
context-shared-claw evaluate              # 效果评估报告
context-shared-claw stats                 # 统计数据
context-shared-claw stats --agent waicode # 指定 Agent 的统计
context-shared-claw pool-size             # 共享池大小
context-shared-claw recent-logs           # 最近操作日志
context-shared-claw recent-logs --limit 5 # 最近 5 条日志
context-shared-claw config                # 当前配置
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `CONTEXT_SHARED_CONFIG` | 自定义配置文件路径（覆盖自动检测） |

配置自动检测顺序：OpenClaw 插件目录 → shared-context 目录 → OpenClaw 主配置。

---

## 测试

测试使用 Node.js 内置 `node:test` 和 `node:assert` 模块，通过 tsx 运行：

```bash
# 安装开发依赖
npm install -D tsx

# 运行所有测试
npx tsx --test tests/*.test.ts
```

### 测试套件

| 文件 | 测试数 | 覆盖内容 |
|------|:-----:|---------|
| `ingest-filter.test.ts` | 7 | 短内容、空内容、正常消息、心跳、Announce、工具截断、去重 |
| `write-isolation.test.ts` | 4 | Agent 目录隔离、跨 Agent 读取、自身排除、快速写入 |
| `elastic-budget.test.ts` | 3 | 正常预算、预算紧张、预算耗尽 |
| `atomic-write.test.ts` | 2 | 文件可解析、无 .tmp 残留 |
| `evaluate.test.ts` | 2 | 报告格式、空池默认值 |
| `search.test.ts` | 6 | isSimilar (4) + searchEntries (2) |
| **合计** | **24** | |

---

## 许可

[MIT](./LICENSE)
