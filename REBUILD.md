# OpenClaw Rebuild — 基于熵减架构的优化方案

基于《多智能体系统架构设计书：基于耗散结构与熵减理论》的理论框架，对 OpenClaw 架构进行系统性审视后形成的优化方案。

---

## 理论基础

核心原则映射：

| 白皮书原则 | OpenClaw 现状 | 优化方向 |
|-----------|-------------|---------|
| **Gatekeeper**（强模型做任务拓扑构建） | Gateway 是认证/路由层，不做意图识别 | 主 Agent 承担 Gatekeeper 角色，精准拆解子任务 DAG |
| **MVC**（最小可用上下文） | Bootstrap 150K chars + full system prompt | 按任务类型条件加载，adaptive prompt 模式 |
| **Compressor**（过程数据结晶） | Compaction 仅在 context 溢出时紧急触发 | 增量式过程压缩 + Memory 结晶层 |
| **绝对状态隔离** | 子 Agent 隔离良好，但通信是自然语言 | 主 Agent 按任务类型指定返回格式 + 工具子集 |
| **坍缩机制**（Human-in-the-loop） | 工具循环检测 + 审批机制 | 风险等级制（0-5）+ 渐进式授权 |

---

## Phase 0 — 可观测性基础设施 `[已完成]`

> 没有度量就没有优化

### 目标
全量 LLM 调用日志 + agent 归因 + 成本估算 + 7天原始数据清理

### 方案

**两层存储**：
- **统计层**（永久保留）：agent_id, parent_agent_id, session_key, task, model, provider, input/output tokens, cost, duration_ms, timestamp
- **原始层**（7天保留）：完整 request/response body → `logs/raw/{YYYY-MM-DD}/`

**成本估算**：
- 模型定价配置 `pricing.json`（可手动编辑）
- 启动时尝试查询最新定价，失败用本地配置
- 基于 `NormalizedUsage` 计算每次调用成本

**实现路径**：插件 `extensions/observability/`，hook 进已有的 `llm_input` + `llm_output` 事件

### 关键文件
- `src/agents/usage.ts` — token 归一化
- `src/agents/anthropic-payload-log.ts` — JSONL 模式参考
- `src/plugins/hooks.ts` — hook runner
- `src/agents/pi-embedded-runner/run/attempt.ts:1133-1350` — hook 触发点

---

## Phase 1 — 增量式过程压缩 `[已完成]`

### 目标
每轮工具执行后，分类结果（结论 vs 探索），压缩探索性输出，延长有效 context 寿命

### 方案

**分类器规则**：
- read/glob/grep 无错误 → conclusion（保留完整）
- bash/exec 有错误 → exploration（保留错误摘要，丢弃完整输出）
- 连续相同工具调用（重试检测）→ 只保留最后一次
- 工具循环 → 复用 `tool-loop-detection.ts`

**Hook**：`tool_result_persist`（同步，持久化前执行）

### 关键文件
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:293-436`
- `src/agents/compaction.ts:106-123`
- `src/agents/tool-loop-detection.ts`

---

## Phase 2 — Memory 结晶层 `[已完成]`

### 目标
会话结束后，将完整对话通过两阶段 LLM pipeline 提炼，重建 bootstrap 文件，驱动 agent 跨会话成长。

### 核心理念：重建式记忆

> 人的记忆是为当前状态服务的——当时发生了什么不重要，重要的是当前状态下，那段记忆要怎么解读和理解。

bootstrap 文件始终代表"当前最佳理解"，不是历史日志。新证据可以重写、锐化、移除旧条目。旧版本靠 git 保底，文件本身永远是现在时。

### 触发机制：双路径

```
路径 A — Agent 主动触发（首选）
┌──────────────────────────────────┐
│ crystallize-memory skill         │
│ Agent 在会话结尾判断是否值得结晶    │
│ 调用 skill → 读 session JSONL     │
│ → 写入 queue/（异步，立即返回）    │
└──────────────────────────────────┘

路径 B — 被动兜底触发
┌──────────────────────────────────┐
│ agent_end hook (Plugin)          │
│ 过滤：子 agent（sessionKey 含     │
│   subagent:）直接跳过             │
│ 过滤：总消息 < 5 条跳过           │
│ → 写入 queue/（零智能，纯管道）    │
└──────────────────────────────────┘
```

两条路径写入同一队列目录，worker 统一消费。

### Worker 两阶段 Pipeline

```
Queue 文件                       Worker (独立进程，Gateway 启动时自动拉起)
┌──────────────────┐            ┌────────────────────────────────────────────┐
│ session messages │──→ 磁盘 ──→│ Stage 1: Pro 级模型 (e.g. Gemini 3.1 Pro)  │
│ (完整对话历史)    │            │   信号提取: 用户消息 + 前置 assistant 上下文  │
└──────────────────┘            │   过滤: 用户消息 < 3 条则跳过（信号不足）     │
                                │   输入: 当前画像 + 信号对                   │
                                │   输出: <portrait action="updated">新画像   │
                                │         或 <portrait action="unchanged" />  │
                                │                                            │
                                │   ↓ 仅 updated 时触发 ↓                    │
                                │                                            │
                                │ Stage 2: Flash 级模型                      │
                                │   输入: Stage 1 画像 + 路由配置(purpose)    │
                                │   任务: 纯机械分解 → 各 bootstrap 文件       │
                                │   输出: <files><file path="...">...</file>  │
                                │   逐文件内容比对，有变化才覆写 + git commit   │
                                └────────────────────────────────────────────┘
