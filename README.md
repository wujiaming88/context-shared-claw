# context-shared-claw

Cross-agent shared context engine for [OpenClaw](https://github.com/openclaw/openclaw) — automatically share working context across multiple agents to improve team collaboration.

> **Turn 21 isolated AI agents into a connected knowledge network — at 0.23% cost overhead.**

> 📖 [中文文档 / Chinese Documentation](./README.zh-CN.md)

---

## Why

AI agents are islands. Each conversation is a silo. When you run multiple agents, they can't share knowledge with each other — like a team where no one communicates.

**context-shared-claw** solves this by creating a shared context layer that automatically flows knowledge between agents:

```
Before:  Agent A knows X  →  only Agent A knows X
After:   Agent A knows X  →  Agent B, C, D also get X (automatically)
```

### Real-World Results

| Metric | Value | Meaning |
|--------|-------|---------|
| Hit Rate | **54.2%** | Over half of conversations benefit from cross-agent knowledge |
| Budget Overhead | **0.23%** | Near-zero cost — doesn't crowd out main conversation context |
| Avg Injection | **1,042 tokens** | Enough to transfer key decisions, not enough to add noise |
| Active Agents | **23** | Broad coverage across all agent sessions |
| Cross-Agent Flows | **53** | Rich knowledge network forming between agents |
| Pool Size | **90 entries** | Growing collective memory |

> **Low cost (0.23% budget), high yield (54% hit rate), broad coverage (23 agents / 53 flows).**

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Configuration](#configuration)
- [Ingestion Filters](#ingestion-filters)
- [Debug Tools](#debug-tools)
- [Evaluation](#evaluation)
- [Risks & Mitigations](#risks--mitigations)
- [Roadmap](#roadmap)
- [Testing](#testing)
- [License](#license)

---

## Features

| Feature | Description |
|---------|-------------|
| **Wrapper Mode** | Wraps the legacy context engine — non-shared agents have zero interference |
| **afterTurn Writing** | Writes to shared pool after each turn (Runtime doesn't call `ingest` when `ownsCompaction=false`) |
| **Wildcard Config** | Use `"*"` to match all agents — no need to know agent IDs upfront |
| **Write Isolation** | Each agent writes only to its own directory — no contention |
| **Read Merge** | Assemble merges all agents' entries, excluding self |
| **Atomic Writes** | Write to temp file then rename — prevents partial-write corruption |
| **Elastic Budget** | Shared context budget dynamically adjusts based on used tokens |
| **Ingestion Filters** | Auto-filter system messages, short messages, heartbeats, announces, duplicates |
| **Multimodal Support** | Handles `AgentMessage.content` as string or `ContentPart[]` |
| **Tool Output Truncation** | Auto-truncate tool output exceeding 2000 tokens |
| **Compare Mode** | Generate with/without shared context comparison for token analysis |
| **OpenViking Support** | Optional OpenViking integration for semantic search & distributed sharing |

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                  SharedContextEngine (Wrapper Mode)            │
│                                                               │
│  Non-shared Agent → pass-through (100% legacy behavior)       │
│  Shared Agent     → pass-through + shared context injection   │
│                                                               │
│  afterTurn()         assemble()              compact()        │
│  ┌──────────┐        ┌──────────────┐        ┌─────────┐     │
│  │ Extract   │        │ Pass-through │        │ Runtime  │     │
│  │ new msgs  │──write─│ + inject     │──read──│ handles  │     │
│  │ to pool   │        │ shared ctx   │        │ + cleanup│     │
│  └──────────┘        └──────────────┘        └─────────┘     │
└───────────────────────────┬───────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
     ┌─────────────┐ ┌─────────────┐ ┌──────────────┐
     │ LocalSource  │ │ LocalSource  │ │  OpenViking   │
     │  (agentA/)   │ │  (agentB/)   │ │  (HTTP API)   │
     │ _index.json  │ │ _index.json  │ │  semantic DB   │
     └─────────────┘ └─────────────┘ └──────────────┘
```

### Hook Delegation

| Hook | Non-shared Agent | Shared Agent |
|------|-----------------|--------------|
| `bootstrap` | no-op | log session start |
| `ingest` | pass-through | pass-through (no-op, Runtime handles persistence) |
| `afterTurn` | no-op | **extract new messages → write to shared pool** |
| `assemble` | pass-through (return original messages) | pass-through + **inject shared context via `systemPromptAddition`** |
| `compact` | delegated to Runtime (`ownsCompaction=false`) | delegated to Runtime + cleanup shared pool |

### Storage Layout

```
~/.openclaw/shared-context/
├── entries/
│   ├── <agentId-1>/
│   │   └── _index.json      ← agent-1 exclusive write
│   ├── <agentId-2>/
│   │   └── _index.json      ← agent-2 exclusive write
│   └── ...
├── debug/
│   ├── 2026-03-10.jsonl     ← daily operation logs
│   └── ...
└── stats.json                ← cumulative statistics (persists across restarts)
```

---

## How It Works

### 1. Writing: afterTurn

After each conversation turn, the engine extracts new messages and writes them to the shared pool:

```
User sends message → LLM responds → afterTurn() fires
  → Extract messages after prePromptMessageCount
  → Filter: skip system, short (<50 chars), duplicates (>80% similar)
  → Only keep user & assistant messages
  → Write to agent's _index.json (atomic: tmp + rename)
```

### 2. Reading: assemble

When assembling context for a model call, the engine injects shared context from other agents:

```
assemble() called
  → Calculate elastic budget: min(ratio × budget, (budget − used) × 0.8)
  → Read all agents' _index.json (excluding self)
  → Select entries within budget
  → Return: original messages + systemPromptAddition with shared context
```

### 3. Why afterTurn instead of ingest?

When `ownsCompaction=false` (our case), the OpenClaw Runtime manages message persistence itself and **does not call `ingest()`**. It only calls `assemble()` for context building and `afterTurn()` for post-turn lifecycle. So we use `afterTurn` to populate the shared pool.

---

## Installation

```bash
cd ~/.openclaw/extensions
git clone https://github.com/wujiaming88/context-shared-claw.git
```

OpenClaw uses jiti for JIT TypeScript compilation — no build step needed.

---

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json5
{
  "plugins": {
    "entries": {
      "context-shared-claw": {
        "enabled": true,
        "config": {
          "agents": {
            // Use "*" to match all agents (recommended)
            // Session IDs are UUIDs, not agent names
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

> **Important**: Config goes under `plugins.entries.<id>.config` (accessed via `api.pluginConfig`, not `api.config`). The `plugins.slots.contextEngine` activates this as the global context engine.

### Configuration Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `agents` | `object` | `{}` | Per-agent sharing config. Use `"*"` as wildcard |
| `agents.*.shared` | `boolean` | `false` | Enable shared context for this agent |
| `agents.*.sources` | `string[]` | `["local"]` | Context sources in priority order |
| `agents.*.writeTo` | `string` | first source | Write destination |
| `localDir` | `string` | `~/.openclaw/shared-context` | Local storage directory |
| `openviking.host` | `string` | `http://localhost:1933` | OpenViking server URL |
| `openviking.apiKey` | `string` | — | OpenViking API key |
| `compareMode` | `boolean` | `false` | Log with/without shared context token comparison |
| `debugLevel` | `string` | `"basic"` | `off` / `basic` / `verbose` |
| `maxContextEntries` | `number` | `100` | Max entries per agent to keep |
| `defaultTokenBudget` | `number` | `4000` | Default token budget |
| `sharedBudgetRatio` | `number` | `0.3` | Max ratio of budget for shared context (0–1) |

---

## Ingestion Filters

Messages are filtered before entering the shared pool:

| # | Rule | Condition | Behavior |
|:-:|------|-----------|----------|
| 1 | System messages | `role === "system"` | Skip |
| 2 | Internal prompts | Contains "Session Startup sequence" | Skip |
| 3 | Announce | Contains `[Internal task completion event]` | Skip |
| 4 | Non-conversation | Role is not `user` or `assistant` | Skip |
| 5 | Short content | `content.length < 50` | Skip |
| 6 | Dedup | Dice similarity > 80% with recent 5 entries | Skip |
| 7 | Tool truncation | `role === "tool"` and tokens > 2000 | Truncate to ~2000 tokens |

---

## Debug Tools

The plugin registers a `context_debug` agent tool:

```json
{ "command": "stats" }              // Global or per-agent statistics
{ "command": "pool_size" }          // Pool entry counts
{ "command": "recent_logs" }        // Recent operation logs
{ "command": "evaluate" }           // Full evaluation report
{ "command": "compare" }            // Token comparison data
{ "command": "config" }             // Current configuration
```

### CLI

```bash
npx tsx src/cli.ts evaluate
npx tsx src/cli.ts stats
npx tsx src/cli.ts pool-size
```

---

## Evaluation

### Quick Check

```bash
cat ~/.openclaw/shared-context/stats.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
total = d['assembleHits'] + d['assembleMisses']
hits = d['assembleHits']
print(f'Hit Rate: {hits}/{total} = {hits/total*100:.1f}%' if total else 'No data')
print(f'Tokens Injected: {d[\"totalSharedTokensInjected\"]}')
print(f'Budget Overhead: {d[\"totalSharedTokensInjected\"]/d[\"totalBudgetUsed\"]*100:.2f}%' if d['totalBudgetUsed'] else 'N/A')
print(f'Avg per Hit: {d[\"totalSharedTokensInjected\"]/hits:.0f} tokens' if hits else 'N/A')
print(f'Active Agents: {len(d[\"agents\"])}')
print(f'Pool Entries: {sum(p[\"count\"] for p in d[\"poolByAgent\"].values())}')
print(f'Cross-Agent Flows: {sum(len(t) for t in d[\"crossAgentFlow\"].values())}')
"
```

### Metrics

| Metric | Description | Target |
|--------|-------------|--------|
| **Hit Rate** | % of assemble calls that injected shared context | >30% |
| **Budget Overhead** | Shared tokens as % of total budget | <5% |
| **Avg per Hit** | Tokens injected per successful hit | <2,000 |
| **Cross-Agent Flows** | Number of distinct agent→agent knowledge paths | Growing |

### Compare Mode Logs

When `compareMode: true`, each assemble logs a comparison:

```json
{
  "tokensWithShared": 995,
  "tokensWithoutShared": 253,
  "tokenDifference": 742,
  "percentageIncrease": "293.3"
}
```

Full evaluation plan: [docs/evaluation-plan.md](./docs/evaluation-plan.md)

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Privacy leakage** | 🔴 High | Filter sensitive content before pool; use per-agent source config |
| **Error propagation** | 🔴 High | Agent A's mistakes spread to all agents via shared pool |
| **Noise injection** | 🟡 Medium | Ingestion filters + future semantic search (OpenViking) |
| **Context confusion** | 🟡 Medium | Shared context clearly marked with `=== Shared Context ===` delimiters |
| **Storage growth** | 🟢 Low | `maxContextEntries` cap + cleanup in afterTurn/compact |
| **Latency** | 🟢 Low | Currently <1ms (local file I/O) |

---

## Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| Local source | ✅ Done | File-based shared pool, time-ordered retrieval |
| Wrapper mode | ✅ Done | Non-shared agents unaffected, zero regression |
| Evaluation framework | ✅ Done | Stats, compare mode, evaluation reports |
| OpenViking integration | 🔜 Next | Semantic vector search, distributed storage, multi-machine |
| Privacy filters | 📋 Planned | Auto-detect and redact sensitive content |
| Semantic dedup | 📋 Planned | Vector-based dedup replacing bigram similarity |

---

## Testing

```bash
npm install -D tsx
npx tsx --test tests/*.test.ts
```

| File | Tests | Coverage |
|------|:-----:|----------|
| `ingest-filter.test.ts` | 7 | Short, empty, normal, heartbeat, announce, tool truncation, dedup |
| `write-isolation.test.ts` | 4 | Directory isolation, cross-agent read, self-exclusion, rapid writes |
| `elastic-budget.test.ts` | 3 | Normal, tight, exhausted budget |
| `atomic-write.test.ts` | 2 | File parseable, no .tmp residue |
| `evaluate.test.ts` | 2 | Report format, empty pool |
| `search.test.ts` | 6 | isSimilar (4) + searchEntries (2) |
| **Total** | **24** | |

---

## License

[MIT](./LICENSE)
