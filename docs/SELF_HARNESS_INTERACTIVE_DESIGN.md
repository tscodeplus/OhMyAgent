# 交互式 Self-Harness 设计文档

## 1. 概述

### 1.1 动机

Self-Harness（上海AI Lab）提出了一种范式：不改变模型权重，只通过分析失败轨迹自动优化 Agent 的 Harness（system prompt、工具配置、执行策略等），使同一模型在 Terminal-Bench-2.0 上提升 24%-104%。

原版 Self-Harness 是离线批处理模式：选取任务集 → 评估 → 分析失败 → 生成提案 → 离线验证 → 合并。这需要预先构建评估基准，对 OhMyAgent 这样的对话式助手成本很高。

**交互式 Self-Harness** 将三阶段循环嵌入运行时：用户任务失败 → 实时诊断 → 展示提案 → 用户当场审批 → 立即生效。不需要预先选场景、设基线——每一次真实失败就是天然的场景，用户自己就是验证者。

### 1.2 核心原则

| 原则 | 说明 |
|------|------|
| **失败即场景** | 不预设评估集，用户遇到的实际失败就是优化素材 |
| **用户即验证** | 用户审批代替离线验收门，未来对话代替 held-out 验证 |
| **最小化编辑** | 每次只改 3-5 行 prompt，影响范围限定在单个 Skill |
| **渠道无关** | 交互抽象层统一接口，WebUI/飞书/微信等渠道各自渲染 |
| **人始终在环** | L1 级别可自动应用+自动回滚，L2/L3 始终需要人工审批 |

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                     Agent 运行时                              │
│                                                              │
│  user message → AgentService.execute()                       │
│       │                                                      │
│       ▼                                                      │
│  ┌──────────────────────────────────┐                        │
│  │     EventBridge (事件总线)         │                        │
│  │  agent_start / tool_call / done   │                        │
│  └──────────────┬───────────────────┘                        │
│                 │                                            │
│    ┌────────────┴────────────┐                               │
│    ▼                         ▼                               │
│  ReplyDispatcher        FailureDetector                      │
│  (渠道渲染回复)           (检测失败信号)                       │
│                               │                              │
│                               ▼ (满足触发条件)                │
│                      ┌──────────────────┐                    │
│                      │ HarnessOptimizer │                    │
│                      │ 1. 收集轨迹       │                    │
│                      │ 2. LLM 诊断根因   │                    │
│                      │ 3. LLM 生成提案   │                    │
│                      └────────┬─────────┘                    │
│                               │                              │
│                               ▼                              │
│                    ┌────────────────────┐                    │
│                    │ HarnessInteraction │                    │
│                    │ (渠道无关的提案表示) │                    │
│                    └────────┬───────────┘                    │
│                             │                                │
│              ┌──────────────┼──────────────┐                │
│              ▼              ▼              ▼                 │
│         飞书卡片        WebUI SSE      微信文本              │
│       (交互式按钮)    (按钮组件)     (数字选项)               │
│              │              │              │                 │
│              └──────────────┼──────────────┘                │
│                             ▼                                │
│                    用户审批 (批准/拒绝/编辑)                    │
│                             │                                │
│                             ▼                                │
│               SkillEditor.apply(proposal)                    │
│               → 更新 SKILL.md                                │
│               → Git commit (带 changelog)                    │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 与原版 Self-Harness 的对应关系

| 原版 Self-Harness 组件 | 本设计对应 | 参考源码 |
|----------------------|-----------|---------|
| **Diagnosis** (`diagnosis/src/self_harness_diagnosis/`) | `FailureDiagnoser` — 收集工具调用序列 + 错误信息，调用 LLM 分析根因 | `trace.py:278-319` (LLM 分析提示词)、`integrated.py:41-62` (聚类逻辑) |
| **Proposer** (`proposer/src/self_harness_proposer/`) | `ProposalGenerator` — 调用 LLM 生成 prompt 改进建议，约束最小化编辑 | `multi_proposer.py:192-229` (多路由提案生成)、`hooks.py:51-64` (hook 别名映射) |
| **Acceptance Gate** (`acceptance/scripts/`) | 用户审批 + 生产监控自动回滚 — 用户点击批准 = 验收通过 | `run_acceptance_gate.py:77-99` (非回归接受标准) |
| **Hooks** (`proposer/src/self_harness_proposer/hooks.py`) | `EditableSurface` 抽象 — 定义哪些 Harness 部分可被编辑 | `hooks.py:9-64` (虚拟 Hook 到函数的映射) |

## 3. 核心模块设计

### 3.1 FailureDetector — 失败检测器

**职责**：在 Agent 执行结束后判断是否需要触发优化流程。

**触发条件**（参考 Self-Harness `trace.py:480-481` 的 `_is_failed_trace` 和 `turn-counter.ts` 的反模式检测）：

```typescript
// src/harness/failure-detector.ts

interface FailureContext {
  sessionId: string;
  skillId?: string;                    // 涉及哪个 Skill
  agentId?: string;                    // 涉及哪个 Agent（默认 default）
  taskMessage: string;
  toolCalls: ToolCallRecord[];
  errors: ToolErrorRecord[];
  userFeedback?: 'satisfied' | 'dissatisfied' | null;
  durationMs: number;
  terminatedEarly: boolean;
  agentEndReason: 'complete' | 'error' | 'aborted';
}

interface FailureSignal {
  detected: boolean;
  reason: string;            // 人类可读的失败简述
  severity: 'low' | 'medium' | 'high';
  pattern: FailurePattern;   // 可复用的失败模式分类
}

type FailurePattern =
  | 'identical_retry_loop'      // 重复相同失败命令 ≥ 3 次
  | 'exploration_without_output' // 持续探索 > 8 步无产出
  | 'tool_error_cascade'         // 连续工具错误 ≥ 3 次
  | 'dependency_not_checked'     // 缺少前置检查导致失败
  | 'user_explicit_dissatisfied' // 用户显式表达不满
  | 'timeout_or_abort';          // 超时或中止

function detectFailure(context: FailureContext): FailureSignal | null {
  // 排除信号 — 不触发
  if (context.toolCalls.length === 0) return null;
  if (context.userFeedback === 'satisfied') return null;

  // 1. 重复相同失败命令 (参考 turn-counter.ts 的 burst 检测)
  const identicalRetries = countIdenticalFailedCommands(context.toolCalls, context.errors);
  if (identicalRetries >= 3) {
    return { detected: true, reason: `相同命令重复失败 ${identicalRetries} 次`,
             severity: 'high', pattern: 'identical_retry_loop' };
  }

  // 2. 过度探索 (参考 trace.py:514-517 的 explore/change 阶段划分)
  const explorationSteps = countConsecutiveExploration(context.toolCalls);
  const changeSteps = context.toolCalls.filter(tc => isChangeTool(tc.name)).length;
  if (explorationSteps >= 8 && changeSteps === 0) {
    return { detected: true, reason: `连续探索 ${explorationSteps} 步未产出`,
             severity: 'medium', pattern: 'exploration_without_output' };
  }

  // 3. 工具错误级联
  const consecutiveErrors = maxConsecutiveErrors(context.errors);
  if (consecutiveErrors >= 3) {
    return { detected: true, reason: `连续 ${consecutiveErrors} 个工具调用失败`,
             severity: 'high', pattern: 'tool_error_cascade' };
  }

  // 4. 用户显式不满
  if (context.userFeedback === 'dissatisfied') {
    return { detected: true, reason: '用户表示不满意',
             severity: 'high', pattern: 'user_explicit_dissatisfied' };
  }

  // 5. 超时或中止
  if (context.terminatedEarly) {
    return { detected: true, reason: '任务超时或被中止',
             severity: 'medium', pattern: 'timeout_or_abort' };
  }

  return null;
}
```