```

**当前信号来源**：用户消息为主信号，assistant 消息仅作前置上下文（截断 600 字）。

### 设计决策

1. **Agent 主动触发优先**：agent 最清楚这次对话有没有产生值得记忆的东西。Skill 触发是语义的，`agent_end` 兜底是机械的
2. **`agent_end` 而非 `session_end`**：session_end 时基础设施已拆除，仅提供 sessionId；agent_end 提供完整 messages + workspaceDir 等上下文
3. **子 agent 过滤**：sessionKey 含 `subagent:` 直接跳过，子 agent 对话是任务片段，无结晶价值
4. **全量画像 + 机械分解**：Stage 1 只关心"这个人现在应该被怎么理解"，Stage 2 是无判断力的分解器，职责彻底分离
5. **XML 输出格式**：自然语言画像不适合 JSON 压缩，XML 标签包裹 markdown 内容最大化保留信息量
6. **多 Provider 支持**：Anthropic / Gemini / OpenAI / DeepSeek / OpenRouter，两个 stage 可用不同 provider + 模型
7. **覆写 + git 版本化**：文件全量覆写，历史靠 git 保全

> **Phase 9 扩展方向**：当前 Stage 1 仅分析用户认知，写入 USER_COGNITION.md 一个文件。Phase 9 将扩展 Stage 1 输入（加载所有 bootstrap 文件）、扩展分析维度（用户偏好 / agent 人设 / 工作区发现）、扩展 Stage 2 路由（动态调度到所有涉及文件）。两阶段架构、重建式记忆、git 版本化不变。

### 配置示例

```json
{
  "stage1": { "provider": "gemini", "model": "gemini-3.1-pro", "thinking": "low" },
  "stage2": { "provider": "gemini", "model": "gemini-3.0-flash" },
  "portraitPath": "~/.openclaw/memory/portrait.md",
  "routes": [
    { "path": "~/.openclaw/workspace/USER_COGNITION.md", "purpose": "User cognition portrait — behavioral patterns, decision-making style, communication preferences, cognitive tendencies." }
  ],
  "minUserMessages": 3,
  "pollMs": 5000
}
```

### 关键文件
- `extensions/memory-crystallizer/index.ts` — 双路径触发：agent_end 兜底捕获（含子 agent 过滤）+ worker 服务注册
- `extensions/memory-crystallizer/src/worker.ts` — 两阶段 LLM 结晶 Worker
- `extensions/memory-crystallizer/src/providers.ts` — 多 Provider LLM 抽象层
- `extensions/memory-crystallizer/src/git-store.ts` — git 版本化存储
- `extensions/memory-crystallizer/crystallizer.config.json` — 模型配置 + 路由
- `skills/crystallize-memory/` — agent 主动触发 skill（SKILL.md + scripts/queue-crystallization.sh）
- `docs/reference/templates/SOUL.md` — Continuity 章节内化结晶行为准则

---

## Phase 3 — Bootstrap 条件加载 `[已完成]`

### 目标
Bootstrap 文件按任务类型选择性加载，system prompt 从 full/minimal 二选一变为自适应

### 分析结论
- IDENTITY.md 有结构化解析（`identity-file.ts:38-78`），不合并
- AGENTS.md + SOUL.md 语义边界清晰，保持分离
- 改为标签化条件加载

### 方案

**文件标签**：
- `core`: IDENTITY.md, SOUL.md
- `operational`: AGENTS.md, TOOLS.md
- `memory`: MEMORY.md, USER.md
- `infra`: HEARTBEAT.md, BOOTSTRAP.md

**加载策略**：简单查询 → core + operational | 编码任务 → + memory | 完整 session → 全量

**Adaptive prompt**：首轮只注入 identity + tools，后续按工具调用动态追加 section

### 关键文件
- `src/agents/workspace.ts:441-513`
- `src/agents/system-prompt.ts:11-17, 368`

### 实现备注
- `workspace.ts`: 新增 `BootstrapFileTag`/`TaskContext` 类型 + `BOOTSTRAP_FILE_TAG_MAP` + `TASK_CONTEXT_TAGS`，扩展 `filterBootstrapFilesForSession()` 接受 `taskContext` 参数
- `system-prompt.ts`: PromptMode 新增 `"adaptive"` + `ADAPTIVE_SECTION_TRIGGERS`（工具→section 映射）+ `AdaptivePromptState`
- `bootstrap-files.ts`: `resolveBootstrapFilesForRun()` 透传 `taskContext`
- `run/attempt.ts`: `resolvePromptModeForSession()` 新增 `preferAdaptive` 参数
- **差异**: USER.md 归入 `memory` 标签（非 `operational`），因其内容为用户偏好/记忆数据，与 coding/session 上下文更匹配

---

## Phase 4 — 子 Agent 结构化通信 + 任务级工具授权 `[已完成]`

### 目标
主 Agent 创建子 Agent 时指定返回格式和工具子集

### 方案

**返回格式**（由主 Agent 按任务类型判断）：

| 任务类型 | 格式 | 原因 |
|---------|------|------|
| 代码搜索/结构化查询 | json | 父 Agent 需要精确消费 |
| 分析/总结/创意 | text | 结论本身非结构化 |
| 混合型 | structured | JSON meta + 自然语言 body |

**SpawnSubagentParams 扩展**：
- `responseFormat?: "json" | "text" | "structured"`
- `responseSchema?: object`
- `toolPolicy?: { allow?: string[]; deny?: string[] }`

### 关键文件
- `src/agents/subagent-spawn.ts:25-36`
- `src/agents/subagent-announce.ts:170-201`
- `src/agents/pi-tools.policy.ts:86-103`
- `src/agents/tool-policy-pipeline.ts:65-108`

### 实现备注
- 8 个核心文件改动，全部向后兼容（新字段均为 optional）
- `subagent-announce.ts`: `buildResponseFormatInstructions()` 按 format 生成 prompt 约束 + `parseSubagentOutput()` 结构化解析
- `subagent-registry.ts/types.ts`: responseFormat + spawnToolPolicy 存储在 `SubagentRunRecord`（非 SessionEntry，因为是 subagent 子系统内部数据）
- `pi-tools.policy.ts`: 新增 `resolveSpawnLevelToolPolicy()`（非 `resolveSubagentToolPolicy`，避免与已有函数命名冲突）
- `pi-tools.ts` + `tools-invoke-http.ts`: spawnLevelPolicy 作为 `applyToolPolicyPipeline` 最后一步（最高优先级过滤）
- **数据流**: `sessions_spawn(toolPolicy)` → `SpawnSubagentParams` → `SubagentRunRecord` → `resolveSpawnToolPolicyForSession(childSessionKey)` → `resolveSpawnLevelToolPolicy()` → pipeline 最后一步

---

## Phase 5 — 渐进式授权（风险等级制）`[已完成]`

### 目标
用 0-5 风险等级替代二元审批，每级有明确行为规则

### 风险等级定义

| 级别 | 含义 | 行为 | 示例 |
|------|------|------|------|
| 0 | 无风险 | 静默执行 | read, glob, grep |
| 1 | 低风险 | 静默执行，记录日志 | write(新文件), mkdir |
| 2 | 中低风险 | 首 N 次确认，后续静默 | bash(非破坏性), npm install |
| 3 | 中高风险 | 每次确认，可 allow-always | edit(已有文件), git commit |
| 4 | 高风险 | 每次确认，不可 allow-always | rm, git push, 消息发送 |
| 5 | 极高风险 | 二次强确认，不可跳过 | rm -rf, DROP TABLE, force push |

### 方案

**持久化**（md + JSON 双写）：
- `risk-config.md`：人类可读 + Agent 可作为 prompt context
- `approvals.json`：审批历史持久化（轻量替代 SQLite）

**渐进式降级**：Level 2 连续 N 次批准 → 降为 Level 1 | Level 4-5 永不降级

**回收站**：Level 4+ 文件删除 → `.openclaw/trash/{YYYY-MM-DD}/`，7天自动清理

### 关键文件
- `src/gateway/exec-approval-manager.ts`
- `src/agents/pi-tools.before-tool-call.ts:74-173`

### 实现备注
- 8 个新文件 `extensions/risk-levels/`，纯扩展，零核心侵入
- `assess.ts`: 完整的命令模式库（15 个 L5 灾难性 + 12 个 L4 破坏性 + 8 个 L3 变更 + 16 组 L2 安全前缀）
- `approval-store.ts`: JSON 文件持久化，延迟 2s 批量写入，500 条上限，bash 按首 token 分组哈希
- `trash.ts`: manifest.json 支持 `restore()` 恢复 + 7 天自动清理
- **差异**:
  - 审批历史用 JSON 替代 SQLite（轻量，无外部依赖）
  - Level 2-3 不直接 block，附加 `_riskLevel` 元数据复用现有审批流
  - bash 命令按首 token 分组哈希（`npm install X` 和 `npm install Y` 共享信任计数器）

---

## Phase 6 — 任务执行记录 `[已完成]`

### 目标
完整记录主任务拆解 → 子任务 → 执行过程 → 结果链路

### 方案

**记录格式**：每个主任务一个 md 文件 → `task-logs/{task-name}_{YYYY-MM-DD_HHmm}.md`

包含：任务描述、子任务拆解（agent + 工具 + 依赖关系）、执行过程摘要（工具调用 + token + 成本）、最终产物、总计

**生命周期**：默认保留 90 天，cron 清理

### Hook 驱动
- `session_start` → 注册 sessionId↔sessionKey 映射
- `subagent_spawned` → 记录子任务创建
- `subagent_ended` → 记录完成 + 结果，自动 finalize
- `session_end` → 回退 finalization 路径

### 实现备注
- 4 个新文件 `extensions/task-logging/`，纯扩展
- **关键发现**: `session_end` 仅在 session reset (`/new`, `/reset`) 时触发，非正常结束不触发。改用"最后一个子任务结束时 auto-finalize"作为主路径
- **身份不匹配处理**: subagent hooks 提供 `requesterSessionKey`（路由键），session_end 提供 `sessionId`（UUID）。通过反向映射关联
- **字段降级**: hook 事件中 model/tools/usage 等字段不可用，用 label 代替 taskDescription，用 outcome enum 代替 success boolean，duration 通过 spawnedAt→endedAt 计算

---

## Phase 7 — 多线程/定时器修复 `[已完成]`

### 审计发现（含二次验证）

原始审计发现 7 个问题，深入验证后 **4 个为误报**，实际问题 3 个：

| # | 问题 | 初判 | 终判 | 误报原因 |
|---|------|------|------|---------|
| 1 | Cron cursor 竞态 | 高 | **误报** | JS 单线程，`cursor++` 在 `await` 前同步完成 |
| 2 | Maintenance timers 泄漏 | 中 | **低** | `server-close.ts:87-89` 已有清理，但 noop 创建冗余 |
| 3 | Cron timer 未 unref | 中 | **误报** | `stopTimer()` 在 shutdown 清理，不阻塞退出 |
| 4 | Promise lock 无清理 | 中 | **误报** | `storePath` 基数 = agent 数（1-10），Map 有界 |
| 5 | Noop interval 冗余创建 | 低 | **低** | 无条件创建 3 个 noop interval 后覆盖 |
| 6 | Session write lock 同步 I/O | 中 | **误报** | `process.on('exit')` 只能用同步 I/O |
| 7 | Subagent listener 泄漏 | 低 | **中** | `stopSweeper()` 不调 `listenerStop()` |

### 已修复

**#7 Subagent listener 泄漏**（`subagent-registry.ts:472-478`）：
- `stopSweeper()` 现在同时调用 `listenerStop()` 并重置 `listenerStarted`
- 效果：sweeper 停止后事件监听不再空转

**#5 Noop interval 冗余创建**（`server.impl.ts:482-503`）：
- 改为条件创建：`!minimalTestGateway` 时创建真实 timer，否则创建 noop
- 消除非 test 模式下 3 个 noop interval 的无谓创建和泄漏

### 教训
> 代码审计对并发问题的直觉不适用于 JS 单线程模型。`cursor++` 在其他语言是经典竞态，在 JS 里天然安全。二次验证消除了 4 个误报，避免了对正确代码的过度改造。

---

## Phase 8 — 动态缓存策略 `[已完成]`

### 目标
通过 system prompt 分段缓存 + 会话历史滑动窗口缓存，最大化 cache hit 率，降低多轮对话的 token 重复计费成本

### 现状分析

**当前实现**：
- System prompt 由 `buildAgentSystemPrompt()` 拼接为**单一字符串**（`system-prompt.ts:410-647`）
- 缓存标记在 payload 序列化阶段注入，仅标记 system message **最后一个 block**（`extra-params.ts:359-396`）
- Anthropic 直连用 `cacheRetention: "short"`（5分钟 TTL），OpenRouter 用 `cache_control: { type: "ephemeral" }`
- 会话历史完全无缓存标记 — 每轮重传全部历史，全额计费
- Moonshot 为 native cache TTL provider，由平台管理缓存

**成本影响**（以 Claude Opus 为例）：
- 输入: $15/1M | cache read: $1.5/1M → 缓存命中 **10x 节省**
- Kimi K2.5: ¥4/1M vs ¥0.7/1M → **5.7x 节省**
- 30轮对话、系统 prompt 20K tokens → 不缓存重传 600K tokens（$9），缓存命中仅 $0.9

### 方案

#### Layer 1: System Prompt 分段缓存

将单一字符串改为 **content block 数组**，按易变性分段，每段独立标记 cache_control：

```
┌─────────────────────────────────────────────┐
│ Block 1: FROZEN（极稳定）                     │  ← cache_control ✓
│ Safety rules + Tool schemas + Core identity  │
│ 变更频率: 几乎不变（跨 session 稳定）          │
├─────────────────────────────────────────────┤
│ Block 2: STABLE（session 级稳定）             │  ← cache_control ✓
│ Project context files + Memory context +     │
│ Skills definitions + Docs                    │
│ 变更频率: session 内不变，跨 session 可能变     │
├─────────────────────────────────────────────┤
│ Block 3: VOLATILE（每轮变化）                  │  ← 不缓存
│ Runtime info (date/time/host) +              │
│ Workspace notes + Heartbeat + Reactions      │
│ 变更频率: 每轮或每几轮更新                      │
└─────────────────────────────────────────────┘
```

**改动点**：
1. `buildAgentSystemPrompt()` 返回 `SystemPromptBlock[]` 而非 `string`
   ```typescript
   type SystemPromptBlock = {
     text: string;
     volatility: "frozen" | "stable" | "volatile";
   };
   ```
2. `applySystemPromptOverrideToSession()` 保留 block 结构传递
3. `extra-params.ts` 的 payload 拦截器按 volatility 分配 cache_control:
   - frozen + stable → `cache_control: { type: "ephemeral" }`
   - volatile → 不标记
4. 向后兼容：不支持 content block 的 provider 回退到字符串拼接

#### Layer 2: 会话历史滑动窗口缓存

Anthropic 支持消息列表中**最多 4 个 cache breakpoint**。System prompt 用掉 2 个后，还剩 **2 个可用于会话历史**。

**策略：双指针滑动窗口**

```
Turn 1-4:  无缓存（历史太短，收益低）
Turn 5:    在 turn 4 的 user message 上标记 breakpoint ①  ← 冻结前 4 轮
Turn 10:   移动 breakpoint ① 到 turn 9                    ← 冻结前 9 轮
           在 turn 4 位置标记 breakpoint ② （过渡缓存）
