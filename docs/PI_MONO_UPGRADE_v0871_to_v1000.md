# pi-mono v0.87.1 → v1.0.0 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-10-03 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.87.1（2026-09-26 嵌入） |
| 目标版本 | v1.0.0（2026-10-01 发布，major） |
| 升级难度 | **高** — 上游首个 major 版本；`ai` 包重构（模型目录多类型化、classifier API、image API 重命名），`agent` 包删除 `harness/`、`search/`、`node.ts`；`openai` SDK 6.x → 7.x。**本地补丁全部干净合并，app 侧零改动**（仅依赖版本一处） |

## 上游变更概要（仅覆盖本项目嵌入的 agent/ai/telemetry）

### telemetry 包

- `packages/telemetry/src` 与 v0.87.1 **逐字节一致**（仅新增未嵌入的 `testing/`）。

### agent 包（`+284` 行级变更）

- **删除**：`harness/`（约 110 个文件）、`search/`、`node.ts`，以及 `package.json` 中的
  `./node`、`./harness/*`、`./experimental/pico3` 子路径导出。`agent` 包收敛为纯核心：
  `agent.ts` / `agent-loop.ts` / `index.ts` / `proxy.ts` / `stream-fn.ts` / `types.ts`。
  依赖从 `chord + pi-ai + pi-telemetry + diff + ignore + typebox + yaml` 缩减为
  **`pi-ai + typebox`**。
- `index.ts` 变成极简导出（`agent` / `agent-loop` / `proxy` / `stream-fn` / `types`）——
  与本地一直维护的最小 index 现在几乎一致，差异只剩本地多出的 `export { uuidv7 }`。
- **`agent.ts`**：新增 `onProviderStreamEvent` 透传（对应 `ai` 的新 `StreamOptions` 字段）。
- **`agent/types.ts`**：新增 `AgentToolCallOutcome`、`AgentToolResult.structuredContent`、
  `AgentToolResult.isError`、`AfterToolCallResult.structuredContent`、`AgentTool.outputSchema`；
  `execute` 语义改为「抛错**或**返回 `isError: true`」。
- **`agent-loop.ts`**：
  - `executePreparedToolCall` 的第三个参数从 `AgentEventSink` 改为 `ToolUpdateSink`；
  - 新增导出 `runToolCall()` / `ToolCallHooks` / `RunToolCallOptions` / `emitToolExecutionUpdate`
    （供「工具内再调工具」，如 codemode 脚本，复用 before/after hook 与校验）；
  - `thinkingLevel` 现在写回 assistant 消息（`result()` 包装 `response.result()`）；
  - **`isError` 上浮已成为上游行为**（`return { result, isError: result.isError === true }`）——
    本项目的同名本地补丁（v0.86.0 引入）因此退役；
  - `afterToolCall` 返回的 `structuredContent` 与 `content` 的一致性处理。

### ai 包（`+3236` 行级变更，最大的部分）

- **模型目录多类型化（本版本最关键的约定变化）**：生成数据 `providers/data/*.json` 的 key
  现在带类型前缀 —— `chat:<id>`、`image:<id>`、`classifier:<id>`，条目内新增 `"type"` 字段。
  `model-catalog.ts` 的 `flattenChatModelCatalog` / `flattenImageModelCatalog` /
  `flattenClassifierModelCatalog` 按 `type` 过滤并**以去前缀的 `model.id` 作为最终 key**，
  所以 `MODELS` / `IMAGE_MODELS` / `CLASSIFIER_MODELS` 对外仍是「provider → 无前缀 id」。
  → `getModel("xai", "grok-4.7")` 等调用不受影响（已实测）。
- **类型重命名 / 拆分**：
  - `ImagesModel` → `ImageModel`，`ImagesApi` → `ImageApi`，`ImagesProviderId` → `ProviderId`，
    `KnownImagesApi` → `KnownImageApi`，`KnownImagesProvider` 删除；
  - `Model<TApi>` 拆成 `BaseModel<TApi>`（共享字段）+ `Model<TApi>`（`type?: "chat"`）+
    `ImageModel<TApi>`（`type: "image"`）+ `ClassifierModel<TApi>`（`type: "classifier"`）；
    新增 `ModelType` / `ModelTypeMap` / `AnyModel` / `getModelType()` / `isModelType()`。
- **新增 classifier（结构化分类）API**：`typesafe-system-one`、`cloudflare-workers-ai-system-one`、
  `llama-cpp-classify` 三种 API，配套 `ProviderClassifier` / `ClassifierOptions` /
  `ClassifierContext` / `ClassifierQuestion` / `ClassifierAnswer` / `ClassifierResult` 等类型，
  以及新 provider `typesafe`（`providers/typesafe.ts` + `typesafe.json`，仅有 classifier 模型）。
