# pi-mono v0.86.0 → v0.86.1 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-09-21 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.86.0（2026-09-20 嵌入） |
| 目标版本 | v0.86.1 |
| 升级难度 | **低** — patch 版本；嵌入的 agent / telemetry 包零改动，ai 包新增 Meta (Muse) 供应商 + 2 处修复；无依赖版本变化 |

## 上游变更概要（仅覆盖本项目嵌入的 agent/ai/telemetry）

### agent 包

- `packages/agent/src` 与 v0.86.0 **逐字节一致**（仅 package.json 版本号 0.86.0 → 0.86.1）。

### telemetry 包

- `packages/telemetry/src` 与 v0.86.0 **逐字节一致**。

### ai 包

- **新增 Meta (Muse subscription) 供应商**
  - `auth/oauth/meta.ts`（新，208 行）— `/login meta` OAuth 流程，自动刷新 Model API key。
  - `providers/meta.ts`（新）— `metaProvider()`，`api: openai-responses`，`baseUrl: https://api.meta.ai/v1`，API key 环境变量 `META_API_KEY`。
  - `providers/meta.models.ts`（新）+ `providers/data/meta.json`（新）— Muse Spark 模型目录（1.1 / 1.2 / 1.2-contributor / 1.3 / 1.3-contributor，均 `input: ["text","image"]`、1M 上下文）。
  - `types.ts` — `ProviderId` 联合新增 `"meta"`。
  - `providers/all.ts` — 注册 `metaProvider()`。
  - `env-api-keys.ts` — `meta: "META_API_KEY"`。
  - `bun-oauth.ts` / `auth/oauth/load.ts` — 新增 `metaOAuth` / `loadMetaOAuth`（bundled OAuth 加载器）。
  - `models.generated.ts` — 注册 `META_MODELS`。
- **修复**：
  - `api/openai-completions.ts` — Cerebras 不再宣称支持 strict tool schema（混用 strict/non-strict 工具会导致 HTTP 400）；`isCerebras` 提取为变量并纳入 `supportsStrictMode` 判断。
  - `utils/overflow.ts` — z.ai 的 `"Prompt too long"` 现被识别为上下文溢出（`/prompt (?:is )?too long/i`）。

## 依赖升级

无。`@anthropic-ai/sdk`、`@aws-sdk/client-bedrock-runtime`、`@google/genai`、`@smithy/node-http-handler`、`typebox` 版本与 v0.86.0 一致（Meta 供应商不需要新 SDK，走 openai-responses API）。

## 升级步骤（实际执行）

### 1. 补丁盘点

先确认 ai 包本次变更文件是否含本地补丁：

| 文件 | v0.86.1 处理方式 |
|---|---|
| ai/types.ts | 采用上游版 + **原位重贴** `onStreamRetry` + `StreamRetryInfo`（本地唯一补丁） |
| ai/api/openai-completions.ts、auth/oauth/load.ts、bun-oauth.ts、env-api-keys.ts、providers/all.ts、utils/overflow.ts、models.generated.ts | 无本地补丁，直接采用上游版 |
| ai/auth/oauth/meta.ts、providers/meta.ts、providers/meta.models.ts | 新增文件，直接采用 |
| agent/*、telemetry/* | 上游未变，保持不动（含全部本地补丁） |
| ai/compat.ts | 上游未变，保持不动 |

### 2. 复制与转换

```bash
S=/tmp/pi-0.86.1/packages/ai/src
cp $S/api/openai-completions.ts src/pi-mono/ai/api/
cp $S/auth/oauth/load.ts $S/auth/oauth/meta.ts src/pi-mono/ai/auth/oauth/
cp $S/bun-oauth.ts $S/env-api-keys.ts $S/models.generated.ts $S/types.ts src/pi-mono/ai/
cp $S/providers/all.ts $S/providers/meta.ts $S/providers/meta.models.ts src/pi-mono/ai/providers/
cp $S/utils/overflow.ts src/pi-mono/ai/utils/
# 重贴 types.ts 的 onStreamRetry/StreamRetryInfo
find src/pi-mono -name "*.ts" -exec sed -i \
  -e 's/from "\([^"]*\)\.ts"/from "\1.js"/g' \
  -e 's/^import "\([^"]*\)\.ts"/import "\1.js"/g' \
  -e 's/import("\([^"]*\)\.ts")/import("\1.js")/g' \
  -e 's/("\([^"]*\)\.ts")/("\1.js")/g' {} +
```

### 3. 数据目录同步（npm pack）

```bash
cd /tmp && npm pack @earendil-works/pi-ai@0.86.1 --silent
tar xzf earendil-works-pi-ai-0.86.1.tgz
diff -rq package/dist/providers/data/ src/pi-mono/ai/providers/data/
cp -r package/dist/providers/data/. src/pi-mono/ai/providers/data/
```

结果：新增 `meta.json`（41 个 JSON）；`.manifest.json`、`cerebras.json`、`radius.json`、`openrouter.json` 在线刷新（模型 id 不变，仅价格/上下文等元数据更新）。

### 4. 无需 app 侧改动

本次无 Breaking Changes，`src/`、`ui/`、测试均无需修改。`config.yaml` 未新增 Meta 配置（如需使用需自行添加 provider key，或走 `/login meta` 的 OAuth 流程 —— 该流程依赖 coding-agent harness，本项目未嵌入，故仅支持 `META_API_KEY`）。

## 验证

- `pnpm build` — 0 错误
- `pnpm test` — **227 文件 / 3403 通过**（4 环境跳过）
- `pnpm lint` — 0 errors（554 个既有 warning）
- `pnpm typecheck`（src + ui）— 通过
- `pnpm format:check` — 通过
- `grep -rc "OhMyAgent" src/pi-mono --include="*.ts" | grep -v ':0$'` — 5 文件 28 处（与 v0.86.0 一致，无变化）
- 供应商注册校验（`getProviders()` / `getModels('meta')`）：
  - `has meta: true`
  - `meta models: muse-spark-1.1, muse-spark-1.2, muse-spark-1.2-contributor, muse-spark-1.3, muse-spark-1.3-contributor`
  - `getModel('meta','muse-spark-1.3')` → `openai-responses`，`input: ["text","image"]`
- **运行时实测**（dev server）：
  - `GET /webui/` 200；`/api/health`、`/api/providers`、`/api/providers/meta/models`、`/api/agents`、`/api/skills` 全 200
  - `/api/providers/meta/models` 返回 5 个 Muse Spark 模型
  - **端到端聊天 + 工具调用**：`turn_start → thinking → tool_call_start → shell 执行 → tool_call_end → text_delta → done`，命令输出 `OMA_0861_OK` 正确回传
  - 服务日志 0 error

## 后续注意事项

- Meta 供应商在本项目内仅支持 `META_API_KEY`（环境变量）方式；`/login meta` OAuth 属于 coding-agent harness，未嵌入。
- 本地补丁清单本次无变化，仍以 `docs/PI_MONO_LOCAL_PATCHES.md` 与 `docs/PI_MONO_UPGRADE_NOTES.md` 第 3 节为准。