Turn 15:   breakpoint ① → turn 14, breakpoint ② → turn 9
...
```

**核心逻辑**：
```
每 N 轮（可配置，默认 5）:
  1. 计算 "冻结边界" = 当前轮次 - 1
  2. 将 primary breakpoint 移到冻结边界的 user message
  3. 将 secondary breakpoint 移到上一个冻结边界（过渡期保持旧缓存）
  4. 旧缓存自然过期（provider TTL 管理，无需显式释放）
```

**旧缓存释放机制**：
- 不需要显式 invalidate — 当 breakpoint 位置移动后，旧位置的缓存不再被引用
- Provider 侧：超过 TTL（Anthropic 5分钟）后自动驱逐
- 效果：每次滑动后，旧的缓存前缀在 TTL 内可能仍被命中（过渡期），之后自然淘汰

**实现要点**：
1. 在 `run/attempt.ts` 的 history sanitization 阶段计算 breakpoint 位置
2. 通过 `onPayload` 拦截器注入 `cache_control` 到对应 message 的最后 content block
3. 跟踪当前 breakpoint 位置（写入 session 的 cache-ttl custom entry）
4. 保持与 `limitHistoryTurns()` 和 `compaction` 的兼容 — 如果历史被截断/压缩，breakpoint 位置需重新计算

#### Layer 3: Provider 适配策略

| Provider | System Prompt 分段 | 历史滑动窗口 | 备注 |
|----------|-------------------|-------------|------|
| Anthropic 直连 | ✅ content blocks + cacheRetention | ✅ message-level breakpoints | 原生支持，最优 |
| OpenRouter + Anthropic | ✅ 通过 onPayload 注入 | ✅ 同上 | 通过 payload 拦截实现 |
| Moonshot (Kimi) | ⚠️ 平台管理，确保前缀匹配 | ⚠️ 取决于平台实现 | 保持 prompt 前缀稳定即可 |
| Bedrock + Anthropic | ✅ 同 Anthropic 直连 | ✅ 同上 | 需测试兼容性 |
| OpenAI / Gemini | ❌ 不支持 | ❌ 不支持 | 回退到字符串模式 |

**Moonshot 特殊处理**：
- Kimi 的缓存基于 **prompt 前缀匹配** — 相同前缀部分自动缓存
- 策略：确保 system prompt 的 frozen + stable 部分始终作为 prompt 最前部
- 不需要显式 cache_control 标记，但 prompt 结构稳定性本身就是优化

#### Layer 4: 子 Agent 缓存策略

子 Agent 使用与主 Agent **相同的缓存基础设施**（`applyExtraParamsToAgent()` 统一生效），但有独特的优化机会。

**现状**：
- 子 Agent 的 system prompt 使用 `promptMode="minimal"`，排除 Memory/Heartbeat/Model Aliases 等 11+ section
- 任务描述作为 **user message** 注入（`subagent-spawn.ts:391-399`），不污染 system prompt 前缀
- `cache_control: ephemeral` 已经标记在子 Agent 的 system message 上
- 子 Agent 是**多轮**的（工具调用循环），同样需要历史缓存

**优化 1: 跨子 Agent 的 system prompt 前缀共享**

同一父 Agent 生成的多个子 Agent，system prompt 结构高度相似：

```
子 Agent A 的 system prompt:
┌─────────────────────────────────┐
│ Safety + Tooling + Workspace    │  ← 与 Agent B/C 完全相同（FROZEN）
├─────────────────────────────────┤
│ Subagent Context (depth, task)  │  ← 每个子 Agent 不同（VOLATILE）
└─────────────────────────────────┘