- **新增 OpenAI ChatGPT OAuth**：`auth/oauth/openai-chatgpt.ts`、`auth/oauth/callback-server.ts`；
  删除 `auth/oauth/oauth-page.ts`（迁到 `utils/oauth-page.ts`）。
- **删除文件**：`images-models.ts`（`ImagesModels` 运行时并入 `Models`，改由
  `Models.getModelOfType("image", …)` / `getBuiltinImageModel()` 访问）、
  `image-models.generated.ts`（并入 `models.generated.ts` 的 `IMAGE_MODELS`）、
  `providers/openrouter-images.ts`。
- **新增工具模块**：`utils/model-operations.ts`、`utils/models-error.ts`。
- `index.ts` 仅去掉 `export * from "./images-models.ts"`。
- **`openai` SDK：`6.40.0` → `7.19.0`**（`api/openai-completions.ts`、`openai-responses*.ts` 依赖）。
  其余依赖（`@anthropic-ai/sdk` 0.124.0、`@aws-sdk/client-bedrock-runtime` 3.1127.0、
  `@google/genai` 2.21.0、`@smithy/node-http-handler` 4.12.1、`typebox` 1.3.27）不变。

### 新增独立包（**未嵌入**，但与 MCP 相关）

- **`packages/mcp`** → npm 包 `@earendil-works/pi-mcp@1.0.0`：独立 MCP 客户端
  （stdio / streamable-http / in-memory 传输、OAuth 子集、`toLlmContent()`、testing 模块），
  唯一依赖 `cross-spawn`。
- `packages/codemode` → `@earendil-works/pi-codemode@1.0.0`。

这两个包只被 `coding-agent` 使用，**不在本项目的嵌入范围内**。若要在 OhMyAgent 中接入 MCP，
需要单独引入（见文末「MCP 接入」一节）。

## 升级步骤（实际执行）

### 1. 差异盘点

```bash
diff -rq pi-0.87.1/packages/agent/src     pi-1.0.0/packages/agent/src
#   agent-loop.ts, agent.ts, index.ts, types.ts 改动
#   Only in 0.87.1: harness/ (110 files), node.ts, search/
diff -rq pi-0.87.1/packages/telemetry/src pi-1.0.0/packages/telemetry/src   # 无输出
diff -rq pi-0.87.1/packages/ai/src        pi-1.0.0/packages/ai/src          # 大量
```

本地补丁集合用「去掉 `.ts`/`.js` 导入后缀后再比对」的方式精确定位（否则每个文件的
import 后缀差异都会污染 diff）：

| 包 | 有实质本地改动的文件 |
|---|---|
| agent | `agent-loop.ts`、`agent.ts`、`types.ts`（+ 本地化的 `index.ts`） |
| ai | `types.ts`、`compat.ts`、`api/bedrock-converse-stream.ts`、`api/openai-codex-responses.ts`、`providers/xai.ts`、`utils/oauth/*`（本地独有） |

### 2. agent 包

对 3 个补丁文件用三方合并（ours = 仓库，base = 上游 v0.87.1，theirs = 上游 v1.0.0，
三方都先做 `.ts` → `.js` 归一化，避免 import 后缀造成假冲突）：

```bash
git merge-file -p ours base theirs   # agent.ts / types.ts 干净；agent-loop.ts 4 处冲突
```

`agent-loop.ts` 的 4 处冲突全部来自上游重写 `streamAssistantResponse`：

1. 模型循环 vs 上游单模型调用 → 保留本地 fallback 循环，并把上游新的
   `const result = async () => Object.assign(await response.result(), { thinkingLevel: … })`
   搬进循环内（每个 fallback 尝试各自包装）；
2. 事件循环后的收尾分支 → 保留本地 `finalized` + 防御性收尾；
3. 函数末尾 → 保留本地 `lastError` 兜底；
4. `isError` 上浮 → **采用上游**（本地补丁退役），改为上游写法。

其余：`index.ts` 保留本地 `uuidv7` 再导出；`proxy.ts` / `stream-fn.ts` 与上游一致；
**删除 `node.ts`**（上游移除，且仓库内无任何引用）。

### 3. ai 包

整树替换（保留 `providers/data/` 与本地 `utils/oauth/`），脚本同时删除上游已移除的文件：

```bash
node aisync.mjs pi-1.0.0/packages/ai/src src/pi-mono/ai
# copied: 193, removed: auth/oauth/oauth-page.ts, image-models.generated.ts,
#                       images-models.ts, providers/openrouter-images.ts
```