### 3.2 HarnessOptimizer — 优化引擎

**职责**：收集轨迹 → LLM 诊断 → LLM 生成提案。这是 Self-Harness 核心逻辑的运行时移植。

**参考 Self-Harness 源码**：
- 诊断提示词：`trace.py:322-355` (`_build_stage_analysis_prompt`)
- 提案提示词：`multi_proposer.py:104-164` (`build_multi_proposer_prompt`)
- Hook 映射：`hooks.py:9-64` (`HOOK_ALIASES`)

#### 可编辑表面全景（对应 `hooks.py` 的虚拟 Hook 体系）

Self-Harness 的 Harness 包含 7 个机制家族，映射到 OhMyAgent 的具体表面：

```
Self-Harness 机制家族           OhMyAgent 可编辑表面                   存储位置
─────────────────────────     ────────────────────────────────       ──────────
prompt_instruction             Skill prompt (SKILL.md body)           skills/<id>/SKILL.md
                               Agent system prompt                   配置 / DB
                               Agent role description                配置 / DB
                               Base system prompt                    配置
                               Execution instruction                 配置
                               Verification instruction              配置
                               Failure recovery instruction          配置
                               Execution instruction                Agent 配置
                               Verification instruction             Agent 配置
                               Failure recovery instruction        Agent 配置

subagent                       Team mode spawn policy             Agent 配置
                               ChildAgentPromptOptimizer 规则      src/prompt/child-agent-optimizer.ts

skill_procedure                Skill 工具白名单                     skills/<id>/SKILL.md
                               Skill 触发词                        skills/<id>/SKILL.md
                               Skill 记忆策略                      skills/<id>/SKILL.md

tool_configuration             工具描述文本                         ToolDefinition.description
                               工具参数 schema 描述                 ToolDefinition.parametersSchema
                               工具 defer 策略                     ToolDefinition.deferrable

middleware                     turn-counter 反射注入规则           src/agent/turn-counter.ts
                               PromptManager 分层策略              src/prompt/prompt-manager.ts
                               审批注入中间件                       ApprovalGate

runtime_control                Agent 循环参数                      Agent 配置
                               toolExecution mode (parallel/seq)   AgentOptions
                               maxRetryDelayMs                    AgentOptions
                               thinkingBudgets                    AgentOptions

permission_interrupt           ApprovalGate 策略                   ApprovalGate 配置
                               执行模式 (strict/balanced/relaxed)   配置
                               Shell 审批规则                      配置
```

#### EditableSurface 定义

```typescript
// src/harness/editable-surfaces.ts

interface EditableSurface {
  id: string;                    // 全局唯一标识
  kind: EditableSurfaceKind;
  path: string;                  // 文件路径或配置键
  label: string;                 // 人类可读名称（用于展示）
  currentValue: string;
  mechanismFamily: MechanismFamily;
  validate: (value: string) => ValidationResult;
}

type MechanismFamily =
  | 'prompt_instruction'         // 各类 prompt 文本
  | 'subagent'                   // 子 agent 调用策略
  | 'skill_procedure'            // Skill 过程定义
  | 'tool_configuration'         // 工具配置
  | 'middleware'                 // 中间件策略
  | 'runtime_control'            // 运行时控制参数
  | 'permission_interrupt';      // 权限/审批规则

type EditableSurfaceKind =
  // prompt_instruction
  | 'skill_prompt'               // skills/<id>/SKILL.md body
  | 'skill_triggers'             // skills/<id>/SKILL.md frontmatter triggers
  | 'agent_system_prompt'        // Agent 的 system_prompt 字段
  | 'agent_role_description'     // Agent 的 description 字段
  | 'base_system_prompt'         // 全局 base layer
  | 'execution_instruction'      // agent execution instruction
  | 'failure_recovery_instruction' // agent failure recovery instruction
  | 'verification_instruction'   // agent verification instruction

  // tool_configuration
  | 'tool_description'           // ToolDefinition.description
  | 'tool_parameter_description' // ToolDefinition.parametersSchema 的 description 字段
  | 'tool_defer_strategy'        // ToolDefinition.deferrable

  // skill_procedure
  | 'skill_allowed_tools'        // skills/<id>/SKILL.md frontmatter allowed-tools
  | 'skill_memory_policy'        // skills/<id>/SKILL.md frontmatter memory

  // subagent
  | 'spawn_policy'               // team mode spawn 策略
  | 'child_agent_optimizer_rules' // ChildAgentPromptOptimizer 裁剪规则

  // middleware
  | 'turn_counter_rules'         // turn-counter 反射注入阈值
  | 'prompt_layer_priority'      // PromptManager 分层优先级

  // runtime_control
  | 'tool_execution_mode'        // parallel / sequential
  | 'max_retry_delay'            // maxRetryDelayMs
  | 'thinking_budget';           // thinkingBudgets

  // permission_interrupt
  | 'shell_approval_mode'        // strict / balanced / relaxed
  | 'approval_policy_rule';      // 审批策略规则
```

#### HarnessOptimizer 核心实现

```typescript
class HarnessOptimizer {
  /**
   * 优化入口 —— 不限定 Skill，可以针对任意可编辑表面
   */
  async optimize(context: FailureContext): Promise<ImprovementProposal | null> {
    // 1. 根据失败上下文推断涉及的可编辑表面
    const surfaces = this.identifyRelevantSurfaces(context);

    // 2. 诊断：LLM 分析根因（参考 trace.py）
    const diagnosis = await this.diagnose(context, surfaces);

    if (!diagnosis || this.isTransient(context)) return null;

    // 3. 提案：LLM 生成最小化编辑（参考 multi_proposer.py）
    const proposal = await this.propose(context, diagnosis, surfaces);

    return proposal;
  }

  private identifyRelevantSurfaces(context: FailureContext): EditableSurface[] {
    const surfaces: EditableSurface[] = [];

    // 有 Skill 上下文 → 包含 Skill 相关表面
    if (context.skillId) {
      surfaces.push(...this.getSkillSurfaces(context.skillId));
    }

    // 总是包含的全局表面（根据失败模式选择性暴露）
    if (context.pattern === 'identical_retry_loop') {
      surfaces.push(this.getSurface('failure_recovery_instruction'));
      surfaces.push(this.getSurface('tool_description'));
    }
    if (context.pattern === 'exploration_without_output') {
      surfaces.push(this.getSurface('execution_instruction'));
      surfaces.push(this.getSurface('turn_counter_rules'));
      surfaces.push(this.getSurface('spawn_policy'));
    }
    if (context.pattern === 'tool_error_cascade') {
      surfaces.push(this.getSurface('failure_recovery_instruction'));
      surfaces.push(this.getSurface('tool_execution_mode'));
    }
    if (context.pattern === 'timeout_or_abort') {
      surfaces.push(this.getSurface('max_retry_delay'));
      surfaces.push(this.getSurface('thinking_budget'));
      surfaces.push(this.getSurface('spawn_policy'));
    }

    // 有 Agent 上下文 → 包含 Agent 级别表面
    if (context.agentId && context.agentId !== 'default') {
      surfaces.push(this.getAgentSurface(context.agentId, 'agent_system_prompt'));
      surfaces.push(this.getAgentSurface(context.agentId, 'agent_role_description'));
    }

    // 即使没有 Skill 也没有特定 Agent，默认 Agent 的 system prompt 也可以是优化目标
    if (!context.skillId) {
      surfaces.push(this.getSurface('base_system_prompt'));
    }

    return surfaces;
  }
}
```