子 Agent B 的 system prompt:
┌─────────────────────────────────┐
│ Safety + Tooling + Workspace    │  ← 缓存命中 ✓（与 A 前缀相同）
├─────────────────────────────────┤
│ Subagent Context (depth, task)  │  ← 不同任务描述
└─────────────────────────────────┘
```

- 将 system prompt 分段（Layer 1 方案）后，FROZEN 部分在**并发子 Agent 之间自动共享缓存**
- 关键约束：`extraSystemPrompt`（Subagent Context）必须放在 prompt **末尾**，不能插入 FROZEN 段中间
- 成本估算：spawn 5 个并发子 Agent，system prompt ~15K tokens → 第 1 个全额 $0.225，后 4 个 cache hit $0.0225/个 → **总省 80%**

**优化 2: 子 Agent 内的轻量滑动窗口**

子 Agent 会话通常 5-20 轮（工具调用密集但生命周期短），策略比主 Agent 更激进：

```
主 Agent 策略:  每 5 轮滑动，双指针
子 Agent 策略:  每 2 轮滑动，单指针（每次工具调用完成即冻结上一轮）

子 Agent Turn 1-2:  无缓存
子 Agent Turn 3:    在 turn 2 位置标记 breakpoint ← 冻结任务 + 首次工具结果
子 Agent Turn 5:    移动 breakpoint 到 turn 4
子 Agent Turn 7:    移动 breakpoint 到 turn 6
...
```

- 子 Agent 的轮次几乎全是 tool_use → tool_result 循环，每 2 轮就是一个完整工具调用单元
- 每完成一次工具调用就冻结，下一次调用时前面全部走 cache read
- Anthropic 4 个 breakpoint 预算：system prompt 用 1 个（FROZEN 前缀），历史用 1 个 → 子 Agent 还剩 2 个余量
- 单指针足够：子 Agent 生命周期短，不需要过渡期的 secondary breakpoint

**优化 3: 工具调用结果的选择性缓存**

子 Agent 的多轮对话中，工具调用结果是主要的 token 消耗：

```
Turn 1: [user] task description (200 tokens)
Turn 2: [assistant] tool_use: read file (50 tokens)
Turn 3: [user] tool_result: file content (5000 tokens)   ← 大块内容
Turn 4: [assistant] tool_use: edit file (100 tokens)
Turn 5: [user] tool_result: success (20 tokens)
Turn 6: [assistant] final response (300 tokens)
```

- 将 cache breakpoint 放在**大块 tool_result 之后** → 最大化缓存收益
- 启发式：tool_result > 1000 tokens 时，标记该 message 为 breakpoint 候选
- 与固定间隔滑动互补：优先在大块结果后设断点，否则回退到间隔策略

**优化 4: `spawnMode` 感知的缓存策略**

| spawnMode | 典型轮次 | 缓存策略 |
|-----------|---------|----------|
| `"run"` | 5-15 轮 | 轻量单指针，每 2 轮滑动 |
| `"session"` | 20+ 轮 | 与主 Agent 相同的双指针策略 |

- `spawnMode="run"`: 一次性任务，快速完成，轻量缓存
- `spawnMode="session"`: 持久子 Agent，行为接近主 Agent，用完整策略

#### Layer 5: 缓存效果度量

通过 Phase 0 可观测性追踪：
- 每次 API 调用的 `cache_creation_input_tokens` vs `cache_read_input_tokens`
- 计算实际 cache hit 率 = cache_read / (cache_read + cache_creation + non_cached_input)
- 按 provider / model / session / **agent_type(main/subagent)** 分维度统计
- 在成本估算中区分 cache hit 和 cache miss 的实际成本
- 跨子 Agent 前缀共享的实际命中率（同一父 Agent 下的子 Agent 组）

### 配置

```typescript
type CacheStrategyConfig = {
  /** 启用 system prompt 分段缓存 */
  systemPromptSegmentation: boolean;  // default: true
  /** 启用会话历史滑动窗口缓存 */
  historyWindowCaching: boolean;      // default: true
  /** 主 Agent: 每 N 轮滑动一次 breakpoint */
  windowSlideInterval: number;        // default: 5
  /** 子 Agent (run mode): 每 N 轮滑动 */
  subagentWindowSlideInterval: number; // default: 2
  /** 最小历史轮次才启用滑动缓存 */
  minTurnsForCaching: number;         // default: 4
  /** 子 Agent 最小轮次 */
  subagentMinTurnsForCaching: number; // default: 2
  /** 工具结果大于此 token 数时优先作为 breakpoint 候选 */
  toolResultBreakpointThreshold: number; // default: 1000
};
```

### 关键文件
- `src/agents/system-prompt.ts:189-648` — buildAgentSystemPrompt()（改返回类型）
- `src/agents/pi-embedded-runner/system-prompt.ts:11-103` — prompt 传递链路
- `src/agents/pi-embedded-runner/extra-params.ts:359-396` — cache_control 注入
- `src/agents/pi-embedded-runner/run/attempt.ts:815-851` — 历史消息处理
- `src/agents/pi-embedded-runner/run/attempt.ts:224-229` — resolvePromptModeForSession（子 Agent 检测）
- `src/agents/pi-embedded-runner/cache-ttl.ts` — TTL 追踪
- `src/agents/subagent-spawn.ts:162-535` — 子 Agent 生成流程
- `src/agents/subagent-announce.ts:873-963` — 子 Agent system prompt 构建

### 验证
- 主 Agent 10 轮对话，对比优化前后 cache_read_input_tokens 占比
- 并发 spawn 3 个子 Agent，验证第 2/3 个的 system prompt cache hit
- 子 Agent 内 5 轮工具调用，确认 breakpoint 正确滑动
- 确认 provider 不支持时优雅回退（无 cache_control 标记，不报错）

### 实现备注
- 新增 `src/agents/cache-strategy.ts`: `SystemPromptBlock` 类型 + `CacheStrategyConfig` + `computeHistoryBreakpointIndex()` 滑动窗口算法 + `flattenSystemPromptBlocks()` 向后兼容
- `system-prompt.ts`: 新增 `buildAgentSystemPromptBlocks()` 独立函数（原 `buildAgentSystemPrompt()` 不变，仍返回 string）
- `extra-params.ts`: `supportsSegmentedCache()` Provider 检测 + `createSegmentedSystemCacheWrapper()` 分段缓存 + `createHistoryBreakpointCacheWrapper()` 滑动窗口 + `applyCacheStrategyToAgent()` 统一入口
- `run/attempt.ts`: 条件启用缓存策略（`cacheStrategy.systemPromptSegmentation`），子 Agent 用 `subagentWindowSlideInterval=2` / `subagentMinTurnsForCaching=2`
- `config/types.agent-defaults.ts` + `zod-schema` + `labels` + `help`: 完整的配置集成（7 个可配置项）
- `subagent-announce.ts`: 添加 FROZEN 前缀共享策略文档注释
- **分段策略**: FROZEN (Safety/Tooling/CLI) → STABLE (Skills/Memory/Docs/Workspace) → VOLATILE (Runtime/Heartbeats/Reactions)
- **Provider 适配**: Anthropic/OpenRouter+Anthropic/Bedrock+Anthropic → 原生支持 | OpenAI/Gemini → 回退到字符串模式
- Moonshot / Kimi K2.5 实测缓存命中率

---

## Phase 9 — 全量信息调度式结晶 `[待实施]`

### 目标

将结晶任务从单一用户认知画像，扩展为对所有 bootstrap 文件的统一更新机制。每次会话结束后，自动提炼全部互动内容，更新所有涉及的知识文件——agent 行为准则、用户认知、用户诉求、工作区发现等，驱动 agent 真正的跨会话成长。

### 两阶段设计

**Stage 1 — 全量提炼（Pro 级，如 Gemini 3.1 Pro）**

- **输入**：完整对话（全部消息）+ 当前所有 bootstrap 文件内容
- **任务**：深度挖掘所有维度的更新信号：
  - 用户互动模式：语言组织方式、表达风格、关注点、决策偏好、接受 / 推回信号
  - Agent 人设校准：这次对话中 agent 的表现方式、什么有效、什么需要调整
  - 用户诉求与上下文：用户说了什么、要什么、关心什么
  - 工作区发现：工具能力、agent 能力、环境信息
- **输出**：结构化综合提炼文档，覆盖所有需要更新的维度，不预设分类

**Stage 2 — 信息调度（Flash 级，如 Gemini Flash）**

- **输入**：Stage 1 提炼结果 + bootstrap 文件列表（path + purpose 定义）
- **任务**：将提炼结果分门别类写入对应文件，重构式覆写
- **路由依据**：Stage 2 prompt + 每个文件的 purpose 描述，动态决定哪些信息去哪个文件，不预设固定路由

### 更新规则

- **重构式覆写**：文件始终代表"当前最佳理解"，不追加历史（服务于用户当下状态的最优描述）
- **版本管理**：每次覆写通过 git commit 记录变更，可回溯
- **冲突检测**：当推断内容与文件中用户锚定区块存在原则性矛盾时，写入 `proposals.md` 等用户确认，不直接覆写

### Prompt 设计是核心

两个 stage 的 prompt 决定系统质量上限：

| Stage | Prompt 任务 | 关键设计 |
|-------|-----------|---------|
| Stage 1 | 看什么信号、如何深度提炼 | 决定信息不丢失 |
| Stage 2 | 什么信息去哪个文件 | 决定信息正确落位 |

bootstrap 文件的 **purpose 字段**是 Stage 2 的路由依据，purpose 描述准确则调度自然。

### 配置结构

`portraitPath`（单一画像）→ `bootstrapFiles[]`（完整文件列表 + purpose），Stage 2 按此动态调度：

```json
{
  "stage1": { "provider": "gemini", "model": "gemini-3.1-pro", "thinking": "low" },
  "stage2": { "provider": "gemini", "model": "gemini-3.0-flash" },
  "synthesisPath": "~/.openclaw/memory/synthesis.md",
  "bootstrapFiles": [
    { "path": "bootstrap/SOUL.md", "purpose": "Agent behavior guidelines and persona — how the agent communicates, its values, what it adjusts based on this user.", "conflictProposalPath": "~/.openclaw/memory/proposals.md" },
    { "path": "bootstrap/USER_COGNITION.md", "purpose": "User cognitive portrait — behavioral patterns, decision style, preferred interaction mode, language and expression tendencies." },
    { "path": "bootstrap/USER.md", "purpose": "User's ongoing needs, current projects, stated goals and preferences." },
    { "path": "bootstrap/TOOLS.md", "purpose": "Available tools and discovered capabilities from actual usage." },
    { "path": "bootstrap/AGENTS.md", "purpose": "Available agents, their roles, and how to effectively work with them." }
  ],
  "minUserMessages": 3,
  "pollMs": 5000
}
```

### Worker 改动

1. **Stage 1 输入构建**（`parsing.ts`）：传入完整对话 + 所有 bootstrap 文件当前内容
2. **Stage 1 输出**：单一综合提炼文档（写入 `synthesisPath`，替代原 `portraitPath`）
3. **Stage 2 输入**：综合提炼文档 + `bootstrapFiles[]`（含 path + purpose）
4. **Stage 2 输出解析**：同现有 `parseStage2Result()`，按 path 路由到各文件
5. **冲突处理**：文件配置含 `conflictProposalPath` 时，Stage 2 遇到原则性矛盾输出 conflict 标记 → 写入 proposals.md，跳过该文件覆写

### 与 Phase 2 的关系

两阶段 pipeline、重构式记忆、git 版本化不变。变化在于：

| | Phase 2（当前）| Phase 9（目标）|
|-|--------------|--------------|
| Stage 1 输入 | 当前用户认知画像 | 完整对话 + 所有 bootstrap 文件 |
| Stage 1 输出 | 用户认知画像 | 综合提炼文档（全维度）|
| Stage 2 路由 | 单一固定路由 → USER_COGNITION.md | 动态调度 → 所有涉及文件 |

### 触发机制（已完成）

Phase 9 实施前，已完成 agent 自主触发的基础设施：

- **`skills/crystallize-memory/`** — agent 主动调用的结晶 skill，读取当前 session JSONL 写入队列，异步返回
- **`docs/reference/templates/SOUL.md`** — `## Continuity` 加入结晶行为准则，agent bootstrap 时自然沉淀
- **`extensions/memory-crystallizer/index.ts`** — `agent_end` hook 加子 agent 过滤（`sessionKey` 含 `subagent:` 则跳过），只结晶主 agent 对话

