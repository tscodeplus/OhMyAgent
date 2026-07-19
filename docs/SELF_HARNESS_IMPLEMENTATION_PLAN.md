# 交互式 Self-Harness 实施方案

> 基于设计文档 `SELF_HARNESS_INTERACTIVE_DESIGN.md`
> 开始日期：2026-07-19
> 总工期预估：12-17 个工作日

---

## 目录

1. [目标与成功标准](#1-目标与成功标准)
2. [总体分工](#2-总体分工)
3. [Phase 0：基础设施（类型与配置）](#phase-0-基础设施类型与配置)
4. [Phase 1：核心引擎](#phase-1-核心引擎)
5. [Phase 2：运行时集成](#phase-2-运行时集成)
6. [Phase 3：WebUI 设置页](#phase-3-webui-设置页)
7. [Phase 4：WebUI 交互卡片 + SSE](#phase-4-webui-交互卡片--sse)
8. [Phase 5：渠道渲染（飞书/微信/QQ/Telegram）](#phase-5-渠道渲染飞书微信qqtelegram)
9. [Phase 6：打磨与测试](#phase-6-打磨与测试)
10. [风险与缓解](#10-风险与缓解)
11. [验收矩阵](#11-验收矩阵)

---

## 1. 目标与成功标准

### 1.1 总体目标

将 Self-Harness 三阶段循环（失败检测 → 诊断提案 → 用户审批）嵌入 OhMyAgent 运行时，在真实任务失败时自动触发优化建议，并通过各渠道统一交互。

### 1.2 成功标准（可验收）

| ID | 标准 | 验收方式 |
|----|------|---------|
| SC1 | 连续 3 次相同命令失败后，WebUI 出现 Harness 优化卡片 | 手动测试 |
| SC2 | 用户点击"批准并应用"后，对应 Skill/Agent 配置被修改并 git commit | 检查 git log |
| SC3 | 同一 Skill + Pattern 30 分钟内不重复触发 | 日志检查 |
| SC4 | 低风险单 Skill 措辞优化（auto_apply）静默应用，观察窗口后自动提交或回滚 | 日志检查 |
| SC5 | 飞书卡片、WebUI SSE、微信文本三种渠道均能展示提案并接受审批 | 手动测试 |
| SC6 | WebUI 设置页中 Harness 标签页完整可用（开关/触发条件/审批预设/规则编辑器） | 手动测试 |
| SC7 | 所有用户可见字符串支持 zh-CN 和 en | grep locales |
| SC8 | `pnpm test:ai` 全部通过 | CI |
| SC9 | 删除类变更在任何规则下都需审批 | 单元测试 |

---

## 2. 总体分工

### 2.1 Phase 概览

```
Phase 0: 基础设施     ██░░░░░░░░░░  1-2 天  类型定义 + 配置 schema + config.yaml
Phase 1: 核心引擎     ████░░░░░░░░  3-4 天  FailureDetector + HarnessOptimizer + SkillEditor
Phase 2: 运行时集成   ███░░░░░░░░░  2-3 天  AgentService 嵌入 + ReplyDispatcher 扩展
Phase 3: WebUI 设置   ████░░░░░░░░  3-4 天  HarnessSettings 标签页 + 规则编辑器 + Agent toggle
Phase 4: WebUI 交互   ███░░░░░░░░░  2-3 天  HarnessImprovementCard + SSE 事件
Phase 5: 渠道渲染     ███░░░░░░░░░  3-4 天  飞书卡片 / 微信文本 / QQ / Telegram
Phase 6: 打磨测试     ██░░░░░░░░░░  2-3 天  集成测试 + 手动测试 + i18n
                   ─────────────────────
                   总计 16-23 天 ≈ 3-5 周
```

### 2.2 依赖关系

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 4 (WebUI 交互卡片)
                │            │
                │            └──────→ Phase 5 (渠道渲染，可与 Phase 4 并行)
                │
                └──────→ Phase 3 (WebUI 设置，可与 Phase 2 并行)
                              │
                              └──────→ Phase 6 (测试，依赖所有 Phase)
```

---

## Phase 0：基础设施（类型与配置）

**工期**：1-2 天
**目标**：所有类型定义和配置 schema 就位，后续 Phase 可直接引用。

### Task 0.1：创建核心类型文件

**文件**：`src/harness/types.ts`（新建）

**产出**：
```typescript
// 所有在设计文档中定义的类型，包括但不限于：
- FailureContext, FailureSignal, FailurePattern
- MechanismFamily, EditableSurfaceKind, EditableSurface
- ImprovementProposal, ProposalDiff, ProposalImpact
- HarnessImprovementPrompt, InteractionAction
- ApprovalRule, AutoRollbackConfig
- ApprovalDecision ('approve' | 'edit' | 'reject' | 'timeout')
- DiagnosisResult, ProposalGenerationResult
```

**验收**：
- [ ] `src/harness/types.ts` 文件存在且类型完整
- [ ] 与设计文档第 3 章所有接口一一对应
- [ ] TypeScript 编译通过 (`pnpm build`)

### Task 0.2：扩展 AppConfig 和 Config schema

**文件**：
- `src/app/types.ts` — `AppConfig` 接口新增 `harness` 字段
- `src/app/config.ts` — zod schema 新增 `harness` 段
- `config.yaml` — 添加 harnees 配置段（带出厂默认值）

**产出**：
```typescript
// AppConfig 新增
harness?: {
  interactive: {
    enabled: boolean;
    channels: { webui: boolean; feishu: boolean; telegram: boolean; wechat: boolean; qq: boolean };
    trigger: { minIdenticalRetries: number; minExplorationSteps: number; minConsecutiveErrors: number };
    rateLimit: { cooldownMinutes: number; maxPerHour: number; maxPerDay: number; maxAutoApplyPerDay: number };
    proposal: { model: string; maxEditsPerProposal: number };
    rules: ApprovalRuleConfig[];
  };
};
```

**zod schema 要点**：
- `harness.interactive.enabled` 默认 `true`
- `harness.interactive.channels` 默认 `{ webui: true, feishu: true, telegram: true, wechat: false, qq: false }`
- `harness.interactive.trigger` 默认 `{ minIdenticalRetries: 3, minExplorationSteps: 8, minConsecutiveErrors: 3 }`
- `harness.interactive.rateLimit` 默认 `{ cooldownMinutes: 30, maxPerHour: 2, maxPerDay: 10, maxAutoApplyPerDay: 5 }`
- `harness.interactive.proposal.model` 默认 `"default"`
- `harness.interactive.rules` 默认出厂规则数组（设计文档 5.3 节）

**验收**：
- [ ] `config.yaml` 包含完整的 `harness` 段
- [ ] `loadConfig()` 能正确解析新配置
- [ ] `pnpm test:ai` 通过（现有测试不受影响）
- [ ] 不填 `harness` 段时使用出厂默认值（向后兼容）

### Task 0.3：扩展 ReplyDispatcher 接口

**文件**：`src/app/types.ts`

**产出**：
```typescript
// ReplyDispatcher 接口新增可选方法
export interface ReplyDispatcher {
  // ... 现有方法保持不变 ...

  /** 展示 Harness 改进提案，请求用户审批（可选） */
  requestHarnessApproval?: (
    prompt: HarnessImprovementPrompt,
    timeoutMs?: number,
  ) => Promise<'approve' | 'edit' | 'reject' | 'timeout'>;
}
```

**验收**：
- [ ] 现有 ReplyDispatcher 实现（Feishu/WebUI/Telegram/WeChat/QQ）编译不受影响
- [ ] 不实现该方法的渠道行为不变（可选方法）

### Task 0.4：扩展 AgentConfig 接口

**文件**：
- `src/app/types.ts` — `AgentConfig` 接口
- `ui/src/types/agent.ts` — `Agent` 接口
- `ui/src/types/config.ts` — `AgentConfig` 接口

**产出**：
```typescript
// AgentConfig / Agent 新增可选字段
{
  // ... 现有字段 ...
  harness?: {
    enabled: boolean;  // 是否允许自动优化此 Agent，默认 true
  };
}
```

**验收**：
- [ ] TypeScript 编译通过
- [ ] AgentEditor 组件不受影响（新增可选字段）

---

## Phase 1：核心引擎

**工期**：3-4 天
**目标**：FailureDetector + HarnessOptimizer + SkillEditor + ApprovalPolicy 全部实现并通过单元测试。

### Task 1.1：FailureDetector 实现

**文件**：`src/harness/failure-detector.ts`（新建）

**职责**：纯规则判断，零 LLM 开销。在 agent_end 后分析工具调用序列，决定是否触发优化。

**实现要点**：

```typescript
export class FailureDetector {
  constructor(private config: HarnessTriggerConfig) {}

  detect(context: FailureContext): FailureSignal | null {
    // 排除信号
    if (context.toolCalls.length === 0) return null;
    if (context.userFeedback === 'satisfied') return null;

    // 1. identical_retry_loop: 相同命令+错误 ≥ 3 次
    // 2. exploration_without_output: 连续 explore ≥ 8 步且 change 为 0
    // 3. tool_error_cascade: 连续工具错误 ≥ 3 次
    // 4. user_explicit_dissatisfied: userFeedback === 'dissatisfied'
    // 5. timeout_or_abort: terminatedEarly === true
    // 优先级：1 > 3 > 4 > 2 > 5（高严重度优先）
  }
}
```

**参考现有代码**：
- `src/agent/turn-counter.ts` 的 burst/串行检测逻辑已有工具调用分析
- `src/skills/skill-evolution/skill-metrics.ts` 的 `inferSatisfaction()` 方法

**验收**：
- [ ] 单元测试：5 种失败模式各 ≥ 2 个 test case（正常触发 + 边界不触发）
- [ ] 单元测试：空 toolCalls 不触发
- [ ] 单元测试：userFeedback='satisfied' 不触发
- [ ] 提供 `detectFromAgentEvents(events: AgentEvent[]): FailureSignal | null` 便捷方法

**测试文件**：`tests/harness/failure-detector.test.ts`

### Task 1.2：冷却期与限流管理

**文件**：`src/harness/rate-limiter.ts`（新建）

**职责**：
- 记录每次触发的 (skillId, agentId, pattern) 三元组
- 冷却期内同一模式不重复触发
- 全局每小时/每天计数

```typescript
export class HarnessRateLimiter {
  constructor(private config: HarnessRateLimitConfig) {}

  /** 检查是否可以触发。如果可以，记录本次触发并返回 true。 */
  canTrigger(skillId: string | undefined, agentId: string | undefined, pattern: FailurePattern): boolean;

  /** 获取当前小时的触发次数 */
  getHourlyCount(): number;
  /** 获取当前天的触发次数 */
  getDailyCount(): number;
  /** 获取当前天的 auto_apply 次数 */
  getAutoApplyCount(): number;
  /** 记录一次 auto_apply */
  recordAutoApply(): void;
}
```

**验收**：
- [ ] 单元测试：冷却期内重复触发被拒绝
- [ ] 单元测试：冷却期过后可以再次触发
- [ ] 单元测试：每小时/每天上限生效
- [ ] 单元测试：不同 Skill 的冷却期独立

**测试文件**：`tests/harness/rate-limiter.test.ts`

### Task 1.3：HarnessOptimizer 实现（核心）

**文件**：`src/harness/harness-optimizer.ts`（新建）

**职责**：根据失败信号和上下文，调用 LLM 进行诊断和提案生成。

**实现要点**：

```typescript
export class HarnessOptimizer {
  constructor(
    private config: HarnessProposalConfig,
    private llmCaller: (systemPrompt: string, messages: any[], tools?: any[]) => AsyncIterable<any>,
    private surfaceProvider: EditableSurfaceProvider,
  ) {}

  async optimize(context: FailureContext): Promise<ImprovementProposal | null> {
    // 1. 识别相关可编辑表面
    const surfaces = this.surfaceProvider.identifyRelevantSurfaces(context);

    // 2. 诊断：构建提示词 → 调用 LLM → 解析根因
    const diagnosis = await this.diagnose(context, surfaces);
    if (!diagnosis || this.isTransient(diagnosis)) return null;

    // 3. 提案：构建提示词 → 调用 LLM → 解析提案
    const proposal = await this.propose(context, diagnosis, surfaces);

    return proposal;
  }

  private async diagnose(context: FailureContext, surfaces: EditableSurface[]): Promise<DiagnosisResult | null>;
  private async propose(context: FailureContext, diagnosis: DiagnosisResult, surfaces: EditableSurface[]): Promise<ImprovementProposal | null>;
  private isTransient(diagnosis: DiagnosisResult): boolean;
}
```

**LLM 提示词设计**（参考 Self-Harness 源码）：

诊断提示词结构：
```
System: You are a harness failure analyst. Analyze the agent execution trace
        and identify the root cause of the failure.

输入:
- 用户原始需求
- 工具调用序列（名称 + 参数摘要 + 结果/错误）
- 涉及的 Skill/Agent 信息
- 当前可编辑表面列表（名称 + 当前值）

输出 (JSON):
{
  "terminal_cause": "missing_dependency | tool_error_loop | exploration_stuck | ...",
  "criticality": "root_cause | contributor | friction",
  "agent_mechanism": "prompt_instruction | subagent | skill_procedure | tool_configuration | middleware | runtime_control | permission_interrupt",
  "reasoning": "...",
  "recommended_surface": "surface_id",
  "confidence": 0.85
}
```

提案提示词结构：
```
System: You are a harness improvement proposer. Given a failure diagnosis,
        propose a minimal edit (3-5 lines) to the harness to prevent recurrence.

输入:
- 诊断结果
- 目标表面的当前内容
- 约束：最小化编辑、单表面修改、不可删除功能

输出 (JSON):
{
  "proposal_id": "prop-xxx",
  "title": "简短标题",
  "summary": "人类可读的变更说明",
  "diff": { "before": "...", "after": "..." },
  "expected_effect": "...",
  "regression_risk": "none | low | medium",
  "confidence": 0.85,
  "mechanism_family": "prompt_instruction"
}
```

**验收**：
- [ ] 单元测试：诊断解析正确（mock LLM 返回固定 JSON）
- [ ] 单元测试：提案解析正确
- [ ] 单元测试：isTransient 过滤瞬态错误
- [ ] 单元测试：低 confidence（< 0.6）的提案返回 null
- [ ] 集成测试：给定真实失败轨迹 → 产出合理提案

**测试文件**：`tests/harness/harness-optimizer.test.ts`

### Task 1.4：EditableSurfaceProvider 实现

**文件**：`src/harness/editable-surfaces.ts`（新建）

**职责**：管理所有可编辑表面的注册、读取和写入。

```typescript
export class EditableSurfaceProvider {
  constructor(
    private skillRegistry: SkillRegistry,
    private agentManager: AgentManager,
    private toolRegistry: ToolRegistry,
    private configLoader: () => AppConfig,
  ) {}

  /** 注册一个可编辑表面 */
  register(surface: EditableSurface): void;

  /** 根据失败上下文推断相关的可编辑表面 */
  identifyRelevantSurfaces(context: FailureContext): EditableSurface[];

  /** 读取表面的当前值 */
  getCurrentValue(surfaceId: string): string;

  /** 获取 Skill 相关的所有表面 */
  getSkillSurfaces(skillId: string): EditableSurface[];

  /** 获取 Agent 相关的所有表面 */
  getAgentSurfaces(agentId: string): EditableSurface[];

  /** 获取全局表面 */
  getGlobalSurfaces(): EditableSurface[];
}
```

**验收**：
- [ ] 单元测试：根据 pattern 返回正确表面集合
- [ ] 单元测试：Skill 表面和 Agent 表面正确分离
- [ ] 单元测试：全局表面始终可用

**测试文件**：`tests/harness/editable-surfaces.test.ts`

### Task 1.5：ApprovalPolicy 实现

**文件**：`src/harness/approval-policy.ts`（新建）

**职责**：规则引擎 —— 按优先级匹配规则，命中即停。

```typescript
export class ApprovalPolicy {
  constructor(private rules: ApprovalRule[]) {
    // 规则按 priority 升序排列
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  evaluate(proposal: ImprovementProposal, context: {
    skillId?: string;
    agentId?: string;
    currentTime: Date;
  }): { action: 'require_approval' | 'auto_apply' | 'skip'; ruleId: string; autoRollback?: AutoRollbackConfig } {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (this.matches(rule, proposal, context)) {
        return { action: rule.action, ruleId: rule.id, autoRollback: rule.autoRollback };
      }
    }
    return { action: 'require_approval', ruleId: 'fallback' };
  }

  private matches(rule: ApprovalRule, proposal: ImprovementProposal, context: {...}): boolean {
    // AND 逻辑：所有非空维度都匹配
    if (rule.skillIds && !rule.skillIds.includes(context.skillId ?? '*')) return false;
    if (rule.agentIds && !rule.agentIds.includes(context.agentId ?? '*')) return false;
    if (rule.riskLevels && !rule.riskLevels.includes(proposal.regressionRisk)) return false;
    if (rule.failurePatterns && !rule.failurePatterns.includes(context.pattern)) return false;
    if (rule.minConfidence && proposal.confidence < rule.minConfidence) return false;
    if (rule.timeRanges && !this.inTimeRange(context.currentTime, rule.timeRanges)) return false;
    // ... 其他维度
    return true;
  }

  /** 重新加载规则（配置热更新时调用） */
  reload(rules: ApprovalRule[]): void;
}
```

**验证：**
- [ ] 单元测试：规则优先级生效（低 priority 先匹配）
- [ ] 单元测试：rule 0（删除类变更）总是命中
- [ ] 单元测试：rule 50（低风险自动）正确匹配
- [ ] 单元测试：skip action 生效
- [ ] 单元测试：时间范围规则正确判断
- [ ] 单元测试：多维度 AND 匹配正确

**测试文件**：`tests/harness/approval-policy.test.ts`

### Task 1.6：AutoApplyMonitor 实现

**文件**：`src/harness/auto-apply-monitor.ts`（新建）

**职责**：监控 auto_apply 提案的执行效果，在观察窗口内跟踪指标，不合格时自动回滚。

```typescript
export class AutoApplyMonitor {
  constructor(
    private metricsService: SkillMetricsService,
    private gitRepo: GitRepository,
  ) {}

  watch(proposalId: string, skillId: string | null, agentId: string | null, config: AutoRollbackConfig, commitHash: string): void;
  onActivationComplete(skillId: string | null, agentId: string | null, result: ActivationResult): void;
  private evaluate(proposalId: string): Promise<void>;
  private async rollback(proposalId: string, reason: string): Promise<void>;
}
```

**回滚逻辑**：
1. `git revert <commit_hash>` — 撤销变更
2. 通知用户（通过日志和 WebUI SSE）
3. 将触发本次 auto_apply 的规则降级为 `require_approval`

**验收**：
- [ ] 单元测试：满意度低于阈值触发回滚
- [ ] 单元测试：错误率超倍数触发回滚
- [ ] 单元测试：观察窗口内通过后删除监控
- [ ] 单元测试：回滚后规则降级

**测试文件**：`tests/harness/auto-apply-monitor.test.ts`

### Task 1.7：SkillEditor.apply() 实现

**文件**：`src/harness/skill-editor.ts`（新建）

**职责**：将批准的提案实际应用到目标表面。

```typescript
export class SkillEditor {
  constructor(
    private skillRegistry: SkillRegistry,
    private agentManager: AgentManager,
    private surfaceProvider: EditableSurfaceProvider,
    private gitRepo: GitRepository,
  ) {}

  /**
   * 应用提案到目标表面。
   * @returns 成功时返回 commit hash
   */
  async apply(proposal: ImprovementProposal): Promise<ApplyResult>;

  /**
   * 验证提案不会破坏现有结构。
   */
  validate(proposal: ImprovementProposal): ValidationResult;
}
```

**应用流程**：
1. `validate(proposal)` — 校验（skill-linter、YAML 语法、字段白名单）
2. 读取当前表面值
3. 应用 diff（替换文本）
4. 写回文件 / DB
5. `git commit -m "harness: ${proposal.title}"` — 提交变更
6. 返回 commit hash

**验收**：
- [ ] 单元测试：Skill SKILL.md body 被正确修改
- [ ] 单元测试：Agent systemPrompt 被正确修改
- [ ] 单元测试：修改后 git commit 成功
- [ ] 单元测试：验证失败不写入
- [ ] 单元测试：非法字段名被拒绝

**测试文件**：`tests/harness/skill-editor.test.ts`

---

## Phase 2：运行时集成

**工期**：2-3 天
**目标**：将 Phase 1 引擎嵌入 AgentService 执行流程，端到端跑通。

### Task 2.1：在 bootstrap 中创建 Harness 服务

**文件**：`src/app/bootstrap.ts`

**改动**：
```typescript
// bootstrap() 中新增
import { FailureDetector } from '../harness/failure-detector.js';
import { HarnessRateLimiter } from '../harness/rate-limiter.js';
import { HarnessOptimizer } from '../harness/harness-optimizer.js';
import { EditableSurfaceProvider } from '../harness/editable-surfaces.js';
import { ApprovalPolicy } from '../harness/approval-policy.js';
import { AutoApplyMonitor } from '../harness/auto-apply-monitor.js';
import { SkillEditor } from '../harness/skill-editor.js';

// 在 AppServices 中新增
interface AppServices {
  // ... 现有字段 ...
  harness?: {
    failureDetector: FailureDetector;
    rateLimiter: HarnessRateLimiter;
    optimizer: HarnessOptimizer;
    surfaceProvider: EditableSurfaceProvider;
    approvalPolicy: ApprovalPolicy;
    autoApplyMonitor: AutoApplyMonitor;
    skillEditor: SkillEditor;
  };
}
```

**验收**：
- [ ] 服务正确创建并注入 AppServices
- [ ] 配置禁用时不创建服务
- [ ] `pnpm test:ai` 全部通过
- [ ] `pnpm dev` 正常启动

### Task 2.2：AgentService 中嵌入失败检测

**文件**：`src/agent/agent-service.ts`

**改动**：
在 `execute()` 方法中，`agent.prompt()` 完成后（或 catch 块中），执行：

```typescript
// 伪代码：在 agent.prompt() 返回后或 catch 中
const failureContext = this.buildFailureContext(runtime, error);
const signal = this.harness?.failureDetector.detect(failureContext);
if (signal && this.harness?.rateLimiter.canTrigger(skillId, agentId, signal.pattern)) {
  // 异步触发优化，不阻塞用户当前响应
  this.triggerHarnessOptimization(failureContext, signal, runtime).catch(
    err => this.persistence?.logger.warn({ err }, 'Harness optimization failed')
  );
}
```

**buildFailureContext 需要收集**：
- `toolCalls` — 从 `agent.state.messages` 中提取工具调用和结果
- `errors` — 工具调用错误记录
- `agentEndReason` — 'complete' | 'error' | 'aborted'
- `skillId` — 从 `runtime.turnContext.activatedSkillName` 获取
- `agentId` — 从 `runtime.agent` 获取

**验收**：
- [ ] 正常完成的对话不触发优化
- [ ] 多次重复失败命令后触发优化
- [ ] 触发后日志中可见 Harness 相关日志
- [ ] 优化失败不影响主流程（catch 静默）
- [ ] `pnpm test:ai` 全部通过

### Task 2.3：触发优化流程实现

**文件**：`src/agent/agent-service.ts`（继续扩展）

**实现 `triggerHarnessOptimization` 方法**：

```typescript
private async triggerHarnessOptimization(
  context: FailureContext,
  signal: FailureSignal,
  runtime: AgentRuntime,
): Promise<void> {
  // 1. 调用 HarnessOptimizer.optimize()
  const proposal = await this.harness!.optimizer.optimize(context);
  if (!proposal) return;

  // 2. 评估审批策略
  const { action, ruleId, autoRollback } = this.harness!.approvalPolicy.evaluate(proposal, {
    skillId: context.skillId,
    agentId: context.agentId,
    pattern: signal.pattern,
    currentTime: new Date(),
  });

  // 3. 根据 action 执行
  if (action === 'skip') return;

  if (action === 'auto_apply') {
    const result = await this.harness!.skillEditor.apply(proposal);
    this.harness!.autoApplyMonitor.watch(proposal.id, context.skillId, context.agentId, autoRollback!, result.commitHash);
    // 附加通知到回复（如 "🔧 已自动优化"）
    this.notifyAutoApply(proposal, runtime);
    return;
  }

  // require_approval: 通过 ReplyDispatcher 请求用户审批
  const interaction = this.buildHarnessImprovementPrompt(proposal, signal);
  const dispatcher = runtime.turnContext.replyDispatcher;
  if (dispatcher?.requestHarnessApproval) {
    const decision = await dispatcher.requestHarnessApproval(interaction, 120_000);
    await this.handleUserDecision(decision, proposal, runtime);
  }
}
```

**验收**：
- [ ] 集成测试：端到端 - 失败检测 → 提案生成 → 用户审批 → 应用变更
- [ ] 集成测试：skip 规则生效
- [ ] 集成测试：auto_apply 静默应用
- [ ] 测试覆盖：用户审批超时

**测试文件**：`tests/harness/integration.test.ts`

---

## Phase 3：WebUI 设置页

**工期**：3-4 天
**目标**：WebUI 设置中出现 Harness 标签页，所有配置可通过 UI 修改。

### Task 3.1：SettingsModal 中注册 Harness 标签

**文件**：`ui/src/components/settings/SettingsModal.tsx`

**改动**：
```typescript
// SETTINGS_GROUPS 新增（在 agents 和 channels 之间）
{ id: 'harness', labelKey: 'settings.groups.harness' },

// COMPONENT_MAP 新增
harness: HarnessSettings,   // 懒加载
```

**验收**：
- [ ] 侧边栏出现"自动优化"标签页
- [ ] 点击后显示 HarnessSettings 组件
- [ ] 标签页在 agents 和 channels 之间

### Task 3.2：HarnessSettings 组件实现（五个功能区）

**文件**：`ui/src/components/settings/tabs/HarnessSettings.tsx`（新建）

**布局**（对应设计文档 8.2.2 节）：

```
① 总开关: Toggle (enabled)
② 通知渠道: Checkbox × 5 (webui/feishu/telegram/wechat/qq)
③ 触发条件: NumberInput × 3 + cooldown
④ 审批策略: RadioGroup × 3 预设 + "管理自定义规则"展开按钮
⑤ 速率限制: NumberInput × 2 + ModelSelect
```

**技术要点**：
- 使用 `useConfigDirty('harness')` hook 管理脏状态
- 预设模式：选择"总是询问"/"智能审批"/"低风险自动"后，前端计算对应的 rules 数组发送给后端
- NumberInput 路径加入 `useConfigDirty` 的 numericPaths

**验收**：
- [ ] 所有控件正确渲染
- [ ] 修改值 → 保存 → 刷新后值保持
- [ ] "恢复默认"按钮可用
- [ ] 字段验证（负数不可输入、冷却期 > 0）

### Task 3.3：ApprovalRulesEditor 组件实现

**文件**：`ui/src/components/settings/tabs/ApprovalRulesEditor.tsx`（新建）

**功能**：
- 列表展示所有规则（含系统规则和用户规则）
- 系统规则（id 以 `default-` 开头）显示 🔒 锁图标，action 可改为 `require_approval` 但不能删除
- 用户规则显示 👤 图标，可编辑可删除
- [+ 添加规则] 按钮 → 弹出表单（设计文档 8.2.4 节）
- 表单包含所有匹配维度：Skill 多选、Agent 多选、表面类型下拉、变更类型复选框、风险等级、失败模式、信心度滑块、影响范围、时间段

**技术要点**：
- 规则数据从 `harness.interactive.rules` 路径读取
- 添加/编辑/删除规则前端直接修改 rules 数组
- 保存时整个 `harness` 配置一起 PATCH

**验收**：
- [ ] 规则列表正确渲染系统规则和用户规则
- [ ] 系统规则不可删除
- [ ] 添加规则 → 保存 → 刷新后新规则存在
- [ ] 删除用户规则 → 保存 → 刷新后规则消失
- [ ] 表单验证（名称非空、至少选一个匹配维度）

### Task 3.4：AgentEditor 集成 Harness 开关

**文件**：
- `ui/src/components/settings/tabs/AgentEditor.tsx`
- `ui/src/types/agent.ts` — `Agent` 接口新增 `harness` 字段

**改动**：
在 AgentEditor 表单中新增一个 Toggle（放在系统提示词之后，工具配置之前）：

```tsx
{/* 🔧 自动优化 */}
<div className="border-t border-neutral-200 dark:border-neutral-700 pt-4">
  <label className="flex items-center justify-between">
    <div>
      <span className="text-sm font-medium">{t('settings.harness.agentOptIn')}</span>
      <p className="text-xs text-neutral-500 mt-0.5">{t('settings.harness.agentOptInDesc')}</p>
    </div>
    <Toggle
      checked={form.harness?.enabled !== false}
      onChange={(e) => setForm({ ...form, harness: { enabled: e.target.checked } })}
    />
  </label>
</div>
```

**验收**：
- [ ] 新建 Agent 时默认开启
- [ ] 关闭后保存 → 刷新 → 仍为关闭
- [ ] Agent API 正确序列化 `harness.enabled` 字段

### Task 3.5：i18n 键添加

**文件**：
- `ui/src/locales/zh-CN/common.json`
- `ui/src/locales/en/common.json`

**新增键**（设计文档 8.2.7 节已列出完整列表）：
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

**验收**：
- [ ] zh-CN 和 en 文件均包含所有键
- [ ] WebUI 切换语言后文本正确切换

---

## Phase 4：WebUI 交互卡片 + SSE

**工期**：2-3 天
**目标**：WebUI 聊天界面能收到 Harness 优化卡片，用户可直接在聊天中审批。

### Task 4.1：SSE 事件扩展

**文件**：`src/app/webui/chat-routes.ts`

**改动**：
在 SSE ReplyDispatcher 中新增事件类型。当 `requestHarnessApproval` 被调用时：
- 发送 SSE 事件 `{ type: 'harness_improvement', proposal: {...} }`
- 创建一个 Promise，等待前端通过 API 回调返回审批决定
- 超时（默认 120s）返回 `'timeout'`

**SSE 事件格式**：
```json
{
  "type": "harness_improvement",
  "proposal": {
    "id": "prop-abc123",
    "title": "优化 Android Operator 的设备检查流程",
    "failureSummary": "adb 连接失败后重复执行了 4 次相同的 connect 命令",
    "detail": "**诊断**：模型在 adb 返回 'unauthorized' 错误后...\n\n**建议**：在 Android Operator Skill 的执行指令中添加...",
    "diff": {
      "surface": "Android Operator Skill — 执行指令",
      "before": "...",
      "after": "..."
    },
    "impact": {
      "scope": "仅 android-operator skill",
      "riskLevel": "low",
      "expectedEffect": "相同错误减少约 80%"
    },
    "actions": [
      { "id": "approve", "label": "批准并应用", "style": "primary" },
      { "id": "edit", "label": "修改后应用", "style": "default", "inputField": { "placeholder": "输入修改后的内容...", "multiline": true } },
      { "id": "reject", "label": "拒绝", "style": "danger" },
      { "id": "dismiss", "label": "忽略", "style": "default" }
    ]
  }
}
```

**后端 API**（供前端回调）：
```
POST /api/harness/proposals/:id/decide
Body: { action: "approve" | "edit" | "reject" | "dismiss", editedValue?: string }
Response: { ok: true }
```

**验收**：
- [ ] SSE 事件正确发出
- [ ] 前端回调 API 正常工作
- [ ] 超时后自动返回 timeout
- [ ] `pnpm test:ai` 全部通过

### Task 4.2：HarnessImprovementCard 组件实现

**文件**：`ui/src/components/chat/HarnessImprovementCard.tsx`（新建）

**设计**：
```
┌─────────────────────────────────────────────┐
│  🔧 任务失败分析                             │
│                                             │
│  问题：adb 连接失败后重复执行了 4 次           │
│       相同的 connect 命令                    │
│                                             │
│  ┌─ Diff Viewer ──────────────────────────┐ │
│  │  - 旧: 直接执行 adb connect              │ │
│  │  + 新: 先检查 adb devices 状态再连接      │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  影响：仅 android-operator skill  ·  低风险   │
│                                             │
│  [✅ 批准并应用]  [✏️ 修改]  [❌ 拒绝]  [忽略] │
│                                             │
│  ☐ 以后 android-operator 的优化自动应用       │
└─────────────────────────────────────────────┘
```

**实现状态机**：
- `idle` → 显示提案内容
- `approved` → 显示"✅ 已应用" + 短暂动画
- `rejected` → 显示"❌ 已拒绝" + 缩小消失
- `editing` → diff 区域变为可编辑 textarea
- `dismissed` → 卡片消失

**验收**：
- [ ] 所有四个操作按钮可点击
- [ ] 批准后卡片变绿 "✅ 已应用"
- [ ] 拒绝后卡片变红 "❌ 已拒绝"
- [ ] 编辑模式：textarea 可编辑，提交时发送编辑内容
- [ ] "信任升级"勾选框可用

### Task 4.3：ChatView 集成

**文件**：`ui/src/components/chat/ChatView.tsx`（修改）

**改动**：
- 监听 SSE `harness_improvement` 事件
- 在消息列表底部插入 `<HarnessImprovementCard>`
- 处理卡片回传的审批决定 → 调用 `/api/harness/proposals/:id/decide`
- 编辑模式下提交编辑文本 → 调用 API + editedValue

**验收**：
- [ ] Harness 卡片在消息列表中正确渲染
- [ ] 审批决定正确发送到后端
- [ ] 页面刷新后卡片不重现（已处理状态）

---

## Phase 5：渠道渲染（飞书/微信/QQ/Telegram）

**工期**：3-4 天
**目标**：所有渠道均能展示 Harness 提案并接受用户审批。

### Task 5.1：飞书 ReplyDispatcher 扩展

**文件**：`extensions/channel-feishu/render/reply-dispatcher.ts`

**实现** `requestHarnessApproval` 方法：
- 发送交互式卡片消息（模板见设计文档 3.4.1 节）
- 使用飞书卡片 action button 的 `value` 字段传递 `{ action, proposalId }`
- 等待飞书 Webhook 回调 → 解析用户选择 → 返回 ApprovalDecision
- 参考现有 `ApprovalCard` 渲染逻辑

**验收**：
- [ ] 飞书中收到 Harness 优化卡片
- [ ] 点击按钮后正确处理（通过 WebSocket 回调）
- [ ] 超时处理（120s 无响应 → timeout）

### Task 5.2：Telegram ReplyDispatcher 扩展

**文件**：`extensions/channel-telegram/telegram-dispatcher.ts`

**实现** `requestHarnessApproval` 方法：
- 发送 Markdown 文本 + inline keyboard 按钮
- 按钮：`✅ 批准` `✏️ 修改` `❌ 拒绝`
- 通过 callback query 处理用户选择

**验收**：
- [ ] Telegram 中收到 Harness 建议消息
- [ ] 内联按钮可点击
- [ ] 批准/拒绝操作正确响应

### Task 5.3：微信 ReplyDispatcher 扩展

**文件**：`extensions/channel-wechat/wechat-dispatcher.ts`

**实现** `requestHarnessApproval` 方法：
- 发送文本消息（模板见设计文档 3.4.3 节）
- 数字选项 1/2/3 对应 批准/编辑/拒绝
- 用户回复数字 → 解析 → 返回 ApprovalDecision
- "修改"情况：用户回复 "2 修改后的内容..."

**验收**：
- [ ] 微信中收到 Harness 建议文本
- [ ] 回复 "1" 触发批准
- [ ] 回复 "3" 触发拒绝

### Task 5.4：QQ ReplyDispatcher 扩展

**文件**：`extensions/channel-qq/qq-dispatcher.ts`

**实现** `requestHarnessApproval` 方法：
- 与微信类似的文本 + 数字选项模式
- 适配 QQ 消息格式限制

**验收**：
- [ ] QQ 中收到 Harness 建议文本
- [ ] 回复数字正确处理

---

## Phase 6：打磨与测试

**工期**：2-3 天
**目标**：质量保障、文档完善、端到端验证。

### Task 6.1：集成测试

**文件**：`tests/harness/integration.test.ts`（新建）

**测试场景**：
1. **正常完成不触发**：一次成功的对话不产生 Harness 事件
2. **重复命令失败触发**：3 次相同命令错误 → 检测到 → 生成提案
3. **冷却期过滤**：同一模式 30 分钟内不重复触发
4. **auto_apply 静默应用**：低风险提案自动应用
5. **审批 → 应用**：用户批准 → Skill 文件修改 → git commit
6. **审批 → 拒绝**：用户拒绝 → 记录日志 → 不变更
7. **超时处理**：用户 120s 不响应 → timeout
8. **全局 daily 上限**：超过 daily 上限后不再触发
9. **规则优先级**：删除类变更始终 require_approval
10. **自动回滚**：auto_apply 后满意度低于阈值 → git revert

**验收**：
- [ ] 所有 10 个集成测试场景通过
- [ ] 测试使用 mock LLM 调用（避免真实 API 依赖）

### Task 6.2：配置热更新支持

**文件**：`src/app/bootstrap.ts`

**改动**：
- 在 `configEventBus.onReload()` 中注册 Harness 服务的配置热更新
- `ApprovalPolicy.reload()` 在规则变更时重新加载
- `HarnessRateLimiter` 在限速参数变更时更新

**验收**：
- [ ] 修改 config.yaml → 热更新生效
- [ ] WebUI 保存设置 → 配置立即生效（无需重启）

### Task 6.3：手动端到端测试

**测试场景**：

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 1 | 触发优化 | 在 WebUI 中发送一个会导致重复失败的任务 | 消息末尾出现 Harness 卡片 |
| 2 | 批准应用 | 点击"批准并应用" | 对应 Skill/Agent 被修改，卡片变绿 |
| 3 | 拒绝 | 点击"拒绝" | 卡片变红消失 |
| 4 | 飞书渠道 | 通过飞书触发同样场景 | 飞书卡片出现，按钮可用 |
| 5 | 设置页 | 进入 Harness 设置页 | 所有控件可用，保存生效 |
| 6 | 自定义规则 | 添加一条规则 → 触发对应场景 | 规则匹配生效 |
| 7 | Agent 关闭 | 在 AgentEditor 关闭某 Agent 的 Harness | 该 Agent 不再触发优化 |

### Task 6.4：文档更新

**文件**：
- `docs/SELF_HARNESS_INTERACTIVE_DESIGN.md` — 如有设计变更，同步更新
- `docs/SELF_HARNESS_IMPLEMENTATION_PLAN.md` — 本文档，标注任务完成状态
- `docs/ARCHITECTURE.md` — 新增 Harness 模块描述
- `CHANGELOG.md` / release notes — 功能说明

---

## 10. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| LLM 诊断质量不稳定 | 中 | 中 | 低 confidence (< 0.6) 自动过滤；使用结构化 JSON 输出约束 |
| 重复骚扰用户 | 高 | 中 | 冷却期 + 每日上限 + 用户信任升级路径 |
| auto_apply 错误变更 | 中 | 高 | 观察窗口 + 自动回滚 + 规则降级 + Git 历史可追溯 |
| 渠道审批超时 | 中 | 低 | 120s 超时 → 静默跳过 + 日志记录 |
| 并发冲突（两个提案同时改同一文件） | 低 | 中 | 文件级锁 + Git merge conflict 检测 |
| 现有测试被破坏 | 中 | 高 | 每 Phase 后运行 `pnpm test:ai`，Phase 0 先做类型定义确保编译通过 |

## 11. 验收矩阵

| ID | 标准 | Phase | 验收方式 | 阻塞发布？ |
|----|------|-------|---------|-----------|
| SC1 | WebUI 出现 Harness 优化卡片 | P4 | 手动 | 是 |
| SC2 | 批准后配置被修改 + git commit | P4 | 检查 git log | 是 |
| SC3 | 冷却期过滤生效 | P1 | 单元测试 + 日志 | 是 |
| SC4 | auto_apply 静默应用 + 自动回滚 | P1 | 单元测试 | 是 |
| SC5 | 飞书 / 微信 / WebUI 三种渠道均可审批 | P5 | 手动 | 否（可延后） |
| SC6 | WebUI 设置页完整可用 | P3 | 手动 | 是 |
| SC7 | zh-CN + en i18n 完整 | P3 | grep | 是 |
| SC8 | pnpm test:ai 全部通过 | 全部 | CI | 是 |
| SC9 | 删除类变更始终需审批 | P1 | 单元测试 | 是 |
| SC10 | 总开关关闭后不触发任何优化 | P2 | 手动 | 是 |
| SC11 | Agent 级开关关闭后该 Agent 不触发 | P3 | 手动 | 否 |
| SC12 | 配置热更新生效 | P6 | 手动 | 否 |

---

## 附录 A：文件清单

### 新增文件

| 文件 | Phase | 说明 |
|------|-------|------|
| `src/harness/types.ts` | P0 | 所有 Harness 类型定义 |
| `src/harness/failure-detector.ts` | P1 | 失败检测器 |
| `src/harness/rate-limiter.ts` | P1 | 冷却期与限流 |
| `src/harness/harness-optimizer.ts` | P1 | 优化引擎（LLM 诊断 + 提案） |
| `src/harness/editable-surfaces.ts` | P1 | 可编辑表面管理 |
| `src/harness/approval-policy.ts` | P1 | 审批策略规则引擎 |
| `src/harness/auto-apply-monitor.ts` | P1 | 自动应用监控与回滚 |
| `src/harness/skill-editor.ts` | P1 | 提案应用与 Git 操作 |
| `tests/harness/failure-detector.test.ts` | P1 | |
| `tests/harness/rate-limiter.test.ts` | P1 | |
| `tests/harness/harness-optimizer.test.ts` | P1 | |
| `tests/harness/editable-surfaces.test.ts` | P1 | |
| `tests/harness/approval-policy.test.ts` | P1 | |
| `tests/harness/auto-apply-monitor.test.ts` | P1 | |
| `tests/harness/skill-editor.test.ts` | P1 | |
| `tests/harness/integration.test.ts` | P6 | |
| `ui/src/components/settings/tabs/HarnessSettings.tsx` | P3 | Harness 设置页 |
| `ui/src/components/settings/tabs/ApprovalRulesEditor.tsx` | P3 | 审批规则编辑器 |
| `ui/src/components/chat/HarnessImprovementCard.tsx` | P4 | 聊天中优化卡片 |

### 修改文件

| 文件 | Phase | 改动说明 |
|------|-------|---------|
| `src/app/types.ts` | P0 | AppConfig + ReplyDispatcher + AgentConfig 扩展 |
| `src/app/config.ts` | P0 | zod schema 新增 harness 段 |
| `config.yaml` | P0 | 新增 harness 默认配置 |
| `ui/src/types/config.ts` | P0 | AppConfig 接口扩展 |
| `ui/src/types/agent.ts` | P0 | Agent 接口新增 harness |
| `src/app/bootstrap.ts` | P2 | 创建 Harness 服务 |
| `src/agent/agent-service.ts` | P2 | 嵌入失败检测 + 优化触发 |
| `ui/src/components/settings/SettingsModal.tsx` | P3 | 注册 Harness 标签页 |
| `ui/src/components/settings/tabs/AgentEditor.tsx` | P3 | 新增 Harness toggle |
| `ui/src/locales/zh-CN/common.json` | P3 | 新增 i18n 键 |
| `ui/src/locales/en/common.json` | P3 | 新增 i18n 键 |
| `src/app/webui/chat-routes.ts` | P4 | SSE 事件 + 回调 API |
| `ui/src/components/chat/ChatView.tsx` | P4 | 集成 HarnessImprovementCard |
| `extensions/channel-feishu/render/reply-dispatcher.ts` | P5 | requestHarnessApproval |
| `extensions/channel-telegram/telegram-dispatcher.ts` | P5 | requestHarnessApproval |
| `extensions/channel-wechat/wechat-dispatcher.ts` | P5 | requestHarnessApproval |
| `extensions/channel-qq/qq-dispatcher.ts` | P5 | requestHarnessApproval |

---

## 附录 B：文件变更概览

```
新增: 17 个文件 (~3500 行)
修改: 17 个文件 (~500 行改动)
总计: 34 个文件 (~4000 行代码)
```

## 附录 C：每日进度追踪建议

建议在实施过程中使用以下标签追踪状态：

- `🟢 完成` — 已实现 + 测试通过 + 验收通过
- `🟡 进行中` — 正在实现
- `⚪ 未开始` — 尚未启动
- `🔴 阻塞` — 遇到阻碍，需要讨论

每个 Phase 完成后进行 check-in，确认：
1. 所有单元测试通过
2. `pnpm test:ai` 通过
3. `pnpm build` 通过
4. 手动 smoke test 通过
