# context-shared-claw 效果评估方案

## 一、评估目标

验证跨 Agent 共享上下文引擎是否有效提升多 Agent 协作的信息连贯性和任务效率。

---

## 二、评估维度

### 维度 1：信息传递率（Information Transfer Rate）

**定义**: 当 Agent A 产生了某个信息后，Agent B 是否能获取并利用该信息。

**指标**:
- `assembleHits / (assembleHits + assembleMisses)` = 命中率
- `crossAgentFlow` = 跨 Agent 信息流向和数量
- `totalSharedTokensInjected` = 总注入 Token 量

**获取方式**:
```bash
cat ~/.openclaw/shared-context/stats.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
total = d['assembleHits'] + d['assembleMisses']
print(f'=== 信息传递率 ===')
print(f'命中率: {d[\"assembleHits\"]}/{total} = {d[\"assembleHits\"]/total*100:.1f}%' if total else '无数据')
print(f'总注入 Token: {d[\"totalSharedTokensInjected\"]}')
print(f'跨 Agent 流向:')
for src, targets in d.get('crossAgentFlow', {}).items():
    for tgt, cnt in targets.items():
        print(f'  {src[:8]}... → {tgt[:8]}...: {cnt} 条')
"
```

**目标**: 命中率 > 30%（多 Agent 活跃场景下）

---

### 维度 2：上下文连贯性（Context Coherence）— A/B 对比

**方法**: 设计对话场景，对比开启/关闭共享上下文时 Agent 的回答质量。

**测试场景 1: 项目知识传递**

```
Phase 1 — Agent A（飞书 Agent）:
  用户: "我们决定用 Next.js 重构博客，目标是 3 月底完成第一版"
  用户: "技术栈确定为 Next.js + Tailwind + MDX"
  用户: "部署目标是 Vercel"
  → Agent A 回复并记录这些决策

Phase 2 — Agent B（另一个 Agent/会话）:
  用户: "博客重构用什么技术栈？"

对比:
  ❌ 无共享: Agent B 无法回答（没有这个信息）
  ✅ 有共享: Agent B 应回答 "Next.js + Tailwind + MDX，部署到 Vercel"
```

**测试场景 2: 任务上下文传递**

```
Phase 1 — Agent A:
  用户: "帮我调研 Cloudflare Workers 和 Vercel Edge Functions 的区别"
  Agent A: [产生调研结果]

Phase 2 — Agent B:
  用户: "之前调研的边缘计算方案，结论是什么？"

对比:
  ❌ 无共享: Agent B 不知道有过调研
  ✅ 有共享: Agent B 能引用 Agent A 的调研结论
```

**测试场景 3: 多 Agent 协作开发**

```
Phase 1 — 研究员 Agent:
  用户: "调研 OAuth 2.0 最佳实践"
  Agent: [产出调研报告]

Phase 2 — 开发者 Agent:
  用户: "实现用户登录功能"

对比:
  ❌ 无共享: 开发者从零开始，不知道已有调研
  ✅ 有共享: 开发者能参考研究员的 OAuth 调研结果
```

**评分标准**:

| 分数 | 说明 |
|------|------|
| 0 | Agent B 完全不知道 Agent A 的信息 |
| 1 | Agent B 模糊提到相关内容，但不准确 |
| 2 | Agent B 准确引用了 Agent A 的关键信息 |
| 3 | Agent B 不仅引用，还基于共享信息做了延伸 |

---

### 维度 3：Token 经济性（Token Economics）

**定义**: 共享上下文注入的 Token 开销是否合理。

**指标**:
- 共享 Token 占总预算比: `totalSharedTokensInjected / totalBudgetUsed`
- 每次命中的平均注入 Token: `totalSharedTokensInjected / assembleHits`
- 共享池大小: `poolByAgent` 各 Agent 条目数和 Token 量

**获取方式**:
```bash
cat ~/.openclaw/shared-context/stats.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
hits = d['assembleHits']
print(f'=== Token 经济性 ===')
print(f'共享占总预算: {d[\"totalSharedTokensInjected\"]/d[\"totalBudgetUsed\"]*100:.2f}%' if d['totalBudgetUsed'] else 'N/A')
print(f'每次命中平均注入: {d[\"totalSharedTokensInjected\"]/hits:.0f} tokens' if hits else 'N/A')
print(f'共享池:')
for agent, pool in d.get('poolByAgent', {}).items():
    print(f'  {agent[:8]}...: {pool[\"count\"]} 条, {pool[\"totalTokens\"]} tokens')
"
```

