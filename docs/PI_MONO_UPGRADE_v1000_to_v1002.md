# pi-mono v1.0.0 → v1.0.2 升级实施记录

## 版本信息

| 项目     | 内容                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 日期     | 2026-10-06                                                                                                                                          |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)                                                                                                          |
| 源版本   | v1.0.0                                                                                                                                              |
| 目标版本 | v1.0.1 + v1.0.2（2026-10-03 / 2026-10-04）                                                                                                          |
| 升级难度 | **低** — 两个小版本；`agent` / `telemetry` 源码零变化；`ai` 包 11 个文件、`mcp` 包 4 个文件变更。本地补丁全部保留，**app 侧零改动**（依赖一处对齐） |

## 上游变更概要（仅覆盖本项目嵌入的 agent/ai/telemetry/mcp）

### v1.0.1（2026-10-03）

- **Anthropic 内联工具定义**：原生支持 mid-conversation 工具变更的模型改用
  `inline-tools-2026-09-15` beta —— `tool_addition` 块以值定义工具而非追加到顶层工具表，
  同名重定义不再整体重发工具列表（prompt cache 得以存活）。`@anthropic-ai/sdk`
  0.124.0 → **0.129.0**。`hasToolRedefinitions()` 已弃用（无内建 transport 再需要）。
- 修复："Selected model is at capacity" provider 错误终结回合而非重试
- 修复：Cloudflare AI Gateway 的 Claude 模型 404（改用虚线模型 id `claude-opus-5-5`）
- 修复：Sign in with ChatGPT 回调端口被占用时继续流程导致 "OAuth state mismatch"（现在报端口占用错误）
- 修复：Amazon Bedrock Claude 在 system prompt / 工具变更后报
  "Invalid `signature` in `thinking` block"（Opus 4.7+/Sonet 5+/Fable 5 现在与 Anthropic
  provider 一样丢弃过期 thinking 块）
- 修复：Bedrock OpenAI 模型 272k input tokens 以上的定价分层（接入 models.dev tiers）
- 修复：Together 的 DeepSeek V4 Pro 更名 `deepseek-ai/DeepSeek-V4-Pro-0813` 后丢失 thinking level
- 新增：Cloudflare Clef / Clef Flash classifier 模型

### v1.0.2（2026-10-04）

- **新增** `samplingParamsByThinkingLevel`：按 pi thinking level 选择采样参数覆盖，
  适用于 `openai-completions` / `openai-responses` / `azure-openai-responses`（#9776）。
  `SimpleStreamOptions` 层新增 `resolveSamplingParams()` 合并
  `model.samplingParams` + level 覆盖 + 请求级参数。

### mcp 包（v1.0.1，**Breaking**）

- `OAuthClientProvider.clientMetadataUrl` 替换为
  `clientMetadataDocument(metadata)`：返回文档 URL 与 redirect URI（按授权服务器），
  或 `undefined` 表示动态注册；未存任何 client 信息时都会调用（即使服务器不宣布支持）。
  新增 `McpOAuthProviderOptions.clientMetadataDocument`、
  `OAuthCallbackServerOptions.extraPaths`、`waitForCallback(path)`。
  → 本项目 app 侧没有任何 `clientMetadataUrl` 引用（grep 确认），无需改动。

## 变更文件清单（上游，归一化导入后缀后精确 diff）

### ai 包（11 个文件）

| 文件                                                                                      | 变化                                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `api/anthropic-messages.ts`                                                               | 内联工具定义（67 行级变更）                                                                                   |
| `api/azure-openai-responses.ts` / `api/openai-completions.ts` / `api/openai-responses.ts` | `resolveSamplingParams` 接入（14 行级变更）                                                                   |
| `api/bedrock-converse-stream.ts`                                                          | 丢弃过期 thinking 块 + 分层定价（含本地补丁重放区）                                                           |
| `api/cloudflare-workers-ai-system-one.ts`                                                 | Clef / Clef Flash（20 行级变更）                                                                              |
| `api/simple-options.ts`                                                                   | 新增导出 `resolveSamplingParams()`（17 行级变更）                                                             |
| `auth/oauth/openai-chatgpt.ts`                                                            | 回调端口占用即失败（23 行级变更）                                                                             |
| `types.ts`                                                                                | `SamplingParams` / `SamplingParamsByThinkingLevel` 类型 + `samplingParamsByThinkingLevel` 字段（10 行级变更） |
| `utils/retry.ts`                                                                          | Retry-After 日期解析回退（1 行）                                                                              |
| `utils/transcript.ts`                                                                     | `hasToolRedefinitions` 弃用注释（7 行）                                                                       |

### agent / telemetry 包

