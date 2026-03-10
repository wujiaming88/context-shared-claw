# context-shared-claw

跨 Agent 共享上下文引擎 —— 让多个 [OpenClaw](https://github.com/openclaw/openclaw) Agent 自动共享工作上下文，提升团队协作质量。

> **让 21 个孤立的 AI Agent 变成互联的知识网络 —— 仅 0.23% 的成本开销。**

> 📖 [English Documentation](./README.md)

---

## 为什么需要

AI Agent 都是孤岛。每个会话都是独立的。当你运行多个 Agent 时，它们无法共享知识 —— 就像一个团队里没人交流。

**context-shared-claw** 通过创建共享上下文层，让知识在 Agent 之间自动流动：

```
之前:  Agent A 知道 X  →  只有 Agent A 知道 X
之后:  Agent A 知道 X  →  Agent B、C、D 也自动获得 X
```

### 实测数据

| 指标 | 值 | 含义 |
|------|-----|------|
| 命中率 | **54.2%** | 超过一半的对话受益于跨 Agent 知识 |
| 占预算比 | **0.23%** | 几乎零成本，不挤占主对话空间 |
| 每次命中 | **1,042 tokens** | 足够传递关键决策，不会过度注入噪声 |
| 活跃 Agent | **23** | 广泛覆盖所有 Agent 会话 |
| 跨 Agent 流向 | **53** | Agent 间形成丰富的知识网络 |
| 共享池条目 | **90** | 持续增长的集体记忆 |

> **低成本（0.23% 预算），高收益（54% 命中），广覆盖（23 Agent / 53 流向）。**

---

## 目录

- [功能特性](#功能特性)
- [架构](#架构)
- [工作原理](#工作原理)
- [安装](#安装)
- [配置](#配置)
- [入池过滤规则](#入池过滤规则)
- [调试工具](#调试工具)
- [效果评估](#效果评估)
- [风险与应对](#风险与应对)
- [路线图](#路线图)
- [测试](#测试)
- [许可](#许可)

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **包装模式** | 包装 legacy 引擎 —— 非共享 Agent 完全不受影响 |
| **afterTurn 写入** | 每轮对话结束后写入共享池（`ownsCompaction=false` 时 Runtime 不调用 `ingest`） |
| **通配符配置** | 用 `"*"` 匹配所有 Agent，无需预知 Agent ID |
| **写隔离** | 每个 Agent 只写自己的目录，无写冲突 |
| **读合并** | assemble 时合并所有 Agent 的条目（排除自身） |
| **原子写入** | 先写临时文件再 rename，不会出现半写损坏 |
| **弹性预算** | 共享上下文根据已用 Token 自动伸缩预算 |
| **入池过滤** | 系统消息、短消息、心跳、Announce、重复内容自动过滤 |
| **多模态支持** | 兼容 `AgentMessage.content` 为字符串或 `ContentPart[]` |
| **工具输出截断** | role=tool 且超 2000 token 时自动截断 |
| **对比模式** | 同时生成有/无共享上下文的对比数据，量化收益 |
| **OpenViking 支持** | 可选对接 OpenViking，实现语义搜索和分布式共享 |

---

## 架构

```
┌───────────────────────────────────────────────────────────────┐
│                SharedContextEngine（包装模式）                   │
│                                                               │
│  非共享 Agent → 透传（100% legacy 行为）                        │
│  共享 Agent   → 透传 + 注入共享上下文                            │
│                                                               │
│  afterTurn()         assemble()              compact()        │
│  ┌──────────┐        ┌──────────────┐        ┌─────────┐     │
│  │ 提取本轮  │        │ 透传原始消息  │        │ Runtime  │     │
│  │ 新消息    │──写入──│ + 注入共享    │──读取──│ 负责压缩  │     │
│  │ 到共享池  │        │ 上下文       │        │ + 清理   │     │
│  └──────────┘        └──────────────┘        └─────────┘     │
└───────────────────────────┬───────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
     ┌─────────────┐ ┌─────────────┐ ┌──────────────┐
     │ LocalSource  │ │ LocalSource  │ │  OpenViking   │
     │  (agentA/)   │ │  (agentB/)   │ │  (HTTP API)   │
     │ _index.json  │ │ _index.json  │ │   语义数据库   │
     └─────────────┘ └─────────────┘ └──────────────┘
```

### 钩子委托链

| 钩子 | 非共享 Agent | 共享 Agent |
|------|-------------|-----------|
| `bootstrap` | no-op | 记录会话启动 |
| `ingest` | 透传 | 透传（no-op，Runtime 处理持久化） |
| `afterTurn` | no-op | **提取新消息 → 写入共享池** |
| `assemble` | 透传（返回原始消息） | 透传 + **通过 `systemPromptAddition` 注入共享上下文** |
| `compact` | 委托 Runtime（`ownsCompaction=false`） | 委托 Runtime + 清理共享池 |

### 存储结构

```
~/.openclaw/shared-context/
├── entries/
│   ├── <agentId-1>/
│   │   └── _index.json      ← agent-1 独占写入
│   ├── <agentId-2>/
│   │   └── _index.json      ← agent-2 独占写入
│   └── ...
├── debug/
│   ├── 2026-03-10.jsonl     ← 每日操作日志
│   └── ...
└── stats.json                ← 累计统计（跨重启保留）
```

---

## 工作原理

### 1. 写入：afterTurn

每轮对话结束后，引擎提取新增消息写入共享池：

```
用户发消息 → LLM 回复 → afterTurn() 触发
  → 提取 prePromptMessageCount 之后的新消息
  → 过滤：跳过系统消息、短内容(<50字)、重复(>80%相似)
  → 只保留 user 和 assistant 角色
  → 原子写入 agent 的 _index.json（tmp + rename）
```

### 2. 读取：assemble

组装模型上下文时，注入其他 Agent 的共享上下文：

```
assemble() 被调用
  → 计算弹性预算：min(ratio × budget, (budget − used) × 0.8)
  → 读取所有 agent 的 _index.json（排除自身）
  → 在预算内选择条目
  → 返回：原始消息 + systemPromptAddition（包含共享上下文）
```

### 3. 为什么用 afterTurn 而不是 ingest？

当 `ownsCompaction=false` 时，OpenClaw Runtime 自己管理消息持久化，**不会调用 `ingest()`**。它只调用 `assemble()` 组装上下文和 `afterTurn()` 处理轮次结束。所以我们在 `afterTurn` 中填充共享池。

---

## 安装

```bash
cd ~/.openclaw/extensions
git clone https://github.com/wujiaming88/context-shared-claw.git
```

OpenClaw 使用 jiti 即时编译 TypeScript，无需构建步骤。

---

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json5
{
  "plugins": {
    "entries": {
      "context-shared-claw": {
        "enabled": true,
        "config": {
          "agents": {
            // 用 "*" 匹配所有 Agent（推荐）
            // Session ID 是 UUID，不是 Agent 名称
            "*": {
              "shared": true,
              "sources": ["local"]
            }
          },
          "compareMode": true,
          "debugLevel": "verbose"
        }
      }
    },
    "slots": {
      "contextEngine": "context-shared-claw"
    }
  }
}
```

> **注意**：配置在 `plugins.entries.<id>.config` 下（通过 `api.pluginConfig` 获取，不是 `api.config`）。`plugins.slots.contextEngine` 激活此插件为全局上下文引擎。

### 配置字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `agents` | `object` | `{}` | Agent 共享配置，支持 `"*"` 通配符 |
| `agents.*.shared` | `boolean` | `false` | 是否启用共享上下文 |
| `agents.*.sources` | `string[]` | `["local"]` | 上下文来源（按优先级排列） |
| `agents.*.writeTo` | `string` | 首个 source | 写入目标 |
| `localDir` | `string` | `~/.openclaw/shared-context` | 本地存储目录 |
| `openviking.host` | `string` | `http://localhost:1933` | OpenViking 服务地址 |
| `openviking.apiKey` | `string` | — | OpenViking API 密钥 |
| `compareMode` | `boolean` | `false` | 对比模式：记录有/无共享上下文的 Token 对比 |
| `debugLevel` | `string` | `"basic"` | 日志级别：`off` / `basic` / `verbose` |
| `maxContextEntries` | `number` | `100` | 每个 Agent 最大保留条目数 |
| `defaultTokenBudget` | `number` | `4000` | 默认 Token 预算 |
| `sharedBudgetRatio` | `number` | `0.3` | 共享上下文占总预算的最大比例（0–1） |

---

## 入池过滤规则

消息在写入共享池前经过多级过滤：

| 序号 | 规则 | 条件 | 行为 |
|:---:|------|------|------|
| 1 | 系统消息 | `role === "system"` | 跳过 |
| 2 | 内部提示 | 包含 "Session Startup sequence" | 跳过 |
| 3 | Announce | 包含 `[Internal task completion event]` | 跳过 |
| 4 | 非对话消息 | role 不是 `user` 或 `assistant` | 跳过 |
| 5 | 短内容 | `content.length < 50` | 跳过 |
| 6 | 去重 | 与最近 5 条的 Dice 相似度 > 80% | 跳过 |
| 7 | 工具截断 | `role === "tool"` 且 token > 2000 | 截断至约 2000 token |

---

## 调试工具

插件注册了 `context_debug` 工具：

```json
{ "command": "stats" }              // 全局或按 Agent 的统计
{ "command": "pool_size" }          // 共享池条目数
{ "command": "recent_logs" }        // 最近操作日志
{ "command": "evaluate" }           // 完整效果评估报告
{ "command": "compare" }            // Token 对比数据
{ "command": "config" }             // 当前配置
```

### CLI 命令行

```bash
npx tsx src/cli.ts evaluate
npx tsx src/cli.ts stats
npx tsx src/cli.ts pool-size
```

---

## 效果评估

### 快速检查

```bash
cat ~/.openclaw/shared-context/stats.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
total = d['assembleHits'] + d['assembleMisses']
hits = d['assembleHits']
print(f'命中率: {hits}/{total} = {hits/total*100:.1f}%' if total else '无数据')
print(f'注入 Token: {d[\"totalSharedTokensInjected\"]}')
print(f'占预算比: {d[\"totalSharedTokensInjected\"]/d[\"totalBudgetUsed\"]*100:.2f}%' if d['totalBudgetUsed'] else 'N/A')
print(f'每次命中: {d[\"totalSharedTokensInjected\"]/hits:.0f} tokens' if hits else 'N/A')
print(f'活跃 Agent: {len(d[\"agents\"])}')
print(f'共享池: {sum(p[\"count\"] for p in d[\"poolByAgent\"].values())} 条')
print(f'跨 Agent 流向: {sum(len(t) for t in d[\"crossAgentFlow\"].values())} 条')
"
```

### 指标说明

| 指标 | 说明 | 目标 |
|------|------|------|
| **命中率** | assemble 时成功注入共享上下文的比例 | >30% |
| **占预算比** | 共享 Token 占总预算的百分比 | <5% |
| **每次命中** | 每次成功注入的平均 Token 数 | <2,000 |
| **跨 Agent 流向** | Agent→Agent 知识传递路径数 | 持续增长 |

### 对比模式日志

当 `compareMode: true` 时，每次 assemble 记录对比数据：

```json
{
  "tokensWithShared": 995,
  "tokensWithoutShared": 253,
  "tokenDifference": 742,
  "percentageIncrease": "293.3"
}
```

> 293% 的上下文增长 = 一个新 Agent 瞬间获得了其他 Agent 积累的知识。

完整评估方案：[docs/evaluation-plan.md](./docs/evaluation-plan.md)

---

## 风险与应对

| 风险 | 严重程度 | 应对措施 |
|------|---------|---------|
| **隐私泄露** | 🔴 高 | 入池前过滤敏感内容；使用 Agent 级 source 配置 |
| **错误传播** | 🔴 高 | Agent A 的错误信息可能通过共享池传播给所有 Agent |
| **噪声注入** | 🟡 中 | 入池过滤 + 未来语义搜索（OpenViking）可大幅改善 |
| **上下文混淆** | 🟡 中 | 共享内容用 `=== Shared Context ===` 明确标记 |
| **存储膨胀** | 🟢 低 | `maxContextEntries` 上限 + afterTurn/compact 清理 |
| **延迟** | 🟢 低 | 当前 <1ms（本地文件 I/O） |

---

## 路线图

| 阶段 | 状态 | 说明 |
|------|------|------|
| Local source | ✅ 完成 | 文件共享池，时间排序检索 |
| 包装模式 | ✅ 完成 | 非共享 Agent 零影响 |
| 评估框架 | ✅ 完成 | 统计、对比模式、评估报告 |
| OpenViking 集成 | 🔜 下一步 | 语义向量搜索 + 分布式存储 + 多机共享 |
| 隐私过滤 | 📋 计划 | 自动检测和脱敏敏感内容 |
| 语义去重 | 📋 计划 | 向量去重替代 bigram 相似度 |

---

## 测试

```bash
npm install -D tsx
npx tsx --test tests/*.test.ts
```

| 文件 | 测试数 | 覆盖内容 |
|------|:-----:|---------|
| `ingest-filter.test.ts` | 7 | 短内容、空内容、正常消息、心跳、Announce、工具截断、去重 |
| `write-isolation.test.ts` | 4 | 目录隔离、跨 Agent 读取、自身排除、快速写入 |
| `elastic-budget.test.ts` | 3 | 正常预算、预算紧张、预算耗尽 |
| `atomic-write.test.ts` | 2 | 文件可解析、无 .tmp 残留 |
| `evaluate.test.ts` | 2 | 报告格式、空池默认值 |
| `search.test.ts` | 6 | isSimilar (4) + searchEntries (2) |
| **合计** | **24** | |

---

## 许可

[MIT](./LICENSE)