#### 提案示例（非 Skill 场景）

**示例 A：全局失败恢复指令优化**

```typescript
{
  id: "prop-abc123",
  skillId: null,                          // 非 Skill 级别
  type: "failure_recovery_instruction",
  title: "优化工具失败后的恢复策略",
  summary: "当前指令只说了不要重复相同命令，但没有给模型指明替代方向...",
  diff: {
    surface: "failure_recovery_instruction",
    field: "build_failure_recovery_instruction() 返回值",
    before: "如果一个工具调用失败，检查错误并调整；不要盲目重试相同的操作...",
    after:  "如果一个工具调用失败，检查错误并调整；不要盲目重试相同的操作。" +
            "如果命令返回 'not found'，先确认文件/设备是否存在；" +
            "如果是权限错误，尝试备选路径；" +
            "如果连续 2 次失败，立即切换到不同策略而不是微调参数。",
    rationale: "连续 4 次 adb 错误都用了相同的命令变体，缺少策略切换提示",
  },
  expectedEffect: "连续重复相同失败命令的次数从平均 4 次降到 1-2 次",
  regressionRisk: "low",
  affectedScope: "所有 Skill 的错误恢复行为",
  mechanismFamily: "prompt_instruction",
}
```

**示例 B：spawn 策略阈值调整**

```typescript
{
  id: "prop-def456",
  skillId: null,
  type: "execution_policy",
  title: "更早触发并行 spawn",
  summary: "用户在 Android 调试中执行了 12 个串行文件读取，但 turn-counter 要到 8 个才触发提醒...",
  diff: {
    surface: "turn_counter_rules",
    field: "serial tool calls 触发阈值",
    before: "serialToolCalls >= 8 → strong reflection",
    after:  "serialToolCalls >= 5 → strong reflection（大幅改善串行问题）",
    rationale: "实际观察发现，到 8 个串行时已经浪费了太多 token",
  },
  expectedEffect: "串行工具调用减少约 40%",
  regressionRisk: "low",
  affectedScope: "所有需要并行执行的任务",
  mechanismFamily: "runtime_control",
}
```

**示例 C：工具描述优化**

```typescript
{
  id: "prop-ghi789",
  skillId: null,
  type: "tool_configuration",
  title: "shell 工具描述添加路径注意事项",
  summary: "模型多次在 WSL 路径和 Windows 路径之间混淆...",
  diff: {
    surface: "tool_description",
    field: "shell 工具的 description",
    before: "Execute a shell command and return the output.",
    after:  "Execute a shell command and return the output. " +
            "IMPORTANT: This is a Linux environment. Use Linux paths (/home/..., not C:\\...).",
    rationale: "模型反复尝试 Windows 路径导致 FileNotFoundError",
  },
  expectedEffect: "路径相关错误减少约 60%",
  regressionRisk: "none",
  affectedScope: "所有使用 shell 工具的场景",
  mechanismFamily: "tool_configuration",
}
```

**示例 D：Agent system prompt 优化（用户自定义 Agent）**

```typescript
{
  id: "prop-jkl012",
  skillId: null,
  agentId: "code-reviewer",              // 特定 Agent
  type: "prompt_instruction",
  title: "优化 Code Reviewer Agent 的输出格式指令",
  summary: "Agent 经常在审查结论后追加无关的解释，导致输出冗长且重点不清晰...",
  diff: {
    surface: "agent_system_prompt",
    field: "Agent 'code-reviewer' 的 system_prompt",
    before: "You are a code reviewer. Review code changes and provide feedback. " +
            "Focus on bugs, style, and performance issues...",
    after:  "You are a code reviewer. Review code changes and provide feedback. " +
            "Focus on bugs, style, and performance issues. " +
            "CRITICAL: After listing findings, output a concise summary table. " +
            "Do NOT add commentary or suggestions beyond the findings. " +
            "Stop immediately after the summary — no closing remarks.",
    rationale: "Agent 在多次对话中输出无效的后续解释，用户反馈'说太多了'",
  },
  expectedEffect: "响应长度减少约 40%，用户满意度提升",
  regressionRisk: "low",
  affectedScope: "仅 code-reviewer Agent",
  mechanismFamily: "prompt_instruction",
}
```

**示例 E：默认 Agent 的基础行为优化**

```typescript
{
  id: "prop-mno345",
  skillId: null,
  agentId: "default",
  type: "prompt_instruction",
  title: "默认 Agent 添加工具使用指引",
  summary: "默认 Agent 面对需要工具的任务时，经常直接说'我无法做到'而不是调用工具...",
  diff: {
    surface: "agent_system_prompt",
    field: "Agent 'default' 的 system_prompt",
    before: "You are a helpful AI assistant.",
    after:  "You are a helpful AI assistant. " +
            "When a user asks you to do something that requires external information " +
            "or actions (searching, reading files, running commands), use the available " +
            "tools to fulfill the request. Do NOT say 'I cannot do that' unless you " +
            "have actually tried the relevant tool and confirmed it's impossible.",
    rationale: "多次观察到 Agent 拒绝执行可以用工具完成的任务",
  },
  expectedEffect: "任务完成率提升，'我无法做到'类拒绝减少约 70%",
  regressionRisk: "low",
  affectedScope: "默认 Agent 的所有对话",
  mechanismFamily: "prompt_instruction",
}
```

### 3.3 HarnessInteraction — 渠道无关的交互抽象

**职责**：将 `ImprovementProposal` 封装为渠道无关的交互对象，由各渠道的 `ReplyDispatcher` 自行渲染。

```typescript
// src/harness/harness-interaction.ts

/** 提案展示数据 —— 渠道无关，各渠道自行渲染 */
interface HarnessImprovementPrompt {
  id: string;                    // 提案 ID
  type: 'harness_improvement';

  /** 简短标题（用于通知栏、列表） */
  title: string;

  /** 失败简述（一句话说清楚什么问题） */
  failureSummary: string;

  /** 提案详情（Markdown 格式，内容渠道自行控制截断） */
  detail: string;

  /** diff 展示 */
  diff: {
    surface: string;             // 如 "Android Operator Skill — 执行指令"
    before: string;              // 变更前
    after: string;               // 变更后
  };

  /** 影响信息 */
  impact: {
    scope: string;               // 影响范围描述
    riskLevel: 'none' | 'low' | 'medium';
    expectedEffect: string;
  };

  /** 可用操作 */
  actions: InteractionAction[];
}

interface InteractionAction {
  id: string;                    // "approve" | "edit" | "reject" | "dismiss"
  label: string;                 // "批准并应用"
  style: 'primary' | 'default' | 'danger';
  /** 如果此操作需要额外输入，定义输入字段 */
  inputField?: {
    placeholder: string;
    multiline: boolean;
    defaultValue?: string;
  };
}
```

### 3.4 渠道渲染适配

