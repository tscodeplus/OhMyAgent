# pi-mono v0.85.1 → v0.86.0 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-09-19 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.85.1（2026-09-10 嵌入） |
| 目标版本 | v0.86.0 |
| 升级难度 | **高** — ai 包含 Breaking Changes（`Context` → `TranscriptContext`、工具声明移入 transcript 系统消息、`ToolResultMessage` 变条件类型）；agent 包随之重构（system prompt/tools 成为 transcript 系统消息）；本地 deferred 工具机制必须迁移到新模型；另需升级 5 个外部依赖（含 `@google/genai` 1.x → 2.x） |

## 上游变更概要（仅覆盖本项目嵌入的 agent/ai/telemetry）

### ai 包（Breaking Changes）

- **`Context` → `TranscriptContext`**：provider 面向的 `ProviderStreams` / `StreamFunction` / `StreamFunction` 入参改为归一化的 `TranscriptContext`；system prompt 与工具声明改由 transcript 的 **system 消息**承载（`SystemMessage.toolsAdded` / `toolsRemoved` / `content` / `sections`）。`Context`（含 `systemPrompt`/`tools`）仍是公开入口类型，由 `normalizeContext()` 折叠成首条 system 消息。
- **移除 `ToolResultMessage.addedToolNames`**，删除 `utils/deferred-tools.ts`：动态工具解锁改由 transcript 系统消息声明（`getCurrentTools()` 回放），并新增原生 deferred 支持（Anthropic `__pi_deferred_placeholder__` + `tool_addition` 块、Fireworks 等）。
- **`ToolCall.arguments` 收窄为 `JsonObject`**；`ToolResultMessage.details` 限定 JSON 兼容值，`ToolResultMessage<TDetails>` 变为条件类型（不兼容则 `never`）；`JsonValue` 数组变 readonly；新增 `JsonRepresentation<T>`。
- 新增 `SystemMessage`、`TranscriptContext`、`ToolReference`、`utils/transcript.ts`（`normalizeContext`/`getCurrentTools`/`getCurrentSystemMessage`/`toToolDeclaration`/`collapseSystemMessages`）、`AssistantMessageFrameEncoder` 等；`Model.promptCache`；`RetryPolicy.maxAgentDelayMs`。
- 各 API 适配器：Anthropic 原生工具变更、mid-conversation system messages、OpenAI Codex/GitHub Copilot 修复、DeepSeek/OpenRouter/OpenCode/Baseten session 头、retry 分类修复等。
- 新文件：`api/cloudflare-ai-binding.ts`、`utils/assistant-message-frame.ts`、`utils/transcript.ts`、`providers/opencode-headers.ts`、`providers/radius.models.ts`；删除 `api/cloudflare-gateway-binding.ts`、`utils/deferred-tools.ts`。

### agent 包

- `AgentState.systemPrompt` 变只读（由 transcript 首条 system 消息回放）；`Agent.reset()` 保留 prompt/tool 基线。
- 新增 `declareToolChanges()`：每轮请求前把 `context.tools`（可执行集）与 transcript 声明集的差异写成 `toolsAdded`/`toolsRemoved` 系统消息。
- `AgentToolResult.addedToolNames` 移除（本项目已按上文迁移）；`AgentToolResult<T = JsonValue | undefined>`；`AgentMessage` 联合新增 system 角色。
- `proxy.ts`、`index.ts`（更多 harness 导出，不采纳）等常规变更。

### telemetry 包

- src 与 v0.85.1 完全一致。

## 依赖升级（root package.json）

| 依赖 | 旧 → 新 |
|---|---|
| `@anthropic-ai/sdk` | ^0.123.0 → **^0.124.0** |
| `@aws-sdk/client-bedrock-runtime` | ^3.1048.0 → **^3.1127.0** |
| `@google/genai` | ^1.52.0 → **^2.21.0**（大版本；`FinishReason.TOO_MANY_TOOL_CALLS` 等新常量依赖） |
| `@smithy/node-http-handler` | ^4.7.3 → **^4.12.1** |
| `typebox` | ^1.3.7 → **^1.3.27**（app 侧 50+ 工具定义使用） |
| `http-proxy-agent` / `https-proxy-agent` | 已是 ^9.0.0，满足上游 9.1.0，无需改动 |