### 实施清单

- [ ] `crystallizer.config.json`：schema 从 `portraitPath + routes` 升级为 `synthesisPath + bootstrapFiles[]`
- [ ] `worker.ts`：Stage 1 输入加载所有 bootstrap 文件内容；Stage 1 输出改为综合提炼文档（synthesisPath）
- [ ] `worker.ts`：Stage 2 按 bootstrapFiles[].purpose 动态调度，取代固定单路由
- [ ] `parsing.ts`：Stage 2 输出解析加冲突 element 处理
- [ ] 冲突处理：含 `conflictProposalPath` 的文件遇原则性矛盾时写入 proposals.md，跳过覆写
- [ ] Stage 1/2 system prompt 重写（核心：全维度提炼 + 信息调度）

### 关键文件
- `extensions/memory-crystallizer/src/worker.ts` — Stage 1/2 流程改造
- `extensions/memory-crystallizer/src/parsing.ts` — 输入构建 + 输出解析
- `extensions/memory-crystallizer/crystallizer.config.json` — 配置 schema 升级（bootstrapFiles[]）
- `skills/crystallize-memory/SKILL.md` — agent 主动触发入口（已完成）

---

## 执行顺序

```
REBUILD.md (本文档)
  ↓
Phase 0 (可观测性) ← 基础设施，度量能力
  ↓
Phase 7 (多线程修复) ← 基础稳定性
  ↓ (以下可并行)
Phase 1 (过程压缩)  | Phase 2 (Memory 结晶) | Phase 3 (Bootstrap)
Phase 4 (子 Agent)  | Phase 5 (授权)        | Phase 6 (任务记录)
  ↓
Phase 8 (动态缓存) ← 依赖 Phase 0 度量 + Phase 3 的 prompt 结构改造
  ↓
Phase 9 (多画像结晶) ← 依赖 Phase 2 的两阶段架构
```