**目标**:
- 共享占预算 < 5%（不影响主对话质量）
- 每次命中 < 2000 tokens（不过度注入）

---

### 维度 4：信噪比（Signal-to-Noise Ratio）

**定义**: 注入的共享上下文中，有多少是对当前对话真正有用的。

**方法**: 抽样检查 assemble 注入的内容。

```bash
# 查看最近的 assemble 详情
cat ~/.openclaw/shared-context/debug/2026-03-10.jsonl | python3 -c "
import sys, json
for line in sys.stdin:
    e = json.loads(line.strip())
    if e.get('operation') == 'assemble' and e.get('selectedContextCount', 0) > 0:
        print(f'--- {e[\"timestamp\"]} ---')
        print(f'Agent: {e[\"agentId\"][:8]}...')
        print(f'注入 {e[\"selectedContextCount\"]} 条, {e.get(\"tokensUsed\", 0)} tokens')
        print(f'详情: {json.dumps(e.get(\"details\", {}), indent=2, ensure_ascii=False)[:500]}')
        print()
" | head -50
```

**人工评估**: 随机抽取 5 次 assemble 注入，判断注入内容是否相关。

| 分数 | 说明 |
|------|------|
| 0 | 完全不相关（噪声） |
| 1 | 部分相关（有信号也有噪声） |
| 2 | 高度相关（大部分有用） |

**目标**: 平均分 > 1.0

---

## 三、执行流程

### Step 1: 基线收集（5 分钟）

```bash
# 记录当前统计作为基线
cp ~/.openclaw/shared-context/stats.json ~/eval-baseline.json
```

### Step 2: A/B 对比测试（15 分钟）

**Test A — 关闭共享（基线）**:
1. 配置 `"*": { "shared": false }` 或临时移除 contextEngine slot
2. 重启 gateway
3. 执行场景 1、2、3，记录 Agent B 的回答

**Test B — 开启共享**:
1. 恢复配置 `"*": { "shared": true }`
2. 重启 gateway
3. **先让 Agent A 产生上下文**（执行 Phase 1）
4. 再让 Agent B 提问（执行 Phase 2），记录回答

### Step 3: 定量数据收集（2 分钟）

```bash
# 收集最终统计
cp ~/.openclaw/shared-context/stats.json ~/eval-final.json

# 生成对比
python3 -c "
import json
baseline = json.load(open('eval-baseline.json'))
final = json.load(open('eval-final.json'))
print('=== 增量统计 ===')
print(f'新增 assembleHits: {final[\"assembleHits\"] - baseline[\"assembleHits\"]}')
print(f'新增注入 Token: {final[\"totalSharedTokensInjected\"] - baseline[\"totalSharedTokensInjected\"]}')
print(f'新增跨 Agent 流:')
for src, targets in final.get('crossAgentFlow', {}).items():
    for tgt, cnt in targets.items():
        old = baseline.get('crossAgentFlow', {}).get(src, {}).get(tgt, 0)
        if cnt > old:
            print(f'  {src[:8]}... → {tgt[:8]}...: +{cnt - old}')
"
```

### Step 4: 评估打分（10 分钟）

填写评估表：

| 维度 | 指标 | 结果 | 目标 | 通过? |
|------|------|------|------|-------|
| 信息传递率 | 命中率 | ?% | >30% | |
| 上下文连贯性 | 场景1评分 | ?/3 | ≥2 | |
| 上下文连贯性 | 场景2评分 | ?/3 | ≥2 | |
| 上下文连贯性 | 场景3评分 | ?/3 | ≥2 | |
| Token经济性 | 占预算比 | ?% | <5% | |
| Token经济性 | 每次命中Token | ? | <2000 | |
| 信噪比 | 抽样评分 | ?/2 | ≥1.0 | |

---

## 四、后续优化方向

根据评估结果决定：

| 如果... | 则优化... |
|---------|----------|
| 命中率低 | 改进检索算法（语义搜索替代时间排序） |
| 连贯性低 | 增加上下文摘要（减少噪声） |
| Token 占比高 | 降低 sharedBudgetRatio |
| 信噪比低 | 加强入池过滤（提高最低长度阈值、增加相关性过滤） |