各渠道的 `ReplyDispatcher` 在 `onComplete` 后，如果 `FailureDetector` 检测到失败条件且 `HarnessOptimizer` 生成了提案，则通过各自的原生交互方式展示。

#### 3.4.1 飞书 — 交互式卡片

使用飞书卡片消息的 `button` 组件，已有 `ApprovalCard` 可参考：

```json
{
  "header": {
    "title": { "tag": "plain_text", "content": "🔧 任务失败分析" }
  },
  "elements": [
    { "tag": "div", "text": { "tag": "lark_md", "content": "**问题**：adb 连接失败后，重复执行了 4 次相同的 connect 命令..." } },
    { "tag": "div", "text": { "tag": "lark_md", "content": "**建议**：在 Android Operator Skill 中添加设备状态检查步骤..." } },
    { "tag": "hr" },
    { "tag": "action",
      "actions": [
        { "tag": "button", "text": { "content": "✅ 批准并应用" }, "type": "primary",
          "value": { "action": "approve", "proposalId": "{proposalId}" } },
        { "tag": "button", "text": { "content": "✏️ 修改后应用" }, "type": "default",
          "value": { "action": "edit", "proposalId": "{proposalId}" } },
        { "tag": "button", "text": { "content": "❌ 拒绝" }, "type": "danger",
          "value": { "action": "reject", "proposalId": "{proposalId}" } }
      ]
    }
  ]
}
```

#### 3.4.2 WebUI — SSE 事件 + React 组件

```
SSE 事件:
  { type: 'harness_improvement', proposal: { id, title, failureSummary, detail, diff, impact, actions } }

前端组件:
  <HarnessImprovementCard>
    <header>🔧 任务失败分析</header>
    <body>{proposal.detail}</body>
    <diff-viewer before={proposal.diff.before} after={proposal.diff.after} />
    <actions>
      <Button primary onClick={approve}>✅ 批准并应用</Button>
      <Button onClick={edit}>✏️ 修改后应用</Button>
      <Button danger onClick={reject}>❌ 拒绝</Button>
    </actions>
  </HarnessImprovementCard>
```

#### 3.4.3 微信 / QQ — 文本 + 数字选项

```
🔧 任务失败分析

问题：adb 连接失败后，重复执行了 4 次相同的 connect 命令

建议修改 Android Operator Skill:
+ "adb 命令返回 'unauthorized' 时，先执行 'adb devices' 确认状态"

预期效果：相同错误减少约 80%
影响范围：仅 android-operator skill

回复操作：
1. ✅ 批准并应用
2. ✏️ 修改后应用（发送修改后的内容）
3. ❌ 拒绝
```

### 3.5 ReplyDispatcher 扩展

在 `ReplyDispatcher` 接口中新增一个可选方法：

```typescript
// src/app/types.ts — ReplyDispatcher 接口新增

export interface ReplyDispatcher {
  // ... 现有方法 ...

  /**
   * 展示 Harness 改进提案，请求用户审批。
   *
   * 实现是可选的 —— 不支持的渠道直接忽略。
   * 飞书 → 交互式卡片；WebUI → SSE event；微信/QQ → 文本+数字
   *
   * @returns 用户的审批决定 (approve | edit | reject | timeout)
   */
  requestHarnessApproval?: (
    prompt: HarnessImprovementPrompt,
    timeoutMs?: number,
  ) => Promise<ApprovalDecision>;
}

type ApprovalDecision = 'approve' | 'edit' | 'reject' | 'timeout';
```

## 4. 数据流

### 4.1 完整时序

```
User                AgentService         EventBridge         FailureDetector    HarnessOptimizer    ReplyDispatcher
 │                      │                    │                     │                   │                 │
 │── "帮我调试Android" ──→│                    │                     │                   │                 │
 │                      │── execute() ──────→│                     │                   │                 │
 │                      │                    │── agent_start ─────→│                   │                 │
 │                      │                    │── tool_start(shell)─→│                  │                 │
 │                      │                    │── tool_end(shell,✗)─→│                  │                 │
 │                      │                    │── tool_start(shell)─→│                  │                 │
 │                      │                    │── tool_end(shell,✗)─→│                  │                 │
 │                      │                    │── tool_start(shell)─→│                  │                 │
 │                      │                    │── tool_end(shell,✗)─→│                  │                 │
 │                      │                    │── tool_start(shell)─→│                  │                 │
 │                      │                    │── tool_end(shell,✗)─→│                  │                 │
 │                      │                    │── agent_end(error) ─→│                  │                 │
 │                      │                    │                      │                  │                 │
 │                      │                    │                      │── detect()       │                 │
 │                      │                    │                      │← (sig: retry-4x)│                 │
 │                      │                    │                      │                  │                 │
 │                      │                    │                      │── optimize(ctx) ──→│                 │
 │                      │                    │                      │                  │── diagnose()    │
 │                      │                    │                      │                  │← (root_cause)   │
 │                      │                    │                      │                  │── propose()     │
 │                      │                    │                      │                  │← (proposal)     │
 │                      │                    │                      │← (ImprovementProposal)              │
 │                      │                    │                      │                                        │
 │                      │                    │                      │── requestHarnessApproval(proposal) ──→│
 │  ← "🔧 失败分析卡片"  │                    │                      │                                        │
 │                      │                    │                      │                                        │
 │── tap [批准并应用] ──→│                    │                      │                                        │
 │                      │── apply(proposal)──→│                      │                                        │
 │                      │  → 更新 SKILL.md     │                      │                                        │
 │                      │  → git commit        │                      │                                        │
 │                      │                      │                      │                                        │
 │  ← "✅ 已优化" ──────│                      │                      │                                        │
```

### 4.2 触发时机

```
agent_end 事件后:

  1. FailureDetector.detect() — 检查是否满足触发条件
     ├── 不满足 → 什么都不做（开销为零）
     └── 满足 → 进入步骤 2

  2. 检查冷却期 (debounce)
     ├── 同一 Skill+Pattern 在 30 分钟内已触发过 → 跳过
     └── 冷却期外 → 进入步骤 3

  3. HarnessOptimizer.optimize() — 后台异步执行
     ├── 调用 LLM 诊断 (1 次 API 调用)
     ├── 调用 LLM 生成提案 (1 次 API 调用)
     └── 生成 ImprovementProposal

  4. ReplyDispatcher.requestHarnessApproval()
     ├── 渠道不支持 → 静默跳过
     ├── 用户批准 → 应用提案 → 更新 SKILL.md → git commit
     ├── 用户编辑 → 应用修改后的版本
     ├── 用户拒绝 → 记录拒绝原因（后续可分析改进）
     └── 超时 → 视为跳过，不阻塞用户
```

## 5. 审批策略 —— 多级灵活性

### 5.1 核心思路：匹配 + 动作

审批不是二元的"全都问"或"全都不问"，而是一组**匹配规则**，每条规则决定匹配到的提案如何处置。

```
提案生成 → 匹配规则列表（从上到下，命中即停） → 执行动作
                                                   │
                        ┌────────────────────────────┼────────────────────────────┐
                        ▼                            ▼                            ▼
                     require_approval             auto_apply                   skip
                     (弹窗询问用户)               (静默应用+监控)              (不展示不应用)
```

### 5.2 规则匹配维度

一条规则可以按以下维度的任意组合来匹配提案：

