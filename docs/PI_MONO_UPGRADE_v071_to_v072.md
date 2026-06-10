# pi-mono v0.71.0 → v0.72.0 升级记录

## 升级概览

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-02 |
| 上游仓库 | [pi-mono](https://github.com/badlogic/pi-mono) |
| 源版本 | v0.71.0 (commit `f4efeb2`) |
| 目标版本 | v0.72.0 (commit `196226b`) |
| 嵌入目录 | `src/pi-mono/` |
| 测试结果 | 55 test files, 750 tests — 全部通过 |

## v0.72.0 上游变更清单

### Agent 层 (packages/agent/src/)

| 文件 | 变更内容 |
|------|---------|
| `types.ts` | 新增 `ShouldStopAfterTurnContext` 接口和 `shouldStopAfterTurn` 钩子；文档更新 |
| `agent-loop.ts` | 在 `turn_end` 后新增 `shouldStopAfterTurn` 检查，支持优雅退出循环 |

### AI 层 (packages/ai/src/)

| 文件 | 变更内容 |
|------|---------|
| `types.ts` | 新增 `xiaomi` provider；新增 `ModelThinkingLevel`、`ThinkingLevelMap` 类型；`Transport` 增加 `websocket-cached`；`reasoningEffortMap` → `thinkingLevelMap` |
| `models.ts` | `supportsXhigh()` → `getSupportedThinkingLevels()` + `clampThinkingLevel()`；推理级别检测从硬编码模型 ID 改为基于模型元数据 |
| `models.generated.ts` | 新增 xiaomi 模型定义；所有模型添加 `thinkingLevelMap` 字段 |
| `env-api-keys.ts` | 新增 `xiaomi: "XIAOMI_API_KEY"` 映射 |
| `index.ts` | 新增 OpenAI Codex WebSocket 调试相关导出 |
| `utils/overflow.ts` | 新增 Xiaomi MiMo 风格（fill-context + zero-output）溢出检测 |
| **Provider 文件** (8个) | `supportsXhigh` + `clampReasoning` → `clampThinkingLevel` + `thinkingLevelMap` |

### Provider 文件变更细节

每个 provider 的推理级别映射方式统一变更：

**v0.71.0:**
```typescript
// 硬编码模型 ID 判断
const reasoningEffort = supportsXhigh(model) ? options.reasoning : clampReasoning(options.reasoning);
// 或从 compat 读取
reasoning_effort = mapReasoningEffort(options.reasoningEffort, compat.reasoningEffortMap);
```

**v0.72.0:**
```typescript
// 基于模型元数据
const clampedReasoning = options.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
// thinkingLevelMap 直接从 model 读取
reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
```

## 升级步骤

### 1. 获取上游源码

```bash
git clone --depth 1 --branch v0.72.0 https://github.com/badlogic/pi-mono.git /tmp/pi-mono-v072-src
git clone --depth 1 --branch v0.71.0 https://github.com/badlogic/pi-mono.git /tmp/pi-mono-v071-src
```

### 2. 对比差异

```bash
diff -rq /tmp/pi-mono-v071-src/packages/agent/src/ /tmp/pi-mono-v072-src/packages/agent/src/
diff -rq /tmp/pi-mono-v071-src/packages/ai/src/ /tmp/pi-mono-v072-src/packages/ai/src/
```

### 3. 文件分类

#### 直接覆盖（本地无修改）

以下文件从 v0.72.0 直接复制，无需合并：

```
ai/types.ts
ai/env-api-keys.ts
ai/index.ts
ai/models.generated.ts
ai/utils/overflow.ts
ai/providers/amazon-bedrock.ts
ai/providers/anthropic.ts
ai/providers/azure-openai-responses.ts
ai/providers/google-vertex.ts
ai/providers/google.ts
ai/providers/mistral.ts
ai/providers/openai-codex-responses.ts
ai/providers/openai-completions.ts
ai/providers/openai-responses.ts
```

#### 需要合并（本地有修改）

| 文件 | 本地修改 | 上游变更 | 处理方式 |
|------|---------|---------|---------|
| `agent/types.ts` | `fallbackModels` 字段 | `ShouldStopAfterTurnContext` + `shouldStopAfterTurn` 钩子 | 手工合并 |
| `agent/agent-loop.ts` | 所有模型尝试都发出 delta 事件 + 错误日志 | `shouldStopAfterTurn` 检查点 | 手工合并 |
| `ai/models.ts` | `registerModel()` + `modelsAreEqual()` | `getSupportedThinkingLevels()` + `clampThinkingLevel()` | 用 v0.72.0 版本 + 补回 `registerModel()` |

**注意**: `modelsAreEqual()` 在 v0.72.0 中已被上游包含，无需额外保留。

#### 保持不变（仅本地修改，上游无变更）

```
agent/agent.ts  — fallbackModels 属性
```

### 4. 合并操作

**agent/types.ts** — 在 `AfterToolCallContext` 之后插入 `ShouldStopAfterTurnContext` 接口；在 `getSteeringMessages` 之前插入 `shouldStopAfterTurn` 钩子。

**agent/agent-loop.ts** — 在 `turn_end` emit 之后插入 `shouldStopAfterTurn` 检查块：

```typescript
await emit({ type: "turn_end", message, toolResults });

if (
    await config.shouldStopAfterTurn?.({
        message, toolResults,
        context: currentContext, newMessages,
    })
) {
    await emit({ type: "agent_end", messages: newMessages });
    return;
}
```

**ai/models.ts** — v0.72.0 已包含 `modelsAreEqual()`，需要补回项目独有的 `registerModel()`：

```typescript
export function registerModel<TApi extends Api>(
    provider: string,
    modelId: string,
    model: Model<TApi>,
): void {
    let providerModels = modelRegistry.get(provider);
    if (!providerModels) {
        providerModels = new Map<string, Model<Api>>();
        modelRegistry.set(provider, providerModels);
    }
    providerModels.set(modelId, model as Model<Api>);
}
```

### 5. 编译验证

```bash
pnpm build   # tsc 编译，确保无类型错误
```

### 6. 运行测试

```bash
pnpm test:ai   # 50+ 测试文件，700+ 测试用例
pnpm test      # 完整测试套件
```

## 本地修改清单（升级后保留）

升级完成后，以下本地修改仍然有效：

| 文件 | 功能 | 用途 |
|------|------|------|
| `agent/agent.ts` | `fallbackModels` 属性 | 主模型失败时自动切换到备用模型 |
| `agent/types.ts` | `fallbackModels` in `AgentLoopConfig` | 传递 fallback 配置到 agent loop |
| `agent/agent-loop.ts` | 移除 `isLastModel` 条件 | **所有** fallback 模型的 delta 事件都发送给客户端 |
| `agent/agent-loop.ts` | 错误日志输出 | 便于排查 fallback 失败原因 |
| `ai/models.ts` | `registerModel()` | 运行时注册自定义模型（custom_providers.yaml） |
| `src/provider/mimo-provider.ts` | 整个文件 | 自定义 MiMo provider，base URL: `https://token-plan-cn.xiaomimimo.com/v1` |

## 关键注意事项

### 1. reasoningEffortMap → thinkingLevelMap 不破坏兼容性

`DEFAULT_REASONING_LEVEL` 和 `reasoning_level` 的数据流不变：

```
.env: DEFAULT_REASONING_LEVEL
custom_providers.yaml: reasoning_level
        ↓
agent-factory.ts: thinkingLevel 优先级 = per-model > 全局 > 'off'
        ↓
AgentLoopConfig.reasoning → provider 层
```

对于自定义模型（无 `thinkingLevelMap`），provider 代码通过 `??` 直接回退到原始值，行为与旧版一致。

### 2. 不要删除自定义 MiMo provider

v0.72.0 在 `models.generated.ts` 中新增了 `xiaomi` provider 下的 MiMo 模型（通过 OpenRouter，base URL: `https://openrouter.ai/api/v1`）。这与项目的自定义 MiMo provider（`mimo-openai-completions`，base URL: `https://token-plan-cn.xiaomimimo.com/v1`）是**完全独立的两套机制**。自定义 MiMo provider 位于 `src/provider/mimo-provider.ts`，不受升级影响。

### 3. 后续升级参考

每次升级 pi-mono 时，务必执行以下检查：

```bash
# 确认所有本地修改仍存在
grep -rn "fallbackModels\|registerModel\|isLastModel\|mimo-openai-completions" src/pi-mono/ src/provider/

# 确认编译通过
pnpm build

# 确认测试全部通过
pnpm test:ai
```

### 4. 测试覆盖的本地修改点

- `tests/e2e/message-flow.test.ts` — 覆盖 fallback 错误日志输出
- `tests/provider/mimo-provider.test.ts` — 覆盖自定义 MiMo provider 注册
- `tests/app/bootstrap.test.ts` — 覆盖 `registerModel()` 调用
- `tests/agent/agent-factory.test.ts` — 覆盖 fallback 模型配置和推理级别解析