> Phase 8 依赖 Phase 3 的 system prompt 改造（从 string → content blocks），
> 两者可合并实施或 Phase 3 先改结构、Phase 8 再加缓存标记。

---

## 代码审查与修复记录

全部 Phase 实施后进行了 4 路并行代码审查，共发现 10 BUG + 20 RISK + 8 STYLE。修复了 9 BUG + 11 RISK + 5 项清理。

### P0 修复（运行时错误/安全绕过）

| Phase | 问题 | 修复 |
|-------|------|------|
| 8 | `computeHistoryBreakpointIndex` 返回 turn 计数而非 message index | 遍历 messages 数组找实际 index |
| 5 | 复合命令 `&&`/`;`/`\|` 绕过风险评估 | 拆分子命令独立评估，取最高等级 |
| 5 | `rm --recursive --force` 不被识别为 L5 | 新增分离短选项 + 长选项模式 |
| 4 | `spawnLevelPolicy` 缺失于 `collectExplicitAllowlist` | 补齐，与 gateway 一致 |

### P1 修复（功能性缺陷）

| Phase | 问题 | 修复 |
|-------|------|------|
| 3 | adaptive 模式死代码（`preferAdaptive` 未传） | `adaptivePrompt` 配置联通 + session 历史提取工具激活 |
| 4 | gateway `resolveSubagentToolPolicy` 缺 depth | 传入 `getSubagentDepthFromSessionStore` |
| 5 | `_riskLevel` 元数据污染工具 params | `after_tool_call` 改为重新 `assessRisk()`，不注入元数据 |
| 5 | `mcp__*` 将所有 MCP 工具标为 L0 | MCP 工具默认 L1 |
| 5 | 含引号路径无法提取 | 正则去除 `'`/`"` 包裹 |

