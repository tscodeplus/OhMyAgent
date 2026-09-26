# pi-mono v0.87.0 → v0.87.1 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-09-26 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.87.0（2026-09-22 嵌入） |
| 目标版本 | v0.87.1（2026-09-22 发布） |
| 升级难度 | **低** — patch 版本；嵌入的 `agent` / `telemetry` 包**逐字节未变**，仅 `ai` 包 3 个文件变化且**均无本地补丁**；无新增文件、无依赖版本变化。绝大部分变更集中在 publish-time 生成的模型目录数据 |

## 上游变更概要（仅覆盖本项目嵌入的 agent/ai/telemetry）

### agent 包

- `packages/agent/src` 与 v0.87.0 **逐字节一致**，无任何改动。

### telemetry 包

- `packages/telemetry/src` 与 v0.87.0 **逐字节一致**，无任何改动。

### ai 包（3 个文件）

| 文件 | 变更 |
|---|---|
| `api/anthropic-messages.ts` | `claudeCodeVersion` `"2.1.251"` → `"2.1.280"`（Stealth mode 模拟 Claude Code 版本号，用于 Anthropic OAuth 请求头） |
| `api/openai-completions.ts` | 图片型 user 消息构造时**过滤掉空文本 part**：`msg.content.filter(item => item.type !== "text" \|\| item.text.length > 0)`。修复仅含图片的 user 消息被部分 OpenAI 兼容端点拒绝的问题（上游 #9797） |
| `image-models.generated.ts` | 新增 OpenRouter 图片模型 `inclusionai/ming-image-0.1-design`（`openrouter-images`） |

- 无新增文件；`models.generated.ts`、`providers/xai.ts`、`compat.ts` 等均未变。
- 上游 release notes 的其余条目（`--mode` 参数校验、split-turn compaction 摘要、Anthropic OAuth 版本、xAI 默认模型改为 Grok 4.7、新增 frontier 模型）中：
  - **frontier 模型**（Claude Opus 5.5 / GPT-6 Sol / GPT-6 Luna）来自 publish-time 生成的模型目录数据，见下节；
  - 其余条目属于 `coding-agent` / CLI / harness，本项目未嵌入，**无需处理**（`providers/xai.ts` 未变，数据目录也无 `defaultModel` 字段，说明 xAI 默认模型是 harness 行为）。

## 依赖升级

无。`@anthropic-ai/sdk`（0.124.0）、`@aws-sdk/client-bedrock-runtime`（3.1127.0）、`@google/genai`（2.21.0）、`@smithy/node-http-handler`（4.12.1）、`typebox`（1.3.27）与 v0.87.0 完全一致；仅包内 `@earendil-works/*` 自引用版本号 0.87.0 → 0.87.1（嵌入式无需处理）。

## 升级步骤（实际执行）

### 1. 差异盘点

```bash
diff -rq pi-0.87.0/packages/agent/src     pi-0.87.1/packages/agent/src      # 无输出
diff -rq pi-0.87.0/packages/telemetry/src pi-0.87.1/packages/telemetry/src  # 无输出
diff -rq pi-0.87.0/packages/ai/src        pi-0.87.1/packages/ai/src
#   api/anthropic-messages.ts
#   api/openai-completions.ts
#   image-models.generated.ts
```

3 个文件均确认与本地无补丁冲突（本地版本相对上游 v0.87.0 仅多出 `.ts` → `.js` 的导入改写），因此**直接采用上游版本**，无需三方合并。

### 2. 复制 + `.ts` → `.js` 归一化