## 升级步骤（实际执行）

### 1. 补丁盘点

沿用「本地 `.ts`→`.js` 归一化后与上一版上游逐文件 diff」的方法。本次真实本地补丁：

| 文件 | v0.86.0 处理方式 |
|---|---|
| agent/agent-loop.ts | 手工三方合并（见步骤 3） |
| agent/agent.ts | 保留本地补丁 + **新增**首条 system 消息的 deferred 过滤 |
| agent/types.ts | 保留本地补丁 + **新增** `AgentToolResult.addedToolNames`（上游已删，app 仍依赖） |
| agent/index.ts、node.ts、stream-fn.ts | 上游未变，保留本地版 |
| agent/proxy.ts | 直接采用上游版 |
| ai/compat.ts | 上游改动在 stream 函数（Context→TranscriptContext）；**重贴**本地 `registerModel` 注册表块（含 `getBuiltinProviders` 再导出） |
| ai/types.ts | 采用上游版 + **原位重贴** `onStreamRetry` + `StreamRetryInfo` |
| ai/api/bedrock-converse-stream.ts | 采用上游版 + 重贴 `middlewareStack.add(... as any)` ×2 |
| ai/api/openai-codex-responses.ts | 采用上游版 + 重贴 `body: sseBody as BodyInit` |
| ai/providers/xai.ts | 上游未变，保留本地版（Provider 泛型放宽） |
| ai/utils/oauth/* | 本地独有 OAuth 兼容层，未触碰 |
| ai/providers/data/* | 从 npm pack v0.86.0 提取覆盖（40 文件） |

### 2. 复制与转换

```bash
cp /tmp/pi-0.86.0/packages/agent/src/*.ts src/pi-mono/agent/     # 之后恢复本地 3 文件 + 合并 2 文件
cp -r /tmp/pi-0.86.0/packages/ai/src/. src/pi-mono/ai/           # 之后恢复/合并本地 5 文件
cp -r /tmp/pi-0.86.0/packages/telemetry/src/. src/pi-mono/telemetry/
rm -f src/pi-mono/ai/utils/deferred-tools.ts                     # 上游已删
rm -rf src/pi-mono/telemetry/testing                             # 惯例
find src/pi-mono -name "*.ts" -exec sed -i \
  -e 's/from "\([^"]*\)\.ts"/from "\1.js"/g' \
  -e 's/^import "\([^"]*\)\.ts"/import "\1.js"/g' \
  -e 's/import("\([^"]*\)\.ts")/import("\1.js")/g' \
  -e 's/("\([^"]*\)\.ts")/("\1.js")/g' {} +
```

### 3. agent-loop.ts 合并要点

本地补丁全部保留并适配新结构：工具循环守卫（failureStreak / maxToolCycles + 诊断注入）、sticky fallback、`streamAssistantResponse` 多模型 fallback（`llmContext = normalizeContext({ messages })`，per-model `getApiKey`、`onStreamRetry`、`finalized` 标志防双发 `message_end`）、v4 适配器 `isError` 透传。

**deferred 工具机制迁移（本次最大改动）**：上游 v0.86.0 删除了 `AgentToolResult.addedToolNames` 与 `ai/utils/deferred-tools.ts`，改为 transcript 系统消息声明工具。本项目的迁移方案（保持 `src/tools/tool-search/bridge-tools.ts` 与 app 侧不变）：

1. `agent/types.ts` 本地保留 `AgentToolResult.addedToolNames`（app 的 tool_search 桥接仍在写它）。
2. `agent.ts`：首条 system 消息只声明**非 deferred** 工具（`tools.filter(t => !t.deferred)`）。
3. `agent-loop.ts`：
   - 新增 `selectDeclarableTools()` 替代原 `compactToolsForPrompt()` —— 作为 `declareToolChanges()` 的声明目标，`context.tools` 中 deferred 且尚未在 transcript 中声明的工具不对外声明（执行集不受影响）。
   - `ExecutedToolCallBatch` 新增 `addedToolNames`，由 `collectAddedToolNames()` 从 finalized 结果收集；主循环用 `unlockDeferredTools()` 生成 `{ role:"system", toolsAdded:[...] }` 系统消息并 emit+入 transcript。此后 `getCurrentTools()` 回放即包含该工具 → transcript 作用域解锁，且能走上游原生 mid-convo 工具声明通道。

回归测试：`tests/tools/tool-search/deferred-resolution.test.ts` 新增「tool_search 报告后解锁」用例；原用例改为从 transcript（`getCurrentTools`）读取声明工具。

### 4. app 侧（src/）适配

- **`src/agent/convert-to-llm.ts`**：必须放行 `system` 消息。v0.86.0 起 system prompt 与工具声明都在 system 消息里，原实现会把它整条过滤掉（提示词与全部工具丢失）。测试同步更新。
- **`src/tools/registry.ts`**：`register()` 归一化 v4 `ToolDefinition`（`parametersSchema` → `parameters`）。v0.86.0 会在构建 transcript 工具声明时序列化每个工具的 `parameters`，直接注册的扩展工具（如 `web_search`）此前只有 `parametersSchema`，会抛 `"undefined" is not valid JSON`。
- **模型目录重命名（DeepSeek）**：v0.86.0 把 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 改为 **`deepseek-flash`**（V4.1 Flash，`input: ["text","image"]`），仅保留 `deepseek-v4-pro`（text-only）。已同步本地 `config.yaml`（`deepseek/deepseek-v4-flash` → `deepseek/deepseek-flash`）及相关测试；视觉桥接的「deepseek 不支持图像」用例改用 `deepseek/deepseek-v4-pro`。
- 测试期望更新：`Agent.state.messages` 现包含首条 system 消息（`agent-factory`、`e2e/message-flow`）。

### 5. 编译修复

0 处新增（`@google/genai` 升到 2.x 后 `FinishReason.TOO_MANY_TOOL_CALLS` 即解析成功）。

## 验证

- `pnpm build` — 0 错误；`pnpm typecheck`（src + ui）通过
- `pnpm test` — **227 文件 / 3403 通过**（4 环境跳过），exit 0
- `pnpm lint` — 0 errors（554 个既有 no-explicit-any warnings）
- `pnpm format:check` — 通过（`src/pi-mono` 在 `.prettierignore`，vendored 目录不做 prettier 格式化）
- `grep -rc "OhMyAgent" src/pi-mono --include="*.ts" | grep -v ':0$'` — 5 文件 28 处（agent-loop 15 / agent.ts 6 / agent/types.ts 5 / compat.ts 1 / ai/types.ts 1）
- **运行时实测**（dev server）：
  - `GET /webui/` 200、Vite transform 200；Bearer 认证下 config/providers/skills/agents/dashboard 等 API 全 200
  - `/api/providers/deepseek/models` 返回 `deepseek-flash, deepseek-v4-pro`
  - **端到端聊天**：`turn_start → thinking → text_delta → done`（usage 正常）
  - **端到端工具调用**：`tool_call_start → shell 执行 → tool_call_end → 最终回答`，命令输出 `OMA_TOOL_OK` 正确回传（验证 v0.86.0 transcript 工具声明 + 执行链路）
  - 服务日志 0 error

## 后续注意事项

- **`convertToLlm` 必须保留 system 消息**：这是 v0.86.0 的核心契约，任何再实现/包装该函数的地方都要放行 `system`。
- **工具必须有可序列化的 `parameters`**：新增扩展工具时，若直接注册到 legacy registry，务必提供 `parameters`（或依赖 `register()` 的 `parametersSchema` 归一化）。
- **deferred 解锁走系统消息**：`addedToolNames` 仍是 app 侧写入入口，但语义已变为「追加 toolsAdded 系统消息」，不要再期望它出现在 `ToolResultMessage` 上。
- `Agent.state.messages[0]` 现在是 system 消息；任何按下标假设首条为用户消息的代码/测试都需调整。
- 上游 agent `index.ts` 继续新增 harness 导出（不采纳）；下次升级仍需甄别非 harness 导出是否混入。
