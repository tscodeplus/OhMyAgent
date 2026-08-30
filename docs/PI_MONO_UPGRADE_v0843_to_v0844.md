# pi-mono v0.84.3 → v0.84.4 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-08-30 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.84.3（2026-08-25 嵌入） |
| 目标版本 | v0.84.4 |
| 升级难度 | **低** — 跨 patch 版本：agent 核心仅 1 处结构重构（`prepareNextTurn` 调用时机），本地补丁全部可叠加；本项目不嵌 harness，`harness/env/nodejs.ts` 的 taskkill 修复不适用 |

## 上游变更概要

### v0.84.4

- **agent 包**：`agent-loop.ts` 重构 turn 切换 — `firstTurn: boolean` → `lastCompletedTurn: PrepareNextTurnContext | undefined`；`prepareNextTurn` 从 `turn_end` 之后**延迟到下一个 turn 开始前**惰性调用（#6879：大工具结果跨自动压缩阈值时先压缩再发起下一次响应、可恢复交互进度）；`prepareNextTurn` 长耗时期间排队的新 steering 消息会被补拉取（#8537）；`shouldStopAfterTurn` 语义改为「在 `prepareNextTurn` 之前运行」。`harness/env/nodejs.ts`：Windows 上改用 `SystemRoot\System32\taskkill.exe` 绝对路径并吞掉 spawn error（#6596，本项目不嵌 harness，忽略）。`types.ts` 仅注释更新。
- **ai 包**：`openai-completions.ts` 修复推理 replay — `thinkingSignature` 不再在流式过程中反复序列化（#8671），流内合并相邻 `reasoning.text`/`reasoning.summary` 增量（OpenRouter reasoning_details 增量语义），`push` 时浅拷贝 detail 避免共享可变对象；`mistral-conversations.ts` 修复碎块工具调用缺失 ID 时合并失败（#8387，`toolBlocksByKey` 键改为 `toolCall.index ?? callId`）；`cloudflare-ai-gateway.ts` 类型别名重构（`as const` 联合 → `type` 别名 + 显式泛型，tsc 友好）；`image-models.generated.ts` 刷新（新增 DeepSeek V4 Flash Vision 实验模型）；`types.ts` 仅 `toolChoice` 注释更新。
- **telemetry 包**：src 与 v0.84.3 完全一致（仅版本号变化）。
- 本项目不嵌入 `coding-agent`，其新增的 `detectSupportedImageMimeTypeFromFile()` 公共导出（#8600）与本项目无关。

## 依赖升级

**无。** v0.84.4 的 agent/ai/telemetry package.json 仅内部包版本 0.84.3→0.84.4 与自身版本号变化，无新增/升级外部依赖（openai 仍 6.40.0、typebox 1.3.7、@google/genai 1.52.0 等均不变）。项目根 package.json 无需改动，无需 pnpm install。

## 升级步骤

### 1. 本地补丁盘点（归一化 .ts→.js 后 diff）

