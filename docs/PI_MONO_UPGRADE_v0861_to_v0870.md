# pi-mono v0.86.1 → v0.87.0 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-09-22 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.86.1（2026-09-21 嵌入） |
| 目标版本 | v0.87.0（2026-09-21 发布） |
| 升级难度 | **中** — minor 版本；嵌入的 `agent` 包有 Breaking Change（`shouldStopAfterTurn` → `finishTurn`/`prepareRequest`），且三个改动文件（agent-loop/agent/types）**全部带本地补丁**；`ai` 包新增 `inputLimits` 模型字段；无依赖版本变化 |

## 上游变更概要（仅覆盖本项目嵌入的 agent/ai/telemetry）

### agent 包（`packages/agent/src`）

与 v0.86.1 相比，仅 5 个文件变化，其中 2 个（`harness/pico3/chord.ts`、`harness/tools/image.ts`）不在嵌入范围。

- **Breaking：移除 `shouldStopAfterTurn`，新增 `finishTurn`**
  - `types.ts`：`ShouldStopAfterTurnContext` 重命名为 `AgentTurnContext`；新增 `AgentTurnDecision`（`{action:"continue"}` / `{action:"end"}`）与 `FinishTurn` 回调类型。
  - `agent-loop.ts`：正常 turn 现在先调用 `config.finishTurn(...)` **再**发 `turn_end`；`{action:"end"}` 结束 run。`{action:"continue"}` 会在没有其它自然请求（工具结果 / steering / follow-up）时，**额外**补一次纯上下文请求（`explicitContinuation` 标志）。
  - `agent-loop.ts`：error / aborted 分支现在也构造 `lastCompletedTurn` 并调用 `finishTurn`，随后才发 `turn_end` + `agent_end`。
- **新增 `prepareRequest`**：每次会话型 provider 请求（含首次）之前调用，返回的 `context`/`model`/`thinkingLevel` 会替换本次 run 的运行时值（不轮询队列）。
- `agent.ts`：`PendingMessageQueue` 新增 `peek()`（`drain()` 改为基于 `peek()`）；`Agent` 新增 `peekQueuedMessages()`；`shouldStopAfterTurn` 字段替换为 `finishTurn` + `prepareRequest`。
- `agent.ts` 的 `createLoopConfig` 不再包装 `this.signal`（`finishTurn`/`prepareRequest` 直接透传）。

> **对本项目的影响：无。** 全仓库（`src/`、`tests/`、`extensions/`、`ui/`）grep `shouldStopAfterTurn` 无任何引用；本项目未使用该回调，也暂未使用 `finishTurn`/`prepareRequest`。上游新类型经 `agent/index.ts` 的 `export * from "./types.js"` 自动导出。

### telemetry 包

- `packages/telemetry/src` 与 v0.86.1 **逐字节一致**。

### ai 包（`packages/ai/src`）

- **新增 `inputLimits`（按模型配置图片输入限制）**
  - `types.ts`：新增 `ModelImageResizeOptions` / `ModelImageInputLimits` / `ModelInputLimits`；`Model` 新增可选 `inputLimits?: ModelInputLimits`。用于「进入会话历史前」的 cache-safe 图片缩放（附件、`read`、工具结果图片）。
  - `providers/faux.ts`：`FauxModelDefinition` 透传 `inputLimits`。