```typescript
interface ApprovalRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;

  // —— 匹配条件（AND 逻辑，留空 = 匹配所有） ——

  /** 按 Skill 匹配 */
  skillIds?: string[];                    // 精确匹配；不填 = 所有 Skill
  skillTags?: string[];                   // 按 Skill 的 tags 匹配

  /** 按 Agent 匹配 */
  agentIds?: string[];                    // 精确匹配；不填 = 所有 Agent

  /** 按 Harness 表面匹配 */
  surfaceIds?: string[];                  // 如 "failure_recovery_instruction", "turn_counter_rules"
  mechanismFamilies?: MechanismFamily[];  // 如 "prompt_instruction", "runtime_control"

  /** 按变更类型匹配 */
  changeTypes?: ('prompt_text'         // prompt 措辞修改 （含 Skill/全局/指令）
               | 'prompt_structure'    // prompt 结构/步骤调整
               | 'trigger_add'         // 添加触发词 (Skill)
               | 'trigger_remove'      // 删除触发词 (Skill)
               | 'tool_allow_add'      // 添加工具白名单 (Skill)
               | 'tool_allow_remove'   // 移除工具白名单 (Skill)
               | 'tool_desc_edit'      // 工具描述修改 (ToolDefinition)
               | 'execution_policy'    // 执行策略调整 (runtime_control)
               | 'approval_policy'     // 审批规则变更 (permission_interrupt)
               | 'numeric_threshold'   // 数值阈值调整 (turn_counter, maxRetry 等)
               | 'spawn_policy_edit'   // spawn 策略变更 (subagent)
               | 'memory_policy_edit')[]; // 记忆策略变更

  /** 按风险等级匹配 */
  riskLevels?: ('none' | 'low' | 'medium')[];

  /** 按失败模式匹配 */
  failurePatterns?: FailurePattern[];

  /** 按提案信心度匹配（LLM 自评 0-1） */
  minConfidence?: number;

  /** 按时间段匹配 */
  timeRanges?: { start: string; end: string }[];  // "09:00"-"18:00"

  /** 按影响范围匹配 */
  scopes?: ('single_skill' | 'multi_skill' | 'global')[];

  // —— 匹配后的动作 ——

  action: 'require_approval' | 'auto_apply' | 'skip';

  autoRollback?: {
    satisfactionThreshold: number;
    observationWindow: number;
    errorRateMultiplier: number;
  };
}
```

### 5.3 默认规则集（生产环境出厂配置）

```typescript
const DEFAULT_RULES: ApprovalRule[] = [
  // 规则 0: 删除类变更 — 一律审批（最高优先级，不可覆盖）
  {
    id: 'default-deny-deletion',
    name: '删除类变更必须审批',
    priority: 0,
    enabled: true,
    changeTypes: ['trigger_remove', 'tool_allow_remove', 'approval_policy'],
    action: 'require_approval',
  },

  // 规则 1: 全局影响 — 必须审批
  {
    id: 'default-global-scope',
    name: '全局影响提案必须审批',
    priority: 5,
    enabled: true,
    scopes: ['global', 'multi_skill'],
    action: 'require_approval',
  },

  // 规则 2: 高风险 — 必须审批
  {
    id: 'default-high-risk',
    name: '高风险提案必须审批',
    priority: 10,
    enabled: true,
    riskLevels: ['medium'],
    action: 'require_approval',
  },

  // 规则 3: 权限/审批类 — 必须审批（安全底线）
  {
    id: 'default-permission-sensitive',
    name: '权限与审批规则变更必须审批',
    priority: 12,
    enabled: true,
    mechanismFamilies: ['permission_interrupt'],
    action: 'require_approval',
  },

  // 规则 4: 数值阈值 — 审批（调错了影响大）
  {
    id: 'default-numeric-threshold',
    name: '数值阈值调整需审批',
    priority: 15,
    enabled: true,
    changeTypes: ['numeric_threshold'],
    action: 'require_approval',
  },

  // 规则 5: 用户不满 — 审批（用户情绪敏感，不自动操作）
  {
    id: 'default-user-dissatisfied',
    name: '用户不满触发的提案必须审批',
    priority: 20,
    enabled: true,
    failurePatterns: ['user_explicit_dissatisfied'],
    action: 'require_approval',
  },

  // 规则 6: 结构/策略变更 — 审批
  {
    id: 'default-structure-change',
    name: '结构性与策略性变更需审批',
    priority: 25,
    enabled: true,
    changeTypes: ['prompt_structure', 'execution_policy', 'spawn_policy_edit', 'memory_policy_edit'],
    action: 'require_approval',
  },

  // 规则 7: 单 Skill 低风险文本优化 + 高信心 — 自动应用 + 监控回滚
  {
    id: 'default-low-risk-auto',
    name: '单 Skill 低风险措辞/工具描述优化自动应用',
    priority: 50,
    enabled: true,
    scopes: ['single_skill'],
    changeTypes: ['prompt_text', 'trigger_add', 'tool_allow_add', 'tool_desc_edit'],
    riskLevels: ['none', 'low'],
    minConfidence: 0.8,
    action: 'auto_apply',
    autoRollback: {
      satisfactionThreshold: 0.6,
      observationWindow: 50,
      errorRateMultiplier: 2.0,
    },
  },

  // 规则 8: 兜底 — 其他情况询问用户
  {
    id: 'default-fallback',
    name: '其他情况需审批',
    priority: 100,
    enabled: true,
    action: 'require_approval',
  },
];
```

### 5.4 用户自定义规则示例

**场景 A：完全信任某个 Skill**

```yaml
rules:
  - name: "Android Operator 全自动"
    priority: 8
    skillIds: ["android-operator"]
    action: auto_apply
    autoRollback:
      satisfactionThreshold: 0.5
      observationWindow: 30
```

**场景 B：全局指令类优化自动应用（信任 Harness 层的 prompt 调整）**

```yaml
rules:
  - name: "全局 failure_recovery 和 execution 指令自动优化"
    priority: 18
    surfaceIds: ["failure_recovery_instruction", "execution_instruction"]
    changeTypes: ["prompt_text"]
    riskLevels: ["low"]
    action: auto_apply
    autoRollback:
      satisfactionThreshold: 0.6
      observationWindow: 100
```

**场景 C：默认 Agent 的 prompt 自动优化，其他 Agent 手动审批**

```yaml
rules:
  - name: "默认 Agent 自动优化"
    priority: 8
    agentIds: ["default"]
    mechanismFamilies: ["prompt_instruction"]
    changeTypes: ["prompt_text"]
    riskLevels: ["low"]
    action: auto_apply
    autoRollback:
      satisfactionThreshold: 0.6
      observationWindow: 50

  - name: "自定义 Agent 必须审批"
    priority: 9
    agentIds: ["*"]           # 所有非 default 的 Agent
    excludeAgentIds: ["default"]
    action: require_approval
```

**场景 D：禁用运行时参数的自动优化（手动调优的参数）**

```yaml
rules:
  - name: "运行时参数手动维护"
    priority: 3
    mechanismFamilies: ["runtime_control"]
    action: skip
```

**场景 D：按时间段区分 —— 工作时间审批，非繁忙时段自动**

```yaml
rules:
  - name: "非工作时间自动应用低风险优化"
    priority: 35
    riskLevels: ["low"]
    timeRanges: [{ start: "22:00", end: "08:00" }]
    action: auto_apply
```

### 5.5 运行时行为