```bash
cp pi-0.87.1/packages/ai/src/api/anthropic-messages.ts   src/pi-mono/ai/api/
cp pi-0.87.1/packages/ai/src/api/openai-completions.ts   src/pi-mono/ai/api/
cp pi-0.87.1/packages/ai/src/image-models.generated.ts   src/pi-mono/ai/

find src/pi-mono -name "*.ts" -exec sed -i \
  -e 's/from "\([^"]*\)\.ts"/from "\1.js"/g' \
  -e 's/^import "\([^"]*\)\.ts"/import "\1.js"/g' \
  -e 's/import("\([^"]*\)\.ts")/import("\1.js")/g' \
  -e 's/("\([^"]*\)\.ts")/("\1.js")/g' {} +
# 校验：grep 'from "[^"]*\.ts"' src/pi-mono 无残留
```

### 3. 数据目录同步（npm pack）

```bash
cd /tmp && npm pack @earendil-works/pi-ai@0.87.1 --silent
tar xzf earendil-works-pi-ai-0.87.1.tgz
cp -r package/dist/providers/data/. src/pi-mono/ai/providers/data/
diff -rq package/dist/providers/data/ src/pi-mono/ai/providers/data/   # IDENTICAL
```

41 个 JSON，其中 **18 个发生变化**（其余 23 个逐字节相同）。模型 id 增删如下（按 api 分组）：

| 文件 | 新增 | 删除 |
|---|---|---|
| `amazon-bedrock.json` | `anthropic.claude-opus-5-5` + `au./eu./global./jp./us.` 变体（6 个） | — |
| `anthropic.json` | `claude-opus-5-5` | — |
| `azure-openai-responses.json` | `gpt-6-luna`、`gpt-6-sol` | — |
| `github-copilot.json` | `claude-opus-5.5`（anthropic-messages）；`gpt-6-luna`、`gpt-6-sol`、`grok-4.7`（openai-responses） | — |
| `openai-codex.json` | `gpt-6-luna`、`gpt-6-sol` | — |
| `openai.json` | `gpt-6-luna`、`gpt-6-sol` | — |
| `opencode-go.json` | `mimo-v2.6-flash`、`mimo-v2.6-pro` | — |
| `opencode.json` | `claude-opus-5-5`、`gpt-6-luna`、`gpt-6-sol`、`mimo-v2.6-flash-free` | `mimo-v2.5-free` |
| `openrouter.json` | `anthropic/claude-opus-5.5`（+`:batch`）、`openai/gpt-6-luna`/`gpt-6-sol`（+`:pro`/`:batch`）、`xiaomi/mimo-v2.6-*`、`qwen/qwen3.8-omni-flash`、`nex-agi/nex-n2.5-pro`、`openai/gpt-oss-20b:batch`、`deepseek/deepseek-v4.1-flash:batch` | 11 个 `:batch` 模型（deepseek v4-flash-0731/v4-pro-0813、kat-coder-pro-v2、muse-glimmer-30b、minimax-m3、gpt-oss-120b、qwen3.5-9b、qwen3.8-2.4t-a95b、inkling、glm-5.2） |
| `radius.json` | `claude-opus-5-5`、`gpt-6-luna`、`gpt-6-sol` | — |
| `vercel-ai-gateway.json` | `anthropic/claude-opus-5.5`（+`-fast`）、`openai/gpt-6-luna`/`gpt-6-sol`（+`-fast`）、`xiaomi/mimo-v2.6-*` | — |
| `xai.json` | `grok-4.7` | — |
| `xiaomi-token-plan-{ams,cn,sgp}.json` | `mimo-v2.6-flash`、`mimo-v2.6-pro` | — |
| `xiaomi.json` | `mimo-v2.6-flash`、`mimo-v2.6-pro`、`mimo-v2.6-pro-ultraspeed` | — |

> 新模型同时携带 `inputLimits`（如 `claude-opus-5-5`：`maxRequestBytes: 32 MiB`、`images.maxPerRequest: 600`）。

### 4. 无需 app 侧改动

3 个 ai 文件改动均为内部行为修复；模型目录为纯数据。`src/`、`ui/`、测试均无需修改。

## 验证