- **`api/openai-completions.ts`**：OpenAI 兼容端点默认 `supportsStrictMode: false`（兼容性本身不代表支持 strict JSON-schema 工具），改为由生成的模型目录（`compat.supportsStrictMode`）显式开启。即上游 [#9816](https://github.com/earendil-works/pi/issues/9816) 的修复。
- `types.ts` 中 `supportsStrictMode` 的文档改为「默认 false，由有能力的模型显式开启」。

### 上游其余变更（不在嵌入范围）

`coding-agent` 包的 canonical session context、`ContextEditEntry`、`context_with_system`、extension boundaries、`SessionManager` 规范化等，均属于 harness，本项目未嵌入。

## 依赖升级

无。`@anthropic-ai/sdk`（0.124.0）、`@aws-sdk/client-bedrock-runtime`（3.1127.0）、`@google/genai`（2.21.0）、`@smithy/node-http-handler`（4.12.1）、`typebox`（1.3.27）与 v0.86.1 一致；仅包内 `@earendil-works/*` 自引用版本号 0.86.1 → 0.87.0（嵌入式无需处理）。

## 升级步骤（实际执行）

### 1. 补丁盘点

先 `git diff` 上游 v0.86.1 → v0.87.0，确认改动文件与本地补丁的交集：

| 文件 | v0.87.0 处理方式 |
|---|---|
| agent/agent-loop.ts | 上游改动 + **本地补丁（15 处）** → 三方合并 |
| agent/agent.ts | 上游改动 + **本地补丁（6 处）** → 三方合并 |
| agent/types.ts | 上游改动 + **本地补丁（5 处）** → 三方合并 |
| ai/types.ts | 上游改动 + **本地补丁（1 处）** → 三方合并 |
| ai/api/openai-completions.ts | 无本地补丁，直接采用上游版 |
| ai/providers/faux.ts | 无本地补丁，直接采用上游版 |
| agent/index.ts、node.ts、stream-fn.ts、proxy.ts | 上游未变，保持本地版（`.js` 导入 + 精简导出） |
| telemetry/* | 上游未变，保持不动 |
| ai/compat.ts | 上游未变，保持不动 |
| ai/api/bedrock-converse-stream.ts、api/openai-codex-responses.ts、providers/xai.ts | 上游未变，保持不动（无 `OhMyAgent` 标记的类型补丁） |

### 2. 三方合并（`git merge-file`）

```bash
# base = 上游 0.86.1；ours = 当前本地（0.86.1 + 补丁）；theirs = 上游 0.87.0
git merge-file -p \
  src/pi-mono/agent/agent-loop.ts \
  /tmp/pi-0.86.1/packages/agent/src/agent-loop.ts \
  /tmp/pi-0.87.0/packages/agent/src/agent-loop.ts \
  > /tmp/merged-agent-loop.ts
# agent.ts / agent/types.ts / ai/types.ts 同理
```

四个文件全部 **exit=0，零冲突**。合并结果 = 上游 v0.87.0 + 本地补丁 + `.js` 导入。

### 3. 复制与 `.ts` → `.js` 归一化

```bash
cp /tmp/merged-agent-loop.ts src/pi-mono/agent/agent-loop.ts
cp /tmp/merged-agent.ts      src/pi-mono/agent/agent.ts
cp /tmp/merged-agent-types.ts src/pi-mono/agent/types.ts
cp /tmp/merged-ai-types.ts    src/pi-mono/ai/types.ts
cp /tmp/pi-0.87.0/packages/ai/src/api/openai-completions.ts src/pi-mono/ai/api/
cp /tmp/pi-0.87.0/packages/ai/src/providers/faux.ts         src/pi-mono/ai/providers/

find src/pi-mono -name "*.ts" -exec sed -i \
  -e 's/from "\([^"]*\)\.ts"/from "\1.js"/g' \
  -e 's/^import "\([^"]*\)\.ts"/import "\1.js"/g' \
  -e 's/import("\([^"]*\)\.ts")/import("\1.js")/g' \
  -e 's/("\([^"]*\)\.ts")/("\1.js")/g' {} +
```

### 4. 数据目录同步（npm pack）

```bash
cd /tmp && npm pack @earendil-works/pi-ai@0.87.0 --silent
tar xzf earendil-works-pi-ai-0.87.0.tgz
diff -rq package/dist/providers/data/ src/pi-mono/ai/providers/data/
cp -r package/dist/providers/data/. src/pi-mono/ai/providers/data/
```

结果：41 个 JSON，**全部 41 个都与 v0.86.1 不同**：

- **40 个新增 `inputLimits.images.resize`**（如 `deepseek-flash`：`{maxWidth:2000,maxHeight:2000,maxBytes:4718592,jpegQuality:80}`），即 v0.87.0 的按模型图片缩放配置。
- 部分模型 `compat.supportsStrictMode` 由缺省改为显式 `true`（配合 `openai-completions` 默认 false 的改动）。
- 模型 id 变化（仅 5 个文件）：
  - `huggingface.json`：+`tencent/Hy4-preview`
  - `nvidia.json`：−`deepseek-ai/deepseek-v4-flash-0731`
  - `opencode-go.json`：+`grok-4.7`
  - `openrouter.json`：+`x-ai/grok-4.7`，−`anthropic/claude-opus-4`
  - `vercel-ai-gateway.json`：+`spacexai/grok-4.7`

### 5. 无需 app 侧改动

Breaking Change 涉及的回调本项目未使用；`inputLimits` 是可选的新模型字段，消费方（图片缩放）在 coding-agent 内，未嵌入。`src/`、`ui/`、测试均无需修改。

## 验证

- `pnpm build` — 0 错误
- `pnpm typecheck`（src + ui）— 通过
- `pnpm test` — **227 文件 / 3404 通过**（4 环境跳过），与 v0.86.1 一致
- `pnpm lint` — 0 errors（554 个既有 warning）
- `pnpm format:check` — 通过
- `grep -rc "OhMyAgent" src/pi-mono --include="*.ts" | grep -v ':0$'` — **5 文件 28 处**（与 v0.86.1 一致）：
  `agent/agent-loop.ts`(15)、`agent/agent.ts`(6)、`agent/types.ts`(5)、`ai/compat.ts`(1)、`ai/types.ts`(1)
- 非标记本地补丁确认仍在：`bedrock-converse-stream.ts` 2× `as any`、`openai-codex-responses.ts` 1× `as BodyInit`、`xai.ts` 泛型放宽、`ai/compat.ts` 自定义注册表、`ai/utils/oauth/` 本地目录
- 供应商 / 模型目录校验（tsx 直接调用 `@earendil-works/pi-ai`）：
  - `getProviders()` → 41 个 provider，`deepseek`/`meta` 均在
  - `getModel("deepseek","deepseek-flash")` → `openai-completions`，`input:["text","image"]`，**`inputLimits.images.resize` 存在**
  - `getModels("meta")` → `muse-spark-1.1/1.2/1.2-contributor/1.3/1.3-contributor`
  - `registerModel` 自定义注册表仍生效（`getModel` / `getModels` 均可查到）
- **运行时实测**（dev server，port 9191）：
  - 启动日志：`Computer Use: registered Windows local provider (windows:local, UIA)`、`defaultProviderId: "windows:local"`、**0 条 non-JSON warning**（UIA 原生 Windows 路径修复保持有效）
  - `GET /api/health`、`/api/providers`、`/api/providers/meta/models`、`/api/providers/deepseek/models`、`/api/agents`、`/api/skills`、`/api/projects`、`/webui/` — 全 200
  - **端到端聊天 + 工具调用**：`turn_start → (stream_retry×13，走过 rate-limited 的 fallback 链) → thinking → tool_call_start(shell) → tool_call_end(isError=false) → text_delta → done`，offload 文件确认 shell 输出为 `OMA_0870_OK`
  - fallback/retry 本地补丁在真实环境中生效（13 次 `stream_retry`，最终落到 `deepseek/deepseek-flash` 成功）
  - 服务日志 0 error

## 后续注意事项

- **`shouldStopAfterTurn` 已从上游移除**，改用 `finishTurn` + `prepareRequest`。本项目当前未使用；若将来需要「优雅停止 / 每请求改模型」，按 `types.ts` 的 `FinishTurn` / `PrepareRequest` 契约实现，注意 `finishTurn` 在 `turn_end` 之前运行、且 error/aborted 分支也会调用。
- **`inputLimits` 是数据目录（npm pack）才有的字段**，源码 `types.ts` 只是类型；升级 `ai` 包后务必同步 `providers/data/`，否则模型拿不到图片缩放配置（参见 `PI_MONO_UPGRADE_NOTES.md` 第 1 节）。
- 本地补丁清单本次无变化，仍以 `docs/PI_MONO_LOCAL_PATCHES.md` 与 `docs/PI_MONO_UPGRADE_NOTES.md` 第 3 节为准。
