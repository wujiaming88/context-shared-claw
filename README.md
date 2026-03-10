# context-shared-claw

Cross-agent shared context engine for [OpenClaw](https://github.com/openclaw/openclaw) — automatically share working context across multiple agents to improve team collaboration.

> 📖 [中文文档 / Chinese Documentation](./README.zh-CN.md)

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Ingestion Filters](#ingestion-filters)
- [Debug Tools](#debug-tools)
- [Evaluation](#evaluation)
- [Testing](#testing)
- [License](#license)

---

## Features

| Feature | Description |
|---------|-------------|
| **Write Isolation** | Each agent writes only to its own directory — no contention |
| **Read Merge** | Assemble merges all agents' entries, excluding self |
| **Atomic Writes** | Write to temp file then rename — prevents partial-write corruption |
| **Elastic Budget** | Shared context budget dynamically adjusts based on used tokens |
| **Ingestion Filters** | Auto-filter short messages, heartbeats, announces, duplicates |
| **Tool Output Truncation** | Auto-truncate tool output exceeding 2000 tokens |
| **Keyword Search** | Bigram-based keyword matching with relevance ranking |
| **Evaluation Report** | Pool health, hit rate, token economics, cross-agent flow |
| **OpenViking Support** | Optional OpenViking server integration for distributed sharing |
| **Compare Mode** | Generate both with/without shared context to compare token usage |

---

## Architecture

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
```

### Storage Layout

```
shared-context/entries/
├── agentA/
│   ├── _index.json          ← agentA exclusive write
│   └── agentA-*.json        ← individual entry files (debug)
├── agentB/
│   ├── _index.json          ← agentB exclusive write
│   └── agentB-*.json
└── ...
```

**Key principles:**

- **Write Isolation**: Each agent only writes to its own `_index.json`
- **Read Merge**: `assemble()` iterates all directories, excluding self
- **Atomic Write**: `writeFileSync` → tmp → `renameSync` → final
- **Elastic Budget**: `sharedBudget = min(ratio × budget, (budget − used) × 0.8)`

---

## Installation

Place the plugin directory under OpenClaw's plugins path:

```bash
# Clone the repo
git clone https://github.com/wujiaming88/context-shared-claw.git

# Move to OpenClaw plugins directory
mv context-shared-claw ~/.openclaw/plugins/context-shared-claw

# Or use a symlink
ln -s /path/to/context-shared-claw ~/.openclaw/plugins/context-shared-claw
```

OpenClaw uses jiti for JIT TypeScript compilation — no build step needed.

---

## Configuration

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

### Configuration Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `agents` | `object` | `{}` | Per-agent sharing config |
| `agents.*.shared` | `boolean` | `false` | Enable shared context for this agent |
| `agents.*.sources` | `string[]` | `["local"]` | Context sources in priority order |
| `agents.*.writeTo` | `string` | first source | Write destination |
| `localDir` | `string` | `~/.openclaw/shared-context` | Local storage directory |
| `openviking.host` | `string` | `http://localhost:1933` | OpenViking server URL |
| `openviking.apiKey` | `string` | — | OpenViking API key |
| `openviking.timeout` | `number` | `5000` | Request timeout (ms) |
| `compareMode` | `boolean` | `false` | Enable compare mode (with/without shared context) |
| `debugLevel` | `string` | `"basic"` | Log level: `off` / `basic` / `verbose` |
| `maxContextEntries` | `number` | `100` | Max entries to keep |
| `defaultTokenBudget` | `number` | `4000` | Default token budget |
| `sharedBudgetRatio` | `number` | `0.3` | Max ratio of budget for shared context (0–1) |
| `announceProtectTTL` | `number` | `86400000` | Announce protection TTL (ms) |

---

## Ingestion Filters

Messages are filtered before entering the shared pool to improve signal-to-noise ratio:

| # | Rule | Condition | Behavior |
|:-:|------|-----------|----------|
| 1 | Heartbeat | `isHeartbeat === true` | Skip |
| 2 | Empty content | `content.trim() === ""` | Skip |
| 3 | Announce | Contains `[Internal task completion event]` or related metadata | Skip (managed by Runtime) |
| 4 | Short content | `content.length < 50` | Skip |
| 5 | Dedup | Dice similarity > 80% with recent 5 entries | Skip |
| 6 | Tool truncation | `role === "tool"` and tokens > 2000 | Truncate to ~2000 tokens |

---

## Debug Tools

The plugin registers a `context_debug` agent tool with these subcommands:

### `pool_size` — Pool Size

```json
{ "command": "pool_size" }
// → { "local": 42, "openviking": 0 }
```

### `recent_logs` — Recent Operation Logs

```json
{ "command": "recent_logs", "limit": 10, "agentId": "waicode" }
```

### `stats` — Statistics

```json
{ "command": "stats" }
{ "command": "stats", "agentId": "waicode" }
```

### `config` — Current Configuration

```json
{ "command": "config" }
```

### `compare` — Token Comparison

```json
{ "command": "compare", "limit": 5 }
```

### `evaluate` — Evaluation Report

```json
{ "command": "evaluate" }
```

See [Evaluation](#evaluation) for report details.

---

## Evaluation

Use the `evaluate` command to generate a full effectiveness report:

```
📊 Shared Context Evaluation Report
─────────────────────────────────────

Pool Health:
  Total entries: 42 | Effective (>50tok): 38 (90.5%)
  Average entry size: 120 tok
  SNR score: 90.5% (recommended >70%)

Usage:
  Total assemble calls: 156
  Hits (shared context injected): 132 (84.6%)
  Misses: 24 (15.4%)

Token Economics:
  Total shared tokens injected: 15,840
  Budget utilization: 2.54% (configured max: 30%)

Cross-Agent Flow:
  waicode → main: 45 entries used
  wairesearch → waicode: 23 entries used
  main → wairesearch: 12 entries used
```

### Metrics

| Metric | Description |
|--------|-------------|
| **Total Entries** | All entries in the shared pool |
| **Effective Entries** | Entries with >50 tokens, filtering out residual short entries |
| **SNR Score** | Effective entry ratio — recommended >70% |
| **Hit Rate** | Rate of successful shared context injection during assemble |
| **Token Economics** | Actual shared token usage vs total budget |
| **Cross-Agent Flow** | Which agents' context is consumed by which agents |

---

## Testing

Tests use Node.js built-in `node:test` and `node:assert`, run via tsx:

```bash
# Install dev dependencies
npm install -D tsx

# Run all tests
npx tsx --test tests/*.test.ts
```

### Test Suites

| File | Tests | Coverage |
|------|:-----:|----------|
| `ingest-filter.test.ts` | 7 | Short content, empty, normal, heartbeat, announce, tool truncation, dedup |
| `write-isolation.test.ts` | 4 | Agent directory isolation, cross-agent read, self-exclusion, rapid writes |
| `elastic-budget.test.ts` | 3 | Normal budget, tight budget, exhausted budget |
| `atomic-write.test.ts` | 2 | File parseable, no .tmp residue |
| `evaluate.test.ts` | 2 | Report format, empty pool defaults |
| `search.test.ts` | 6 | isSimilar (4) + searchEntries (2) |
| **Total** | **24** | |

---

## License

[MIT](./LICENSE)