```
提案生成
    │
    ▼
  ApprovalPolicy.evaluate(proposal)
    │
    ├── 遍历规则列表（按 priority 升序）
    │   ├── 规则 0 匹配？→ action = require_approval → 弹窗
    │   ├── ...中间规则...
    │   ├── 规则 4 匹配？→ action = auto_apply → 静默应用
    │   └── 规则 5 匹配？→ action = require_approval → 弹窗
    │
    ├── require_approval:
    │   → ReplyDispatcher.requestHarnessApproval()
    │   → 用户看到卡片 / 按钮
    │   → 用户可选择：批准 / 编辑 / 拒绝 / 忽略(超时)
    │   → 批准或编辑后 → SkillEditor.apply()
    │
    ├── auto_apply:
    │   → SkillEditor.apply()
    │   → 回复中附加一行小字："🔧 已自动优化 {skillId} 的处理方式 · 撤销"
    │   → 启动监控：接下来 {observationWindow} 次激活跟踪指标
    │   → 若指标劣化 → 自动回滚 + 通知用户
    │
    └── skip:
        → 什么都不做，静默丢弃
```

### 5.6 auto_apply 的监控与自动回滚

这是自动应用的安全网——不依赖用户审批，但依赖数据：

```typescript
class AutoApplyMonitor {
  /** 应用提案后调用，启动观察窗口 */
  watch(proposalId: string, skillId: string, config: AutoRollbackConfig): void {
    const startMetrics = SkillMetricsService.getStats(skillId);
    // 在内存中注册观察任务
    this.activeMonitors.set(proposalId, {
      skillId,
      startMetrics,
      config,
      appliedAt: Date.now(),
      activationCount: 0,
    });
  }

  /** 每次该 Skill 被激活完成时调用 */
  onActivationComplete(skillId: string, result: ActivationResult): void {
    for (const [proposalId, monitor] of this.activeMonitors) {
      if (monitor.skillId !== skillId) continue;
      monitor.activationCount++;

      if (monitor.activationCount >= monitor.config.observationWindow) {
        this.evaluate(proposalId, monitor);
      }
    }
  }

  private evaluate(proposalId: string, monitor: ActiveMonitor): void {
    const current = SkillMetricsService.getStats(monitor.skillId);
    const oldRate = monitor.startMetrics.successRate ?? 1;
    const newRate = current.successRate ?? 1;

    // 条件 1: 满意度下降超过阈值
    if (newRate < monitor.config.satisfactionThreshold * oldRate) {
      this.rollback(proposalId, monitor,
        `满意度从 ${(oldRate*100).toFixed(0)}% 降至 ${(newRate*100).toFixed(0)}%`);
      return;
    }

    // 条件 2: 错误率显著上升
    const oldErrorRate = monitor.startMetrics.errorRate ?? 0;
    const newErrorRate = current.errorRate ?? 0;
    if (newErrorRate > monitor.config.errorRateMultiplier * oldErrorRate) {
      this.rollback(proposalId, monitor,
        `错误率从 ${(oldErrorRate*100).toFixed(0)}% 升至 ${(newErrorRate*100).toFixed(0)}%`);
      return;
    }

    // 通过观察 → 永久保留
    this.activeMonitors.delete(proposalId);
  }

  private rollback(proposalId: string, monitor: ActiveMonitor, reason: string): void {
    // git revert 对应的 commit
    // 通知用户
    // 将规则自动降级为 require_approval
  }
}
```

### 5.7 用户交互中的"信任升级"路径

除了静态规则，还可以在用户审批时动态收集偏好：

```
审批卡片上除了 [批准] [编辑] [拒绝]，还有额外的意图按钮：

┌────────────────────────────────────────────────┐
│  🔧 任务失败分析                                │
│                                                │
│  问题：adb 连接失败后重复执行 4 次相同命令        │
│  建议：添加设备状态检查步骤                       │
│                                                │
│  [✅ 批准并应用]  [✏️ 修改]  [❌ 拒绝]           │
│                                                │
│  ☐ 以后 android-operator 的优化自动应用，不再询问       │
│  ☐ 以后「重复命令失败」这类问题的优化自动应用，不再询问       │
└────────────────────────────────────────────────┘
```

用户勾选后，系统自动添加一条对应的 `ApprovalRule`：

```typescript
// 用户勾选 "android-operator 自动应用"
{
  id: 'user-auto-android-operator',
  name: '用户设定: android-operator 自动应用',
  priority: 15,
  skillIds: ['android-operator'],
  action: 'auto_apply',
  autoRollback: { satisfactionThreshold: 0.5, observationWindow: 30 },
}

// 用户勾选 "重复命令失败这类自动应用"
{
  id: 'user-auto-retry-loop',
  name: '用户设定: 重复命令失败自动应用',
  priority: 25,
  failurePatterns: ['identical_retry_loop'],
  changeTypes: ['prompt_text'],
  action: 'auto_apply',
  autoRollback: { satisfactionThreshold: 0.6, observationWindow: 50 },
}
```

### 5.8 生产安全保障

```
1. 所有变更都是 git 记录的（可追溯、可回滚）
2. 提案只改 SKILL.md 的 body 或 frontmatter 字段（不影响代码逻辑）
3. 删除类变更默认必须审批（规则 0，priority 最高不可覆盖）
4. 工具白名单只允许添加不允许删除（防止能力退化）
5. auto_apply 提案始终有观察窗口 + 自动回滚
6. 提案生成时使用的 LLM 是只读的——它只能产出文本建议
7. 应用前通过 skill-linter 校验合法性
8. 全局 daily limit 对 auto_apply 同样生效（防止失控）
```

## 6. Token 开销估算

### 6.1 单次交互式 Self-Harness

| 阶段 | LLM 调用 | 输入 Token | 输出 Token | 说明 |
|------|---------|-----------|-----------|------|
| 触发判断 | 0 | 0 | 0 | 纯规则判断，无 LLM 调用 |
| 诊断 | 1 次 | ~3K-5K | ~500-800 | 分析工具调用轨迹 + 分类失败模式 |
| 提案生成 | 1 次 | ~4K-6K | ~300-500 | 包含诊断结果 + 当前 Skill prompt |
| **单次总计** | **2 次** | **~7K-11K** | **~800-1.3K** | **~$0.02-0.05（Haiku）/ ~$0.10-0.30（Sonnet）** |

### 6.2 月度估算

假设条件：
- 每天 100 次对话
- 其中 20% 触发失败检测（20 次）
- 其中 50% 通过冷却和重复过滤（10 次）
- 触发频率上限：每小时最多 2 次，每天最多 10 次
- 每次 2 次 LLM 调用

```
月度额外 token: 10 次/天 × 30 天 × 10K tokens = 3M tokens
月度额外费用: ~$1.5-3（Haiku）/ ~$8-15（Sonnet）
```

### 6.3 潜在 token 节省（ROI）

优化后的 Harness 减少了无效的工具调用和重试：

| 优化效果 | 节省 token |
|---------|-----------|
| 减少 3 次重复失败命令（每次 ~2K） | -6K tokens |
| 减少 5 步不必要的探索（每步 ~1K） | -5K tokens |
| 总计每次有效优化 | ~11K tokens 节省 |

**ROI 结论**：一次优化消耗 ~10K tokens，但如果避免了未来 2 次以上同样的失败模式，就已回本。对于高频 Skill，ROI 显著为正。

## 7. 实现路线