再对 5 个补丁文件做同样的三方合并 —— **5/5 干净，0 冲突**（`openai-codex-responses.ts`
的 `as BodyInit`、`bedrock-converse-stream.ts` 的 2× `as any`、`xai.ts` 泛型放宽、
`types.ts` 的 `onStreamRetry`、`compat.ts` 的自定义注册表，落点都还在）。

### 4. `.ts` → `.js` 导入归一化

```bash
find src/pi-mono -name "*.ts" -exec sed -i \
  -e 's/from "\([^"]*\)\.ts"/from "\1.js"/g' \
  -e 's/^import "\([^"]*\)\.ts"/import "\1.js"/g' \
  -e 's/import("\([^"]*\)\.ts")/import("\1.js")/g' \
  -e 's/("\([^"]*\)\.ts")/("\1.js")/g' {} +
```

> 第 4 条 `("...")` 形式覆盖了 `importNodeOnlyApi("./x.ts")`、`importOAuthModule("./x.ts")`
> 这类「把动态 import 包在辅助函数里」的写法（`api/*.lazy.ts`、`auth/oauth/load.ts`）。

### 5. 数据目录同步（npm pack）

```bash
npm pack @earendil-works/pi-ai@1.0.0
cp -r package/dist/providers/data/. src/pi-mono/ai/providers/data/
```

42 个 JSON（新增 `typesafe.json`）+ `.manifest.json`，全部发生变化（含前缀改造）。
**模型 id 本身没有变化**——变化的是 key 前缀与 `type` 字段，`flatten*ModelCatalog`
会把前缀去掉，因此 app 侧无感。

### 6. 依赖

`package.json`：`openai` `6.40.0` → `7.19.0`（与上游 `pi-ai@1.0.0` 对齐）。
仓库内**没有**任何非 `src/pi-mono` 代码直接 `import "openai"`，因此这是零风险的版本对齐。

### 7. app 侧改动：无

`tsc` / `tsc --noEmit` 一次通过，**未改动 `src/`、`extensions/`、`ui/` 任何文件**。原因：
- 项目通过 `tsconfig.json` 的 paths 把 `@earendil-works/pi-ai` 指向 `compat.ts`，而
  `compat.ts` 保留了旧的全局 API（`stream` / `complete` / `getModel` / `getModels` /
  `getProviders` / `registerModel`），上游 `models.ts` 的 `Model`/`ModelType` 重构没有外溢；
- 项目不使用 image-generation / classifier API，`ImagesModel → ImageModel` 重命名无影响；
- 项目不使用 `pi-agent-core/node`、`harness/*` 子路径；
- `agent-loop` 的 `isError` 语义变化由上游接管，行为不变。

## 验证

- `pnpm build` — 0 错误
- `pnpm typecheck`（src + ui）— 通过
- `pnpm test` — **228 文件 / 3412 通过**（4 环境跳过）。首次运行时 `logger-self-heal`
  与 `image-to-text`（两者都依赖 10s 全局 timeout）在机器高负载下超时，单独与重跑均通过，
  属负载抖动而非功能回归（`collect` 314s → 204s，`Duration` 129s → 92s）
- `pnpm lint` — 0 errors（554 个既有 warning）
- `pnpm format:check` — 通过
- 本地补丁盘点：**5 文件 / 27 处 `OhMyAgent` 标记**（agent-loop 15→14，因 `isError` 上浮
  已由上游实现；其余不变）
- 非标记本地补丁确认在位：`bedrock-converse-stream.ts` 2× `as any`、
  `openai-codex-responses.ts` 1× `as BodyInit`、`xai.ts` 泛型放宽、
  `ai/compat.ts` 自定义注册表、`ai/utils/oauth/`
- 供应商 / 模型目录（tsx 直接调用 compat）：
  - `getProviders()` → **42**（新增 `typesafe`）；`getModels("typesafe")` → `[]`（仅 classifier）
  - 新模型全部可解析：`anthropic/claude-opus-5-5`、`xai/grok-4.7`、`openai/gpt-6-sol`、
    `openai/gpt-6-astra`、`openai-codex/gpt-6.1-sol`、`github-copilot/grok-4.7`、
    `opencode/claude-opus-5-5`、`moonshotai/kimi-k3`、`zai/glm-5.3`、
    `openrouter/anthropic/claude-opus-5.5`、`vercel-ai-gateway/spacexai/grok-4.7`、
    `radius/claude-opus-5-5`、`together/moonshotai/Kimi-K3` 等
  - `inputLimits` / `thinkingLevelMap` 正常；`registerModel` 自定义注册表仍生效