| 文件 | 补丁内容 | v0.84.4 处理方式 |
|---|---|---|
| agent/agent-loop.ts | 工具循环守卫（failureStreak/maxToolCycles）+ fallback 多模型重试 + compactToolsForPrompt + v4 isError 透传 | **手工三方合并**（见步骤 3） |
| agent/types.ts | fallbackModels + maxToolCycles + deferred | 上游仅注释变化，v0.84.4 基础上重新应用本地 3 处字段 |
| agent/agent.ts | fallbackModels + streamFn 别名 + ohmyagent_agentName | 上游未变，直接恢复本地版 |
| agent/index.ts | 删除 harness/search 导出 | 上游未变，直接恢复本地版 |
| agent/node.ts | 删除 NodeExecutionEnv 导出 | 上游未变，直接恢复本地版 |
| ai/compat.ts | registerModel 自定义模型注册表 | 上游未变，直接恢复本地版 |
| ai/api/bedrock-converse-stream.ts | tsc middleware 断言 `as any` ×2 | 上游未变，直接恢复本地版 |
| ai/api/openai-codex-responses.ts | tsc `body: sseBody as BodyInit` | 上游未变，直接恢复本地版 |
| ai/providers/xai.ts | `Provider<"openai-completions" \| "openai-responses">` | 上游未变，直接恢复本地版 |
| ai/utils/oauth/* | 本地独有 OAuth 兼容层 | 保留（不在上游） |
| ai/providers/data/* | 生成产物（39 个 JSON，v0.84.4 无变化） | 保留 |

上游有变更、本地无补丁的 4 个文件直接采用上游版：`ai/api/mistral-conversations.ts`、`ai/api/openai-completions.ts`、`ai/providers/cloudflare-ai-gateway.ts`、`ai/image-models.generated.ts`（另 `ai/types.ts` 为注释变更，同上游版）。

### 2. 复制与转换

```bash
cp -r <upstream>/packages/agent/src/* src/pi-mono/agent/   # 然后 rm -rf harness search
cp -r <upstream>/packages/ai/src/*    src/pi-mono/ai/      # 保留本地 utils/oauth、providers/data
cp -r <upstream>/packages/telemetry/src/* src/pi-mono/telemetry/  # 然后 rm -rf testing
# 四形式 sed（静态/副作用/动态/包装路径 .ts→.js）
find src/pi-mono -name "*.ts" -exec sed -i \
  -e 's/from "\([^"]*\)\.ts"/from "\1.js"/g' \
  -e 's/^import "\([^"]*\)\.ts"/import "\1.js"/g' \
  -e 's/import("\([^"]*\)\.ts")/import("\1.js")/g' \
  -e 's/("\([^"]*\)\.ts")/("\1.js")/g' {} +
```

### 3. agent-loop.ts 手工三方合并要点

- **上游侧**：`lastCompletedTurn` 快照 + `prepareNextTurn` 移到内层循环顶部（`lastCompletedTurn` 存在时）惰性执行；`prepareNextTurn` 之后在 `pendingMessages` 为空时补拉一次 steering；`turn_start` 随该块发出；`shouldStopAfterTurn(lastCompletedTurn)` 仍在 `turn_end` 后立即检查（先于 `prepareNextTurn`）。
- **本地侧叠加**：工具循环守卫变量（`toolCycles/lastFailedTool/failureStreak/failureDiagnosticInjected/haltDiagnosticInjected/toolExecutionHalted`）插在 `pendingMessages` 初始化之后；工具调用分支三等：`stopReason==="length" → failToolCallsFromTruncatedMessage`、`toolExecutionHalted → failToolCallsWithSystemHalt`、否则 `executeToolCalls`；`toolResults` 入队后追加失败同工具连击统计与诊断注入（`failToolCallsWithSystemHalt` 用 `createGuardMessage`）。`streamAssistantResponse` 整函数替换为本地 fallback 版（`compactToolsForPrompt` 过滤 deferred 工具、`fallbackModels` 多模型重试、`context.messages.length = baseLen` 逐次回滚）。`executePreparedToolCall` 尾部保留 v4 `isError` 透传。
- **时序影响确认**：本项目 `Agent.createLoopConfig` 的 `prepareNextTurn`（turn counter + reflection 注入）由「turn_end 后立即」变为「下一 turn 开始前」，反射注入仍发生在下一轮 LLM 调用之前，行为等价且更贴近 #6879 的压缩时序，无破坏。

### 4. 编译修复

0 处新增。v0.84.4 上游 `cloudflare-ai-gateway.ts` 已自行改为 tsc 友好的显式泛型；本地 bedrock/openai-codex 断言照旧恢复。

## 验证

- `pnpm build` — 0 错误
- `pnpm test:ai` — **191 文件 / 2989 测试通过**（3 跳过，环境相关），exit 0

## 后续注意事项

- `prepareNextTurn` 惰性化后，`shouldStopAfterTurn` 语义变为「先于 `prepareNextTurn` 运行」；本项目两个 hook 无顺序依赖，无需适配
- harness `taskkill.exe` 绝对路径修复（可怜的 Windows 场景）与 `search/` 演进继续维持不嵌入策略
- 上游 v0.84.4 已含 DeepSeek v4 Flash Vision（experimental）模型数据（`image-models.generated.ts`），如需使用请自行配置 DeepSeek API Key