### 高价值 RISK 修复

| Phase | 问题 | 修复 |
|-------|------|------|
| 8 | 分段缓存可能超 Anthropic 4 breakpoint 限制 | 只在最后 frozen + 最后 stable block 标记 |
| 8 | OpenRouter 缓存 wrapper 与分段 wrapper 冲突 | 检测已有 `cache_control` 时跳过 |
| 4 | JSON 解析不去 markdown fences | 剥离 ` ```json ``` ` 后再 parse |
| 5 | bash hash 首 token 太粗 | 改用前两个 token |
| 5 | `mv`/`sed -i`/`xargs` 风险等级太低 | 提升到 L3 |
| 5 | 审批历史进程退出可能丢失 | `process.on("exit", flush)` 兜底 |
| 6 | `session_end` fallback 路径不可靠 | 改用 agentId 扫描 |
| 6 | `sessionIdToKey` 内存泄漏 | 加 1000 容量上限 |

### 清理

- 移除 `toolResultBreakpointThreshold` 死配置（类型+schema+labels+help）
- 移除 `pendingAssessments` 死代码
- `trashRetentionDays` 配置联通到 `TrashManager`
- 删除 catch 块冗余 `finalized` 赋值
- 新增 `escapeMarkdown()` 转义 task log 用户输入

---

## 二次审视与补全记录

文档审视发现 4 项遗漏，已全部修复。

### 补全 #1: Phase 0 + Phase 1 单元测试

Phase 0 (observability) 和 Phase 1 (context-optimizer) 是唯一没有测试覆盖的 Phase。

| 插件 | 测试文件 | 测试数 | 覆盖范围 |
|------|---------|--------|---------|
| observability | `src/pricing.test.ts` | 29 | 模型定价查找（精确+前缀匹配）、成本计算（单层/分层/缓存 token）、CNY 模型、自定义定价覆盖 |
| observability | `src/logger.test.ts` | 29 | 初始化、stats/raw JSONL 写入、input-output 关联、subagent 检测、过期日志清理、错误韧性 |
| context-optimizer | `src/classifier.test.ts` | 28 | 结论/探索分类、重试检测、超大输出、大小写、边界情况 |
| context-optimizer | `src/compressor.test.ts` | 24 | 内容提取、details 剥离、head/tail 截断、错误摘要、压缩统计 |

### 补全 #2: task-logger ↔ observability 集成

Phase 6 task-logger 设计中明确包含 token/cost 数据（`Token: input={n} output={n} cost=${x}`），但实现中完全缺失。

**修复方案**：task-logger 自行积累 token，不依赖 observability 插件：
- `task-logger.ts` 新增 `TokenAccumulator` + `accumulateTokens()` 公共方法
- `index.ts` 新增 `llm_output` hook，按 sessionKey 累计 token + 自带精简定价表估算成本
- `recordSubtaskEnd()` 自动附加累计 token/cost 到子任务记录
- Markdown 输出：每个子任务的 Execution Details 含 `Tokens: X in / Y out` + `Cost: $Z`，Summary 含汇总
- 新增 5 个测试覆盖 token 积累、汇总、空值、未知模型

**架构决策**：两个插件独立 hook `llm_output`，各自累计。不引入跨插件依赖——observability 做全量持久化，task-logger 做 session 级聚合。