### Phase 1: 最小可用版 (3-5 天)

```
目标：WebUI 端到端跑通，能展示提案并审批

  □ 1.1 FailureDetector — 检测失败信号（纯规则，无 LLM）
  □ 1.2 HarnessOptimizer — LLM 诊断 + 生成提案
  □ 1.3 WebUI SSE 事件 + HarnessImprovementCard 组件
  □ 1.4 SkillEditor.apply() — 更新 SKILL.md + git commit
  □ 1.5 手动测试：故意制造失败 → 触发分析 → 审批 → 应用
```

### Phase 2: 渠道适配 (3-5 天)

```
  □ 2.1 飞书 ReplyDispatcher 适配（扩展 requestHarnessApproval）
  □ 2.2 微信/QQ 文本模式适配
  □ 2.3 所有渠道统一 i18n（zh-CN + en）
  □ 2.4 渠道级配置：是否启用、冷却期、触发阈值
```

### Phase 3: 智能化增强 (5-8 天)

```
  □ 3.1 冷却期管理 — 同一模式 30min 内不重复询问
  □ 3.2 用户偏好学习 — "这类失败以后自动优化"
  □ 3.3 提案质量评分 — LLM 自评信心度，低信心提案不展示
  □ 3.4 批量模式 — 每周自动扫描高失败率 Skill，生成汇总报告
  □ 3.5 提案历史看板 — WebUI 中查看优化历史和效果趋势
```

## 8. 配置项

### 8.1 config.yaml 配置

```yaml
# config.yaml 新增
harness:
  interactive:
    enabled: true               # 总开关
    channels:
      webui: true
      feishu: true
      telegram: true
      wechat: false
      qq: false
    trigger:
      minIdenticalRetries: 3
      minExplorationSteps: 8
      minConsecutiveErrors: 3
    rateLimit:
      cooldownMinutes: 30       # 同一 Skill+模式 冷却期
      maxPerHour: 2             # 全局每小时上限
      maxPerDay: 10             # 全局每天上限（包含 auto_apply）
    proposal:
      model: "default"          # 生成提案用的模型
      maxEditsPerProposal: 5
    safety:
      allowDeleteRules: false   # 禁止删除现有规则
      skippableRules: false     # 用户能否添加 skip 规则
      maxAutoApplyPerDay: 5     # auto_apply 每天上限

    # 审批规则列表（从上到下匹配，命中即停）
    rules:
      - id: default-deny-deletion
        name: "删除类变更必须审批"
        priority: 0
        enabled: true
        changeTypes: [trigger_remove, tool_allow_remove, approval_override]
        action: require_approval

      - id: default-high-risk
        name: "高风险提案必须审批"
        priority: 10
        enabled: true
        riskLevels: [medium]
        action: require_approval

      - id: default-user-dissatisfied
        name: "用户不满触发的提案必须审批"
        priority: 20
        enabled: true
        failurePatterns: [user_explicit_dissatisfied]
        action: require_approval

      - id: default-structure-change
        name: "Prompt 结构调整需审批"
        priority: 30
        enabled: true
        changeTypes: [prompt_structure, execution_policy]
        action: require_approval

      - id: default-low-risk-auto
        name: "低风险措辞优化自动应用"
        priority: 50
        enabled: true
        changeTypes: [prompt_text, trigger_add, tool_allow_add]
        riskLevels: [none, low]
        minConfidence: 0.8
        action: auto_apply
        autoRollback:
          satisfactionThreshold: 0.6
          observationWindow: 50
          errorRateMultiplier: 2.0

      - id: default-fallback
        name: "其他情况需审批"
        priority: 100
        enabled: true
        action: require_approval
```

### 8.2 WebUI 设置集成

#### 8.2.1 标签页位置

Self-Harness 作为独立一级标签 `harness`，插入在 `agents` 和 `channels` 之间：

```
侧边栏:
  General    (通用)
  Models     (模型)
  Agents     (智能体)
→ Harness    (自动优化)  ← 新增
  Channels   (通道)
  Tools      (工具策略)
  Web Search (网络搜索)
  Memory     (记忆)
  Multimodal (多模态)
  ...
```

放在 Agents 之后、Channels 之前的理由：优化对象是 Agents 和 Skills，紧邻 Agents 标签符合用户心智模型；与 Channels 同属"运行时行为配置"，逻辑上相邻。

#### 8.2.2 页面布局

Harness 设置页采用五个功能区段，从总到分，从常用到高级：

```
┌─────────────────────────────────────────────────────────┐
│  ⚙️ 自动优化 (Harness)                                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ① 总开关                                                │
│     [启用自动优化]  ● 开启  ○ 关闭                         │
│     Agent 任务失败时，自动分析原因并建议优化方案              │
│                                                         │
│  ② 触发条件                                               │
│     重复相同失败命令 ≥ [3] 次                               │
│     连续探索无产出   ≥ [8] 步                               │
│     连续工具执行错误 ≥ [3] 次                               │
│     冷却期: 同一问题 [30] 分钟内不重复询问                    │
│                                                         │
│  ③ 审批策略                                    ┌─ 预设 ─┐ │
│     ○ 总是询问（每次弹窗确认）                      │        │
│     ● 智能审批（按规则自动决定）← 默认              │        │
│     ○ 低风险自动（激进的自动应用）                   └────────┘ │
│                                                         │
│     说明: 智能审批会根据风险等级、影响范围和失败类型自动        │
│     决定是否需要审批。低风险的措辞优化通常会静默应用           │
│     （60 次内效果不佳会自动撤销），删除规则或全局变更始终       │
│     需要你确认。                                            │
│                                                         │
│     [管理自定义规则 →]  点击展开规则编辑面板                   │
│                                                         │
│  ④ 速率限制                                               │
│     每日最多 [10] 次    每小时最多 [2] 次                    │
│     提案生成模型: [默认模型 ▾]                               │
│                                                         │
│                               [恢复默认]  [保存设置]        │
└─────────────────────────────────────────────────────────┘
```

#### 8.2.3 审批策略的三种预设

预设模式是对底层规则引擎的用户友好封装：

| 预设 | 内部行为 | 适合 |
|------|---------|------|
| **总是询问** | 跳过所有 auto_apply 规则，全部走 require_approval | 不信任自动变更 |
| **智能审批**（默认） | 使用出厂规则表，低风险单 Skill 优化自动，其余询问 | 大多数用户 |
| **低风险自动** | 所有 L1+L2 提案 auto_apply（均带观察窗口），仅 L3 询问 | 追求效率 |

预设本质上是对规则表的快捷操作——"总是询问"其实就是把所有规则的 action 临时覆盖为 `require_approval`。"智能审批"才是暴露规则表完整能力的模式。

#### 8.2.4 自定义规则管理

点击"管理自定义规则"展开内联表格：

```
┌───────────────────────────────────────────────────────────────────────┐
│  审批规则                                       [+ 添加规则]  [恢复默认]  │
├───────────────────────────────────────────────────────────────────────┤
│  #   匹配条件                          动作            状态            │
│ ─── ──────────────────────────────── ─────────────── ──────────────  │
│  0   删除类变更 / 权限变更              必须审批        🔒 系统         │
│  5   全局 / 多 Skill 影响              必须审批        🔒 系统         │
│  10  中风险提案                        必须审批        ⚙️ 可调        │
│  25  结构性 / 策略性变更               必须审批        ⚙️ 可调        │
│  50  单 Skill 低风险措辞/工具描述优化   自动应用        ⚙️ 可调        │
│ 100  其他所有                         必须审批        ⚙️ 可调        │
│ ─── ──────────────────────────────── ─────────────── ──────────────  │
│  +  Android Operator 全自动           自动应用        👤 自定义  [✕]   │
│  +  非工作时间低风险自动              自动应用        👤 自定义  [✕]   │
└───────────────────────────────────────────────────────────────────────┘
```

