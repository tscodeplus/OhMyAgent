# pi-mono v0.84.4 → v0.85.1 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-09-10 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.84.4（2026-08-30 嵌入） |
| 目标版本 | v0.85.1（跨 v0.85.0 + v0.85.1 两个版本） |
| 升级难度 | **低** — agent 包非 harness 部分仅 `agent-loop.ts`（1 处）、`types.ts`（2 行）、`proxy.ts`（流终止健壮性）、`index.ts`（纯 harness 导出，不采用）；ai 包为若干 API 适配器增强；telemetry 无变化 |

## 上游变更概要（仅覆盖本项目嵌入的 agent/ai/telemetry）

### agent 包
- `agent-loop.ts`：`executePreparedToolCall` 执行前检查 `signal?.aborted`，已中止的调用直接返回 `Operation aborted` 错误结果（不再真正执行工具）。**已合并进本地版。**
- `types.ts`：`AgentTool` 新增 `replay?: "never" | "safe"`（durable intent 恢复策略）。**已合并进本地版。**
- `proxy.ts`：SSE 事件解析改为 `processLine` 提取 + `providerThinkingLevel` 透传 + EOF flush + 「未收到 terminal 事件则补发 error」；**直接采用上游版**（本地无补丁）。
- `index.ts`：上游新增大量 harness/context/runtime 导出（`harness/context`、`harness/runtime/reducer`、`Shell*` 类型等）。本项目不嵌 harness，**维持本地精简版不动**。
- harness/**、search/**：照旧不嵌入（harness 本版重构极大：`config.ts`/`context.ts`/`hooks.ts`/`runtime/`/session fork+in-memory storage 等）。

### ai 包
- `types.ts`：注释/文档更新；`JsonValue` 联合排序；`AssistantMessage.providerThinkingLevel`；`OpenAICompletionsCompat.vllmPriority`；`OpenAIResponsesCompat.supportsMaxOutputTokens` + prompt-cache 注释；`AnthropicMessagesCompat.supportsMidConvoEffort`。**已合并进本地版（onStreamRetry 补丁原位保留）。**
- `api/anthropic-messages.ts`：**改用 `@anthropic-ai/sdk` 0.123.0 的 `beta/messages` 路径类型**（`BetaRawMessageStreamEvent` 等）、mid-conversation-output-config / thinking-binding-controls beta 头、fallback content-block 处理。**依赖从 0.91.1 → 0.123.0，全仓仅此一个文件使用该 SDK。**
- `api/openai-responses.ts` / `openai-responses-shared.ts`：`prompt_cache_options.ttl: "30m"`（GPT-5.6+ 长缓存）、`supportsMaxOutputTokens` 门控、`errorMessage: undefined` 不再写入。
- `api/openai-completions.ts`：`vllmPriority` 兼容项透传。
- `api/openai-codex-responses.ts`：SSE EOF 处理（residual frame 以 `\n\n` 收尾再 break）。**本地 `body: sseBody as BodyInit` 断言补丁已重新叠加。**
- `api/pi-messages.ts`：`providerThinkingLevel` 透传。
- `providers/openrouter.ts`：api map 扩为 `anthropic-messages | openai-completions` 双通道。
- `providers/faux.ts` / `cloudflare-ai-gateway.ts`：条件展开/注释；`api/cloudflare-gateway-binding.ts`（上游已删）→ `api/cloudflare-ai-binding.ts`（新文件，无引用，照搬）。
- `models.ts`：`streamDeferred()` 新增（`fetchDeferred` 改为其 `.result()` 封装）。
- `utils/uuid.ts`：UUIDv7 重写（bigint 序列、可选 timestamp 参数、越界抛 RangeError）；`utils/retry.ts`：aborted 清理 errorMessage 方式调整；`utils/node-http-proxy.ts`：`NO_PROXY` 根域/子域匹配重写 + IPv6 括号。
- 新文件 `utils/assistant-message-frame.ts`（index.ts 导出，照搬）。

### telemetry 包
- src 与 v0.84.4 完全一致。

## 依赖升级

- `@anthropic-ai/sdk` `^0.91.1` → `^0.123.0`（package.json + pnpm install，唯一必需的外部依赖变更）。
- 其余无变化：agent 包新增的 `@earendil-works/chord` 仅被 harness 使用（本项目不嵌 harness，嵌入文件 grep 无 chord 引用），无需安装。

## 升级步骤（实际执行）

### 1. 补丁盘点（先分类、再合并）

用「本地 `.ts`→`.js` 导入归一化后与上游 v0.84.4 逐文件 diff」的方法重新盘点，排除 sed 形式差异后，真实本地补丁与文档记录完全一致：

| 文件 | v0.85.1 处理方式 |
|---|---|
| agent/agent-loop.ts | 保留本地版 + 合并上游 abort 检查（finalizedCalls.push 回调开头 9 行） |
| agent/types.ts | 保留本地版 + 追加上游 `replay?: "never" \| "safe"` |
| agent/agent.ts、index.ts、node.ts、stream-fn.ts | 上游未变（index 上游仅 harness 导出变化），保留本地版 |
| agent/proxy.ts | 直接采用上游版（本地无补丁） |
| ai/types.ts | 采用上游 v0.85.1 版 + 原位重插 `onStreamRetry` + `StreamRetryInfo` |
| ai/compat.ts | 上游未变，保留本地版（registerModel 注册表） |
| ai/api/bedrock-converse-stream.ts | 上游未变，保留本地版（`as any` ×2） |
| ai/api/openai-codex-responses.ts | 采用上游版 + 重新叠加 `body: sseBody as BodyInit` |
| ai/providers/xai.ts | 上游未变，保留本地版（Provider 泛型放宽） |
| ai/utils/oauth/* | 本地独有 OAuth 兼容层，未触碰 |
| ai/providers/data/* | **从 npm pack v0.85.1 提取覆盖**（见下） |
| ai/api/cloudflare-gateway-binding.ts | 删除（上游已删，本地无引用） |

其余上游变更文件（anthropic-messages、openai-*、pi-messages、faux、openrouter、cloudflare-ai-gateway、models、retry、uuid、node-http-proxy、index、assistant-message-frame、cloudflare-ai-binding、image-models.generated）直接采用上游版 + 四形式 sed。

> 教训复用：盘点时注意两个 sed 误报源 —— ① 外部 SDK 导入（`openai/...`、`@anthropic-ai/sdk/...`）在上游本来就是 `.js`；② lazy 加载器字符串 `import.meta.url.endsWith(".js")`。二者都会让「归一化 diff」出现假差异，归类前先人工确认。

### 2. 复制与转换

```bash
cp /tmp/pi-0.85.1/packages/agent/src/*.ts src/pi-mono/agent/   # 之后恢复本地 5 文件
cp -r /tmp/pi-0.85.1/packages/ai/src/. src/pi-mono/ai/         # 之后恢复本地 4 文件，删除 cloudflare-gateway-binding.ts
cp -r /tmp/pi-0.85.1/packages/telemetry/src/. src/pi-mono/telemetry/
find src/pi-mono -name "*.ts" -exec sed -i \
  -e 's/from "\([^"]*\)\.ts"/from "\1.js"/g' \
  -e 's/^import "\([^"]*\)\.ts"/import "\1.js"/g' \
  -e 's/import("\([^"]*\)\.ts")/import("\1.js")/g' \
  -e 's/("\([^"]*\)\.ts")/("\1.js")/g' {} +
```

（操作前已将全部带补丁文件备份至 worktree 之外，工作树状态干净、全部已提交，无需从 git 反推。）

### 3. providers/data 生成产物同步（PI_MONO_UPGRADE_NOTES §2 惯例）

```bash
cd /tmp && npm pack @earendil-works/pi-ai@0.85.1 --silent && tar xzf earendil-works-pi-ai-0.85.1.tgz
cp /tmp/package/dist/providers/data/* /tmp/package/dist/providers/data/.manifest.json \
   /home/iwapu/projects/OhMyAgent/src/pi-mono/ai/providers/data/
```

25 个 JSON 与 v0.84.4 发布产物有差异（发布时在线刷新），运行时验证 `gpt-6-astra`（OpenAI/openai-codex 目录新增的 GPT-6 Astra，v0.85.1 头条特性）与 `deepseek-v4-flash-vision-exp` 均直接出现在默认目录。

### 4. 编译修复

0 处新增编译错误。`@anthropic-ai/sdk` 升级后本地 `ai/api/anthropic-messages.ts`（上游版）直接可用。

## 验证

- `pnpm build` — 0 错误
- `npx vitest run tests/agent tests/w0/pi-mono-import.test.ts` — 439 通过（含 fallback/retry/import 关键覆盖）
- `pnpm test` — **213 文件 / 3334 测试通过**（3 跳过，环境相关），exit 0
- `pnpm lint` — 0 errors（547 个既有 no-explicit-any warnings，与本次无关）
- `pnpm typecheck` — src + ui 均通过
- `pnpm format:check` — 通过（`src/pi-mono` 在 `.prettierignore` 中，vendored 目录不做 prettier 格式化，上游代码保持上游风格）
- `grep -rc "OhMyAgent" src/pi-mono --include="*.ts" | grep -v ':0$'` — 5 文件 22 处，与 PI_MONO_LOCAL_PATCHES.md 清单一致
- **运行时实测**（dev server，未提交代码前）：
  - `GET /webui/` 200，Vite dev 中间件正常 transform `main.tsx` / chat 组件
  - Bearer token 认证下 `/api/config`、`/api/providers`、`/api/skills`、`/api/agents`、`/api/dashboard/stats` 等 WebUI API 全部 200
  - `GET /api/providers/deepseek/models` 返回含 `deepseek-v4-flash-vision-exp`；`/api/providers/openai/models` 含 `gpt-6-astra`
  - 自定义 provider 注册表（compat.ts 补丁）运行时可用：`/api/providers/agnes/models` 返回 `agnes-2.5-flash` 等
  - **端到端聊天**：`POST /api/projects/:id/chat`（SSE）— `turn_start` → thinking 流 → `text_delta` → `done`（usage 统计正常，model `agnes/agnes-2.5-flash`），升级后的 agent-loop / stream / event-bridge 链路完整可用，服务日志 0 error

## 后续注意事项

- `@anthropic-ai/sdk` 0.123.0 的 `beta/messages` 类型路径是硬依赖，后续不要再降级 SDK
- agent 包上游 index.ts 的 harness/context/runtime 导出继续不采纳；下次升级若上游把非 harness 导出混进 index.ts，需要重新甄别
- v0.85.1 修复的「SDK 发布含实验性代码导致 import 失败」（#9132）仅影响 coding-agent 包，本项目不嵌，无关