### 补全 #3: Config-based 调试数据路径

计划中的 `/api/debug/llm-calls` 和 `/api/debug/task-logs` HTTP 端点改为 config-based 路径方案。Agent 可读取配置获知文件位置，直接读取文件或提供路径给用户。

**改动**：
- `observability/openclaw.plugin.json`: 新增 `statsDir`、`rawDir` 可选配置
- `task-logging/openclaw.plugin.json`: 新增 `logDir` 可选配置
- 各 `index.ts`: 从 config 读取路径（有则用、无则 fallback 默认路径），启动时 `logger.info()` 输出已解析路径

**使用方式**：Agent 读取插件配置 → 获取日志目录 → 用 `read` 工具直接查看 JSONL/markdown 文件。无需 HTTP 服务器。

### 补全 #4: risk-levels ↔ 审批流闭环

risk-levels 的 `before_tool_call` 对 L2-3 只是 `return { params }` 直接放行，渐进降级逻辑与真实审批结果断裂。

**修复方案**（仅改 `extensions/risk-levels/`，零核心侵入）：

`approval-store.ts` 新增 3 个方法：
- `isTrusted(toolName, hash, threshold)` — 检查连续审批是否达到信任阈值
- `recordApproval(toolName, hash, level)` — 便捷方法，记录成功执行
- `recordDenial(toolName, hash, level)` — 便捷方法，记录失败/拒绝（打断连续链）

`index.ts` hook 闭环：
- `before_tool_call`: L2 检查 `isTrusted()` → 已信任则静默执行（跳过审批）; L3 在现有 `isAllowAlways` 之后加信任检查
- `after_tool_call`: 工具成功 → `recordApproval()`，失败 → `recordDenial()`
- 反馈闭环：真实执行结果 → store → 下次 before_tool_call 查询 → 渐进信任

新增 9 个测试覆盖：信任阈值、拒绝打断、重建信任、完整降级生命周期、跨 pattern 隔离。

---

## 测试覆盖总览

| Phase | 测试文件 | 测试数 | 框架 |
|-------|---------|--------|------|
| 0 | `observability/src/pricing.test.ts` | 29 | vitest |
| 0 | `observability/src/logger.test.ts` | 29 | vitest |
| 1 | `context-optimizer/src/classifier.test.ts` | 28 | vitest |
| 1 | `context-optimizer/src/compressor.test.ts` | 24 | vitest |
| 2 | `memory-crystallizer/src/parsing.test.ts` | 37 | node:test |
| 3 | `src/agents/workspace.test.ts` | 29 (10旧+19新) | vitest |
| 4 | `src/agents/subagent-announce.test.ts` | 16 | vitest |
| 4 | `src/agents/pi-tools.policy.test.ts` | 36 (20旧+16新) | vitest |
| 5 | `extensions/risk-levels/src/assess.test.ts` | 57 (37旧+20新) | vitest |
| 5 | `extensions/risk-levels/src/approval-store.test.ts` | 23 (10旧+4+9新) | vitest |
| 5 | `extensions/risk-levels/src/trash.test.ts` | 8 (4+4skip) | vitest |
| 6 | `extensions/task-logging/src/task-logger.test.ts` | 62 (57旧+5新) | vitest |
| 8 | `src/agents/cache-strategy.test.ts` | 19 | vitest |
| 其他 | `src/agents/agent-paths.test.ts` | 4 | vitest |
| **合计** | **14 文件** | **401** | |

全部 401 个测试通过，0 失败。

---

*文档版本: v2.0*
*创建时间: 2026-02-24*
*最后更新: 2026-02-25 — Phase 2 重写（双路径触发 + 当前实现准确描述），Phase 9 实施清单完善*
*基于: 白皮书（熵减架构）+ OpenClaw 代码审计 + 8 轮讨论修正 + 缓存架构研究*

---

## 三次审视与补全记录

白皮书对照分析发现 3 项遗漏，已全部修复。

### 补全 #5: SOUL.md 澄清与规划原则

**问题**：系统提示中仅有被动防御式澄清（"instructions conflict → pause and ask"），缺少针对复杂任务的主动规划原则和不可逆任务的前置确认原则。白皮书的坍缩机制（Human-in-the-loop）要求对低置信度/高风险场景主动中断，而不仅是冲突时触发。

**修复**：`docs/reference/templates/SOUL.md` 新增 `## Before You Start` section：
- 复杂/多步骤任务：先陈述计划（task list + dependencies），再执行
- 意图模糊 + 后果不可逆：先澄清，再开始
- 明确与"resourceful before asking"的边界：resourceful 针对"怎么做"，澄清针对"做什么 + 高风险"

### 补全 #6: 子 Agent 结论优先汇报

**问题**：Phase 4 子 Agent 的 `text` 格式响应（默认格式）缺乏汇报约束，导致子 Agent 把完整过程叙述返回父 Agent，撑大父 Agent context，违反白皮书 Compressor 原则。

**修复**：`src/agents/subagent-announce.ts` `buildResponseFormatInstructions()` 的 `text` 分支，从"包含 + 简洁"弱约束改为"结论优先 + 禁止过程叙述"强约束：
- 首句给结论/结果
- 只提供父 Agent 需要决策的内容（outputs, decisions, blockers）
- 明确禁止过程叙述（"I tried X then Y"、中间步骤、self-commentary）
- 错误恢复后只汇报最终方案

### 补全 #7: Memory Crystallizer Worker 守护进程化

**问题**：Phase 2 memory-crystallizer 的 Worker 进程需要手动启动（`npx tsx src/worker.ts`），未纳入 Gateway 生命周期。若 Worker 未运行，`crystallization-queue/` 只会积压，结晶功能形同虚设。

**修复**：`extensions/memory-crystallizer/index.ts` 新增 `api.registerService()` 调用：
- `start()`: 检测 `crystallizer.config.json` 是否存在；存在则用 `bun` spawn worker 子进程，传入 `CRYSTALLIZER_CONFIG` + `CRYSTALLIZER_QUEUE_DIR` env vars
- `stop()`: Gateway 关闭时发送 `SIGTERM` 优雅停止 worker
- 缺少 config 文件时打印 warn 并跳过（不阻塞 Gateway 启动）
- Worker 非预期退出时记录 warn 日志（SIGTERM 正常退出静默）