点击 [+ 添加规则] 弹出表单：

```
┌──────────────────────────────────────────────────────┐
│  添加审批规则                                    [✕]  │
│                                                      │
│  名称: [________________________________]             │
│                                                      │
│  匹配条件（留空 = 不限制）:                              │
│    Skill:     [全部 ▾] 可多选                          │
│    Agent:     [全部 ▾] 可多选                          │
│    表面类型:   [全部 ▾]                                │
│    变更类型:   ☑ prompt措辞  ☐ 结构调整  ☐ 触发词      │
│               ☐ 工具白名单  ☐ 工具描述  ☐ 数值阈值     │
│               ☐ 权限变更   ☐ spawn策略                │
│    风险等级:   ☑ 无  ☑ 低  ☐ 中                       │
│    失败模式:   [全部 ▾]                                │
│    提案信心度 ≥ [80]%                                  │
│    影响范围:   ☑ 单Skill  ☐ 多Skill  ☐ 全局           │
│    时间段(可选):[____] — [____]                        │
│                                                      │
│  匹配后动作:                                           │
│    ● 必须审批 (require_approval)                       │
│    ○ 自动应用 + 监控回滚 (auto_apply)                   │
│    ○ 不展示也不应用 (skip)                              │
│                                                      │
│  自动回滚条件 (仅自动应用时):                            │
│    观察窗口: [50] 次激活                                │
│    满意度阈值: 低于 [60]% 时回滚                         │
│    错误率倍数: 超过 [2.0] 倍时回滚                       │
│                                                      │
│                              [取消]  [添加规则]         │
└──────────────────────────────────────────────────────┘
```

#### 8.2.5 在 Agent 编辑器中集成

除了全局 Harness 设置页，每个 Agent 的编辑器中新增一个开关：

```
┌──────────────────────────────────────────────────────┐
│  ✏️ 编辑 Agent: code-reviewer                         │
│                                                      │
│  名称:       [code-reviewer________________]          │
│  描述:       [代码审查助手________________]            │
│  系统提示词: [You are a code reviewer. Focus on...]   │
│  模型:       [Claude Sonnet ▾]                        │
│  ───────────────────────────────────────────────     │
│  🔧 自动优化:                                         │
│  ☑ 允许自动优化此 Agent 的提示词                        │
│    任务失败时，分析原因并建议改进方案                     │
│  ───────────────────────────────────────────────     │
│  工具配置 / 通道绑定 / ...                              │
└──────────────────────────────────────────────────────┘
```

这个开关对应审批规则中的 `agentIds` 维度。关闭后相当于自动插入一条 `agentIds: ["code-reviewer"], action: skip` 规则。

#### 8.2.6 字段 → config 路径映射

> **注意**：通知渠道区域已在实施中移除。Harness 通知通过 `ReplyDispatcher` 自动路由到任务发起渠道，无需手动配置。

| WebUI 控件 | config.yaml 路径 |
|-----------|-----------------|
| 总开关 | `harness.interactive.enabled` |
| 触发阈值 | `harness.trigger.minIdenticalRetries` |
| 触发阈值 | `harness.trigger.minExplorationSteps` |
| 触发阈值 | `harness.trigger.minConsecutiveErrors` |
| 冷却期 | `harness.rateLimit.cooldownMinutes` |
| 每日上限 | `harness.rateLimit.maxPerDay` |
| 每小时上限 | `harness.rateLimit.maxPerHour` |
| 提案模型 | `harness.proposal.model`（自由文本 Input，留空=系统默认，或输入 `provider/modelId`） |
| 审批预设 | UI 层映射到 rules 数组的操作 |
| 自定义规则 | 点击弹出"即将上线" Toast |
| Agent 级开关 | 转换为一组 `agentIds` 规则 |

#### 8.2.7 设置页实现要点

```typescript
// SettingsModal.tsx — SETTINGS_GROUPS 新增
{ id: 'harness', labelKey: 'settings.groups.harness' },

// COMPONENT_MAP 新增
harness: HarnessSettings,

// HarnessSettings.tsx 遵循现有 tab 模式
// - useConfigDirty(harness) hook → getField / setField
// - 规则编辑器作为子组件 <ApprovalRulesEditor />
// - 保存/取消通过 registerHandle 对接
// - 无需重启（规则变更即时生效）
```

新增 i18n key（zh-CN）：
```json
{
  "settings.groups.harness": "自动优化",
  "settings.harness.enabled": "启用自动优化",
  "settings.harness.enabledDesc": "Agent 任务失败时，自动分析原因并建议优化方案",
  "settings.harness.channels": "通知渠道",
  "settings.harness.channelsDesc": "在哪些渠道展示优化建议",
  "settings.harness.triggers": "触发条件",
  "settings.harness.identicalRetries": "重复相同失败命令触发阈值",
  "settings.harness.explorationSteps": "仅探索无产出触发阈值",
  "settings.harness.consecutiveErrors": "连续工具错误触发阈值",
  "settings.harness.cooldown": "冷却期（分钟）",
  "settings.harness.cooldownDesc": "同一问题在此时间内不再重复询问",
  "settings.harness.approval": "审批策略",
  "settings.harness.approvalAlways": "总是询问",
  "settings.harness.approvalAlwaysDesc": "每次优化建议都需要你确认",
  "settings.harness.approvalSmart": "智能审批",
  "settings.harness.approvalSmartDesc": "低风险优化自动应用，全局变更或高风险操作仍需确认",
  "settings.harness.approvalAuto": "低风险自动",
  "settings.harness.approvalAutoDesc": "多数优化自动应用（带监控回滚），仅安全底线需要确认",
  "settings.harness.rules": "自定义审批规则",
  "settings.harness.addRule": "添加规则",
  "settings.harness.rateLimit": "速率限制",
  "settings.harness.maxPerDay": "每日最多优化次数",
  "settings.harness.maxPerHour": "每小时最多优化次数",
  "settings.harness.proposalModel": "提案生成模型",
  "settings.harness.agentOptIn": "允许自动优化此 Agent 的提示词",
  "settings.harness.agentOptInDesc": "任务失败时，分析原因并建议改进方案"
}
```

## 9. 关键设计决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| 触发时机 | agent_end 后异步，不阻塞响应 | 用户已收到回复，分析延迟不可感知 |
| 用户交互 | 主动推送，但有限速 | 过度询问会骚扰用户，需冷却和上限 |
| LLM 选型 | 默认用 Haiku，可配 Sonnet | 诊断和提案都是结构化输出任务，小模型足够 |
| 渠道抽象 | ReplyDispatcher 新增可选方法 | 最小侵入，向后兼容，不支持的渠道自然降级 |
| Harness 范围 | Skill → Agent → 全局三层 | 从最安全的单 Skill 开始，延伸到 Agent 和全局策略 |
| 审批模式 | 规则匹配 + 动作执行 | 可按 Skill/Agent/表面/类型/风险/信心度精细控制 |
