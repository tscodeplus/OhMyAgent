# pi-mono 升级注意事项

供将来每次 `src/pi-mono/` 升级时快速排查的要点。

## 1. `providers/data/*.json` 绝不可凭 `git diff` 判定是否变更

### 问题
升级时观察 `git diff v0.8x.y v0.8x.z -- packages/ai/src/`，发现
`packages/ai/src/providers/data/` 目录**没有任何文件**被列为 changed。
误以为该目录无更新，从而跳过数据同步。

### 根因

1. 上游仓库 `packages/ai/src/providers/data/*.json` 是**生成产物**，在
   `packages/ai/.gitignore` 中被忽略（发布时通过 `npm run generate-models`
   生成），因此**从未进入上游 git**，任何 `git diff` 对它们都为空。
2. 这些 JSON 只有在 `npm publish` 时才被**重新生成并打入 npm tarball**
   (`dist/providers/data/*.json`)。发布脚本会抓取各 provider 在线模型列表
   (OpenRouter / models.dev / 各家官方接口)，所以一个 patch 版本发布后的
   JSON 可能与上一个版本相差几十个模型。
3. **本仓库不同** — `docs/PI_MONO_UPGRADE_v0821_to_v0841.md` 及
   `PI_MONO_UPGRADE_v0841_to_v0843.md` 记录的升级惯例是：
   把 npm pack 的 JSON **提交到 git**，让 `src/pi-mono/ai/providers/data/`
   成为本仓库真正追踪的目录。

### 常见后果
- release notes 明明说「added X model to the catalog」，升级完默认模型
  选择器却看不到该模型，除非点击「获取模型列表」（即 live fetch）。
- 视觉/推理模型（如 `deepseek-v4-flash-vision-exp`、云模型 `thinkingLevelMap`）
  仅存在发布包 JSON，源文件无此模型 → 默认目录缺失。

## 2. 修复步骤（每次 `ai/` 包升级后必做）

```bash
# 1. 下载发布包，不是从 git tag 复制 data
cd /tmp && npm pack @earendil-works/pi-ai@<TARGET_VERSION> --silent
tar xzf earendil-works-pi-ai-<TARGET_VERSION>.tgz
# 2. 比对本地与发布包生成目录
diff -rq package/dist/providers/data/ src/pi-mono/ai/providers/data/
# 3. 覆盖整个目录（含 .manifest.json），再 .ts→.js 归一化（仅 src/*.ts，需要对 data 不适用）
cp package/dist/providers/data/. src/pi-mono/ai/providers/data/
```

覆盖后：
- `grep` 目标 model id 于 `data/<provider>.json`
- 运行时校验：`getModels('<provider>')`（见 `src/pi-mono/ai/compat.ts`）
  应返回含该模型的列表。
- 重新 build + test。

## 3. 本地补丁盘点（每次升级必须重新确认的 OhMyAgent 扩展点）

上游同步会整体覆盖 `src/pi-mono/`，以下本地扩展在合并后必须逐一确认仍然
存在（`pnpm lint` + `pnpm test:ai` 全绿只是必要条件，逐项 grep 更可靠）。
各升级记录文档（`PI_MONO_UPGRADE_v*.md`）中的补丁表以升级当时为准，可能
落后于本节。

### agent 包（src/pi-mono/agent/）

| 文件 | 扩展点 | 说明 |
|---|---|---|
| agent-loop.ts | fallback 多模型重试 | `streamAssistantResponse` 内 `models = [config.model, ...config.fallbackModels]` 串行重试循环 |
| agent-loop.ts | `emitFallback` + retry-scope `stream_retry` 事件 | fallback 切换发 `stream_retry`（scope=fallback）；通过 `onStreamRetry` 选项把 retrying-stream 的重试进度转为 `stream_retry`（scope=retry）。**注意**：terminal 事件 case 内不可用裸 `continue` 切换模型（它作用于 for-await 而非模型循环），必须 `break` + `finalized` 标志（2026-09 修复的双发 `message_end` bug，见 tests/agent/agent-loop-fallback.test.ts） |
| agent-loop.ts | 工具循环守卫 | failureStreak / maxToolCycles 诊断注入 + compactToolsForPrompt（deferred 工具过滤） |
| agent/types.ts | `AgentEvent` 扩展 | `stream_retry` 事件成员（scope/failedProvider/failedModel/provider/model/attempt/maxRetries/delayMs/errorMessage） |
| agent/types.ts | 配置字段 | `AgentLoopConfig.fallbackModels`、`maxToolCycles`、`deferred` |
| agent/agent.ts | 运行时字段 | `fallbackModels`、`getApiKey`、streamFn 别名、`ohmyagent_agentName` |

### ai 包（src/pi-mono/ai/）

| 文件 | 扩展点 | 说明 |
|---|---|---|
| types.ts | `SimpleStreamOptions.onStreamRetry` + `StreamRetryInfo` | 重试进度回调（由 src/agent/retrying-stream.ts 消费，provider 适配器忽略） |
| compat.ts | `registerModel` 自定义模型注册表 | 自定义 provider 模型注册 |
| api/bedrock-converse-stream.ts、api/openai-codex-responses.ts | tsc 断言 | `as any` 类型兼容补丁 |
| providers/xai.ts | Provider 泛型放宽 | `Provider<"openai-completions" \| "openai-responses">` |
| utils/oauth/* | 本地独有 OAuth 兼容层 | 不在上游，直接保留 |

相关测试（升级后必须全绿，它们覆盖上述多数扩展点）：

- `tests/agent/agent-loop-fallback.test.ts` — fallback/retry 事件、切换次序、终态语义
- `tests/agent/retrying-stream.test.ts` — 重试包装器 + `onStreamRetry` 回调
- `tests/w0/pi-mono-import.test.ts` — 嵌入路径与导出完整性

### 消费端（非 pi-mono，但依赖上述扩展点）

- `src/agent/agent-service.ts` — 看门狗 `ACTIVITY_EVENTS` 含 `stream_retry`
- `src/agent/event-bridge.ts` — `stream_retry` 分发到 `ReplyDispatcher.onStreamRetry`
- `src/app/webui/chat-routes.ts` + `ui/src/components/chat/*` — WebUI 重试状态线

## 4. 速查 — v0.84.4 实证

- `deepseek.json` 新增 `deepseek-v4-flash-vision-exp`
  （`generate-models.ts` 硬编码，`generate-models` 在发布时写入）
- `openrouter.json` 等 24 个 JSON 发布时在线刷新
  （新模型增、下线模型删、OpenRouter `thinkingLevelMap`、
  Cloudflare workers-ai 透传镜像等）
- 其他 14 个 JSON 与 v0.84.3 逐字节一致
