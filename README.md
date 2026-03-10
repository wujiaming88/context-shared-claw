# context-shared-claw

> OpenClaw 跨 Agent 共享上下文引擎插件

## 功能概述

`context-shared-claw` 是一个 OpenClaw Context Engine 插件，实现跨 Agent 的上下文共享。核心功能：

1. **按 Agent 可配置** — 每个 Agent 独立控制是否启用共享上下文
2. **多数据源支持** — 本地文件存储 + OpenViking 远程服务
3. **读写分离** — 可配置从多源读取，写入指定源
4. **强大的调试能力** — 详细日志、统计指标、对比模式

## 安装

将本插件目录放置在 OpenClaw 插件路径下，或在 OpenClaw 配置中指定插件路径。

## 配置

在 OpenClaw 配置中添加插件配置：

```json
{
  "plugins": {
    "context-shared-claw": {
      "agents": {
        "main": {
          "shared": true,
          "sources": ["local", "openviking"],
          "writeTo": "local"
        },
        "waicode": {
          "shared": true,
          "sources": ["local"]
        },
        "waidesign": {
          "shared": false
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
      "defaultTokenBudget": 4000
    }
  }
}
```

### 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `agents` | object | `{}` | 每个 Agent 的共享配置 |
| `agents.*.shared` | boolean | `false` | 是否启用共享上下文 |
| `agents.*.sources` | string[] | `["local"]` | 上下文来源（按优先级排列） |
| `agents.*.writeTo` | string | 首个 source | 写入目标 |
| `localDir` | string | `~/.openclaw/shared-context` | 本地存储目录 |
| `openviking.host` | string | `http://localhost:1933` | OpenViking 服务器地址 |
| `openviking.apiKey` | string | - | OpenViking API 密钥 |
| `openviking.timeout` | number | `5000` | 请求超时（ms） |
| `compareMode` | boolean | `false` | 对比模式 |
| `debugLevel` | string | `"basic"` | 调试级别：`off` / `basic` / `verbose` |
| `maxContextEntries` | number | `100` | 最大上下文条目数 |
| `defaultTokenBudget` | number | `4000` | 默认 token 预算 |

## 数据源

### 本地文件模式（Local）

- 存储位置：`~/.openclaw/shared-context/entries/`
- 格式：JSON 文件
- 按 Agent 分目录存储
- 支持关键词搜索（MVP 阶段）

### OpenViking 模式

- 通过 HTTP API 与 OpenViking Server（端口 1933）交互
- 支持 L0/L1/L2 三级上下文加载：
  - **L0**：核心上下文（始终加载）
  - **L1**：相关上下文（按需加载）
  - **L2**：扩展上下文（搜索加载）

## 调试工具

插件注册了 `context_debug` Agent 工具，可在对话中直接调用：

### 命令

| 命令 | 说明 |
|------|------|
| `pool_size` | 查看共享上下文池大小 |
| `recent_logs` | 查看最近的操作日志 |
| `stats` | 查看各 Agent 的统计数据 |
| `config` | 查看当前配置 |
| `compare` | 查看 Token 消耗对比数据 |

### 使用示例

```
// Agent 可以这样调用：
context_debug({ command: "stats" })
context_debug({ command: "recent_logs", limit: 10, agentId: "waicode" })
context_debug({ command: "pool_size" })
```

## 调试日志

- 日志目录：`~/.openclaw/shared-context/debug/`
- 格式：每日 JSONL 文件（如 `2024-01-15.jsonl`）
- 内容：时间戳、Agent ID、Session ID、操作类型、Token 消耗、上下文选择详情

## 统计指标

- 统计文件：`~/.openclaw/shared-context/stats.json`
- 包含：
  - 每个 Agent 的 assemble/ingest/compact 次数
  - Token 消耗统计
  - 共享上下文命中率
  - 压缩前后 Token 对比

## 对比模式

开启 `compareMode: true` 后：
- 每次 assemble 同时计算「有共享上下文」和「无共享上下文」的 token 消耗
- 差异记录到调试日志
- 可通过 `context_debug({ command: "compare" })` 查看对比数据
- 方便评估共享上下文的效果

## 工作原理

```
┌──────────────┐     ingest      ┌────────────────────┐
│   Agent A    │ ──────────────> │                    │
│  (waicode)   │                 │   Shared Context   │
│              │ <────────────── │      Pool          │
└──────────────┘    assemble     │                    │
                                 │  ┌──────┐ ┌─────┐ │
┌──────────────┐     ingest      │  │Local │ │ OV  │ │
│   Agent B    │ ──────────────> │  │Files │ │ API │ │
│   (main)     │                 │  └──────┘ └─────┘ │
│              │ <────────────── │                    │
└──────────────┘    assemble     └────────────────────┘
```

1. **ingest**：Agent 的消息被写入共享上下文池（写入配置的目标源）
2. **assemble**：从共享池中检索其他 Agent 的相关上下文，注入到当前 Agent 的消息流
3. **compact**：定期清理过期条目，控制存储大小和 token 消耗

## 技术说明

- TypeScript，OpenClaw 使用 jiti 即时编译
- 仅使用 Node.js 内置模块（`fs`、`path`、`http`、`https`、`crypto`）
- Token 估算：英文 ~4 chars/token，CJK ~2 chars/token

## 许可证

MIT