- `pnpm build` — 0 错误
- `pnpm typecheck`（src + ui）— 通过
- `pnpm test` — **228 文件 / 3412 通过**（4 环境跳过；较 v0.87.0 的 227/3404 多出的 1 文件 8 用例来自期间新增的 `tests/skills/skill-compliance.test.ts`，与本升级无关）
- `pnpm lint` — 0 errors（554 个既有 warning）
- `pnpm format:check` — 通过
- `grep -rc "OhMyAgent" src/pi-mono --include="*.ts" | grep -v ':0$'` — **5 文件 28 处不变**：
  `agent/agent-loop.ts`(15)、`agent/agent.ts`(6)、`agent/types.ts`(5)、`ai/compat.ts`(1)、`ai/types.ts`(1)
- 非标记本地补丁确认仍在：`bedrock-converse-stream.ts` 2× `as any`、`openai-codex-responses.ts` 1× `as BodyInit`、`xai.ts` 泛型放宽、`ai/compat.ts` 自定义注册表、`ai/utils/oauth/` 本地目录
- 供应商 / 模型目录校验（tsx 直接调用 `@earendil-works/pi-ai`）：
  - `getProviders()` → 41 个 provider
  - 新增模型全部可解析：`anthropic/claude-opus-5-5`（anthropic-messages，ctx 1M，`xhigh`/`max` thinking）、`xai/grok-4.7`（openai-responses，ctx 500K）、`openai/gpt-6-sol`、`openai/gpt-6-luna`（ctx 272K）、`github-copilot/claude-opus-5.5`、`github-copilot/gpt-6-sol`、`github-copilot/grok-4.7`、`opencode/mimo-v2.6-flash-free`、`xiaomi/mimo-v2.6-pro`、`openrouter/openai/gpt-6-sol-pro`
  - `getModels("xai")` → `grok-4.3, grok-4.5, grok-4.6, grok-4.7`
  - `inputLimits` 正确（`claude-opus-5-5`：`maxRequestBytes 33554432`、`images.maxPerRequest 600`）
  - `registerModel` 自定义注册表仍生效（`getModel` / `getModels` 均可查到）
- **运行时实测**（dev server，port 9191）：
  - 启动：`defaultProviderId: "windows:local"`、**0 条 non-JSON warning**（UIA 原生 Windows 路径修复保持有效）、0 error
  - `GET /api/health`、`/api/providers`、`/api/providers/anthropic/models`、`/api/providers/xai/models`、`/api/providers/openai/models`、`/api/agents`、`/api/skills`、`/api/projects`、`/webui/` — 全 200；`/api/providers/anthropic/models` 含 `claude-opus-5-5`
  - **端到端聊天 + 工具调用**：`turn_start → stream_retry×13（走过 rate-limited 的 fallback 链）→ thinking → tool_call_start(shell) → tool_call_end(isError=false) → text_delta → done`，offload 文件确认 shell 输出为 `OMA_0871_OK`
  - fallback/retry 本地补丁在真实环境中生效（最终落到 `deepseek/deepseek-flash` 成功）
  - 服务日志仅 6 条外部 provider 失败（agnes 429 / nvidia / opencode），无 app 级 error

## 后续注意事项

- 本版本为纯 patch 级；`agent`/`telemetry` 零改动，说明 v0.87.0 引入的 `finishTurn`/`prepareRequest` 契约已稳定。
- 新增 frontier 模型（Claude Opus 5.5、GPT-6 Sol/Luna、Grok 4.7、MiMo v2.6）**仅存在于 npm 发布包的 `providers/data/`**，源码 `models.generated.ts` 不含；升级 `ai` 包后务必按 `PI_MONO_UPGRADE_NOTES.md` 第 1 节同步数据目录。
- 本地补丁清单无变化，仍以 `docs/PI_MONO_LOCAL_PATCHES.md` 与 `docs/PI_MONO_UPGRADE_NOTES.md` 第 3 节为准。