- **运行时实测**（dev server，port 9191）：
  - 启动 `defaultProviderId: "windows:local"`，**0 error / 0 non-JSON warning**
  - `/api/health`、`/api/providers`（42 个）、`/api/providers/{anthropic,xai,openai,typesafe}/models`、
    `/api/agents`、`/api/skills`、`/api/projects`、`/webui/` — 全 200
  - **端到端聊天 + 工具调用**：`turn_start → stream_retry×13 → thinking →
    tool_call_start(shell) → tool_call_end(isError=false) → text_delta → done`，
    offload 确认 shell 输出 `OMA_100_OK`
  - 服务日志仅 6 条外部 provider 失败（agnes 429 / nvidia / opencode），无 app 级 error

## 遗留 / 注意

- `/api/providers`（Settings → 内置供应商列表）现在会多出一个 `typesafe`，它只有 classifier
  模型、`baseUrl` 为空。`/api/providers/configured`（Agent 编辑器的模型选择器）只列出配置了
  key 的 provider，因此不受影响。属上游目录扩张带来的展示层噪音，未改动 app。
- `MODELS` / `IMAGE_MODELS` / `CLASSIFIER_MODELS` 的 key 前缀约定由 `model-catalog.ts` 消化；
  以后若自行解析 `providers/data/*.json`，必须先剥离 `chat:` / `image:` / `classifier:` 前缀。
- `openai` 7.x 是本项目新的 SDK 基线；升级该依赖前先确认 `pi-ai` 的上游要求。
- `@earendil-works/pi-mcp` / `pi-codemode` **未嵌入**。接入 MCP 需要新增依赖与适配层。

## MCP 接入要点

v1.0.0 把 MCP 做成**独立包** `@earendil-works/pi-mcp`（不依赖官方 MCP SDK，不依赖其他 pi 包），
由 `coding-agent` 的 `src/extensions/mcp/` 消费。OhMyAgent 目前没有任何 MCP 支持。
接入所需的调整（依赖、配置、工具适配、生命周期、权限、OAuth、与 deferred/tool_search 的配合）
汇总如下：

1. **依赖**：新增 `@earendil-works/pi-mcp@^1.0.0`（+ 其唯一依赖 `cross-spawn`）。
2. **配置**：新增 MCP 服务器清单（上游为 `mcp.json` 的 `mcpServers` 形状），字段
   `command`/`args`/`env`/`cwd`（stdio）或 `url`/`headers`/`oauth`（streamable HTTP），
   外加 `timeout`、`enabled`、`exposure`、`toolExposure`、`description`。
3. **工具适配**：`McpClient.listTools()` → `AgentTool[]`，名字 `mcp__<server>__<tool>`
   （仅 `[A-Za-z0-9_]`，≤64 字符，冲突加 8 位 hash 后缀），`inputSchema` 经
   `Type.Unsafe({...schema, type: "object", properties: schema.properties ?? {}})` 转成
   `parameters`，结果用 `toLlmContent()` 转 `content`，`isError: result.isError === true`。
4. **生命周期**：会话/进程启动时后台连接所有 `enabled` 服务器；断线在下次调用时重连；
   服务器 `tools/list_changed` 通知要增删工具；关闭时按 MCP 规范终止 stdio 进程组
   （关 stdin → SIGTERM → SIGKILL，覆盖 `npx`/`uvx` 包装进程）。
5. **权限**：所有 MCP 调用必须走 OhMyAgent 现有的工具管线与审批门（`src/policy/`），
   并把服务器声明的 `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`
   透传给审批策略。
6. **暴露策略**：默认不要把 MCP 工具直接声明给模型。上游提供 `direct` / `deferred` /
   `codemode` / `hidden` 四档；OhMyAgent 没有 codemode，因此应把 `deferred` 作为默认，
   直接复用本项目已有的 deferred 机制（`AgentTool.deferred` + `tool_search` +
   `AgentToolResult.addedToolNames` → agent-loop 转成 `toolsAdded` 系统消息）。
   这也是 v1.0.0 修掉的 bug 所在（`tool_search` 载入的 deferred MCP 工具在 resume/`/reload`
   后被丢弃，因为会话在 MCP 服务器重连前就恢复了工具集）。
7. **资源工具**：可选实现 `list_mcp_resources` / `list_mcp_resource_templates` /
   `read_mcp_resource` 三个只读工具。
8. **OAuth**：`@earendil-works/pi-mcp/oauth` 提供 PKCE 授权码流程、动态客户端注册、
   token 刷新、`insufficient_scope` 升级授权；凭证存储需自行实现
   （`McpOAuthStateStore`），可落到 OhMyAgent 的 SQLite。
9. **输出截断**：上游对超过 20 KB 的文本结果保留首尾、中间截断，并把完整内容写入临时文件
   返回路径；OhMyAgent 已有 `data/offload/` 卸载机制，应改为走该机制而非 `tmpdir()`。