**零变化**（v1.0.0 与 v1.0.2 源码逐字节一致，仅版本号）。本地 agent 补丁（agent-loop /
agent / types / index）无需任何合并。

### mcp 包（4 个文件）

`oauth/callback.ts`、`oauth/flow.ts`、`oauth/index.ts`、`oauth/provider.ts` —— 全部是
#10302 的 `clientMetadataDocument` 重构；零本地补丁，直接整树替换。

## 升级步骤（实际执行）

```bash
git clone --depth 1 --branch v1.0.2 https://github.com/earendil-works/pi /tmp/pi-1.0.2
# 归一化（去 .ts/.js 后缀）后 diff 确认本地补丁文件范围，见 docs/PI_MONO_LOCAL_PATCHES.md
```

1. **三方合并**（ours=v1.0.0 vendored / base=u1.0.0 / theirs=u1.0.2，归一化后
   `git merge-file`）：`ai/types.ts`、`ai/api/bedrock-converse-stream.ts` —— **2/2 零冲突**。
   其余 5 个补丁文件上游未动，直接保留本地版（`compat.ts`、`openai-codex-responses.ts`、
   `xai.ts` 在整树覆盖后从备份还原）。
2. **ai 整树替换**：`aisync.mjs /tmp/pi-1.0.2/packages/ai/src src/pi-mono/ai`（copied 193,
   removed 0 —— 上游无删除）+ 放回两个合并产物 + 还原 3 个补丁文件。
3. **mcp 整树替换**：`cp -r /tmp/pi-1.0.2/packages/mcp/src/. src/pi-mono/mcp/`。
4. **`.ts` → `.js` 导入归一化**（标准 4 条 sed，见 PI_MONO_UPGRADE_NOTES/AGENTS.md）。
   注意：合并产物基于"去后缀"副本，直接拷入会缺 `.js`，需要针对文件再补一次后缀
   （仅 `ai/types.ts` 与 `ai/api/bedrock-converse-stream.ts` 两处相对导入）。
5. **providers/data 同步**：`npm pack @earendil-works/pi-ai@1.0.2` → 覆盖整个目录。
   变更：`.manifest.json`、`amazon-bedrock`、`cloudflare-ai-gateway`、
   `cloudflare-workers-ai`（新 Clef 模型）、`fireworks`、`nvidia`、`opencode`、
   `openrouter` 等 8 个 JSON（含 models.dev 分层定价数据）。
6. **依赖**：`package.json` `@anthropic-ai/sdk` `^0.124.0` → `^0.129.0`（与上游 pi-ai@1.0.2
   对齐；仓库内无直接 import，纯被动跟随）。`openai` SDK 本版上方未变（仍 7.19.0 基线）。
7. **VERSION**：`src/pi-mono/VERSION` → `v1.0.2` / `pi-mcp v1.0.2 (embedded, no local patches)`。

## 验证

- `npx tsc --noEmit` — 0 错误；`pnpm build` 0 错误；ui `tsc --noEmit` 通过
- `pnpm test` — **244 文件 / 3787 通过**（4 环境跳过；对照升级前 3778，新增来自
  上游数据变化的模型目录测试差异，无失败）
- `pnpm lint` — 0 errors（既有 no-explicit-any warnings）
- `pnpm format:check` — 通过
- 本地补丁盘点：**5 文件 / 27 处 `OhMyAgent` 标记**（agent-loop 14、agent 6、
  agent/types 5、ai/compat 1、ai/types 1）+ 4 处非标记补丁全部确认在位
  （bedrock 2× `as any`、openai-codex-responses `as BodyInit`、xai 泛型放宽、
  compat 自定义注册表、utils/oauth/ 本地独有目录）
- 定向测试：`tests/agent`（fallback / retrying-stream / deferred）、
  `tests/w0/pi-mono-import.test.ts`、`tests/mcp`（manager / oauth / 打通）— 681 全绿
- `src/pi-mono/mcp` 与上游 v1.0.2 归一化 diff — **零差异**（整树一致，0 本地标记）

## 遗留 / 注意

- `samplingParamsByThinkingLevel` 是 Model 字段级的新能力，本项目 config.yaml 的
  自定义模型如需按 thinking level 覆盖采样参数可直接使用（`registerModel` 传入的
  `Model` 对象原生支持）。
- `hasToolRedefinitions()` 上游已弃用但保留导出，无需行动；本项目未引用。
- mcp oauth 的 `clientMetadataDocument` breaking change 不影响本项目（无引用），
  但未来若自实现 `OAuthClientProvider` 必须改用新接口。
- `@anthropic-ai/sdk` 0.129.0 为新基线（pnpm 提示 0.131.0 可用，跟随上游为准）。
