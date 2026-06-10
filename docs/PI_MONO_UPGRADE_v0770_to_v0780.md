# pi-mono v0.77.0 → v0.78.0 升级实施方案

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-30 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.77.0 |
| 目标版本 | v0.78.0 |
| 目标 tag | `v0.78.0` |
| 升级难度 | **极低** — Agent 层零变更；AI 层 13 个文件全部仅扩展名差异（无逻辑修改） |

## 上游变更清单

### Agent 层

**零变更**。v0.77.0 到 v0.78.0 的 diff 中 `packages/agent/src/` 核心文件全部无变动。

### AI 层 — 13 个文件变更

| 文件 | 变更量 | 变更内容 | 本地修改 |
|------|--------|---------|:---:|
| `models.generated.ts` | 139 行 | OpenRouter Moonshot Kimi K2.6 模型元数据；GitLab Duo Claude 模型更新 | 仅扩展名 |
| `providers/amazon-bedrock.ts` | 41 行 | 新增自定义 HTTP header 支持（`headers` 选项） | 仅扩展名 |
| `providers/openai-completions.ts` | 21 行 | Go Kimi K2.6 thinking 修复：发送 `thinking` 对象而非无效字符串；Grok Build 移除 `reasoning_effort` | 仅扩展名 |
| `providers/openai-codex-responses.ts` | 20 行 | SSE 流在终止事件后中止响应体读取 | 仅扩展名 |
| `providers/openai-responses.ts` | 19 行 | 同上，SSE 流清理 | 仅扩展名 |
| `stream.ts` | 19 行 | stream 模块更新 | 仅扩展名 |
| `providers/azure-openai-responses.ts` | 17 行 | Azure Responses provider 同步更新 | 仅扩展名 |
| `types.ts` | 8 行 | `StreamOptions` 新增 `headers` 等字段 | 仅扩展名 |
| `providers/anthropic.ts` | 8 行 | Anthropic provider 更新 | 仅扩展名 |
| `providers/google.ts` | 8 行 | Google Gemini provider 更新 | 仅扩展名 |
| `providers/images/openrouter.ts` | 5 行 | OpenRouter 图像模型更新 | 仅扩展名 |
| `providers/mistral.ts` | 5 行 | Mistral provider 更新 | 仅扩展名 |
| `providers/google-vertex.ts` | 2 行 | Vertex AI 小修复 | 仅扩展名 |

### 本地修改影响分析

所有 13 个文件对比上游 v0.77.0 的差异**仅为 `.ts` → `.js` 导入扩展名不同**，无任何逻辑修改。全部可安全覆盖。

核心本地修改（`agent/agent.ts`、`agent/agent-loop.ts`、`agent/types.ts`、`agent/index.ts`、`ai/models.ts`、`ai/api-registry.ts`）**均未被触碰**。

> **本地补丁（Tool Search 延迟工具）— 升级后必须保留：**
> 升级覆盖 `agent/types.ts` 与 `agent/agent-loop.ts` 时，需重新应用以下两处本地修改（属 OhMyAgent Tool Search 扩展，上游没有）：
> 1. `agent/types.ts` — `AgentTool` 接口新增可选字段 `deferred?: boolean`。
> 2. `agent/agent-loop.ts` — `compactToolsForPrompt` 中 `.filter((tool) => tool.deferred !== true)`，把延迟工具排除出发往 LLM 的工具列表（但仍保留在 `context.tools` 中供 `prepareToolCall` 按名解析）。
> 验证：`pnpm vitest run tests/tools/tool-search/deferred-resolution.test.ts` 必须通过。

## 升级步骤

### Step 1: 克隆上游 v0.78.0

```bash
git clone --branch v0.78.0 --depth 1 https://github.com/earendil-works/pi.git /tmp/pi-v0780
```

### Step 2: 复制变更文件

```bash
SRC=/tmp/pi-v0780/packages/ai/src
DST=src/pi-mono/ai

cp "$SRC/models.generated.ts" "$DST/"
cp "$SRC/types.ts" "$DST/"
cp "$SRC/stream.ts" "$DST/"
cp "$SRC/providers/amazon-bedrock.ts" "$DST/providers/"
cp "$SRC/providers/anthropic.ts" "$DST/providers/"
cp "$SRC/providers/openai-completions.ts" "$DST/providers/"
cp "$SRC/providers/openai-codex-responses.ts" "$DST/providers/"
cp "$SRC/providers/openai-responses.ts" "$DST/providers/"
cp "$SRC/providers/azure-openai-responses.ts" "$DST/providers/"
cp "$SRC/providers/google.ts" "$DST/providers/"
cp "$SRC/providers/google-vertex.ts" "$DST/providers/"
cp "$SRC/providers/mistral.ts" "$DST/providers/"
cp "$SRC/providers/images/openrouter.ts" "$DST/providers/images/"
```

### Step 3: 回退 `.ts` → `.js` 扩展名

```bash
find src/pi-mono -name "*.ts" -exec sed -i 's/from "\([^"]*\)\.ts"/from "\1.js"/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i "s/from '\\([^']*\\)\\.ts'/from '\\1.js'/g" {} +
find src/pi-mono -name "*.ts" -exec sed -i 's/export \* from "\([^"]*\)\.ts"/export * from "\1.js"/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i 's/import("\([^"]*\)\.ts")/import("\1.js")/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i "s/import('\\([^']*\\)\\.ts')/import('\\1.js')/g" {} +
```

### Step 4: 验证

```bash
# 确认无遗漏的 .ts 扩展名
grep -rn '\.ts"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts" | grep -v '.codegraph'
# 确认 fallbackModels / registerModel 完整
grep -rn "fallbackModels\|registerModel" src/pi-mono/
```

### Step 5: 更新版本标记

```bash
echo "v0.78.0" > src/pi-mono/VERSION
sed -i 's/Built on an embedded fork of \*\*pi-mono v0.77.0\*\*/Built on an embedded fork of **pi-mono v0.78.0**/' CLAUDE.md
```

### Step 6: 编译 + 测试

```bash
pnpm build && pnpm test:ai
```

### Step 7: 提交

```bash
git add src/pi-mono/ docs/PI_MONO_UPGRADE_v0770_to_v0780.md
git commit -m "feat: upgrade embedded pi-mono from v0.77.0 to v0.78.0

- AI layer: 13 files (all direct overwrites, only .js extension diff)
- Agent layer: zero changes, all local modifications preserved
- Bedrock: custom request headers support
- OpenAI: fix Go Kimi K2.6 thinking objects, Grok Build reasoning_effort
- Codex: abort SSE response body reads after terminal events
- Models: update OpenRouter Kimi K2.6, GitLab Duo Claude metadata"
```

## 验收清单

- [ ] `pnpm build` — 编译通过
- [ ] `pnpm test:ai` — 全量测试无新增失败
- [ ] `grep -rn "fallbackModels\|registerModel" src/pi-mono/` — 本地修改完整
- [ ] `grep -rn '\.ts"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts"` — 无遗漏扩展名
- [ ] `cat src/pi-mono/VERSION` — 显示 v0.78.0
- [ ] `curl -s http://localhost:9191/health` — 服务正常

## 关键变更说明

### 1. Bedrock 自定义 HTTP Headers

`amazon-bedrock.ts` 新增自定义 header 支持，允许通过 `options.headers` 向 Bedrock API 请求注入额外 HTTP 头。`types.ts` 的 `StreamOptions` 新增对应字段。

### 2. Go Kimi K2.6 / Grok Build Thinking 修复

`openai-completions.ts` 修复了 OpenCode Go Kimi K2.6 的 thinking 参数格式（发送 `thinking: { type: "enabled" }` 对象而非无效的 `thinking: "none"` 字符串），以及 Grok Build 的 `reasoning_effort` 移除。

### 3. Codex SSE 流清理

`openai-codex-responses.ts` 和 `openai-responses.ts` 修复了在接收到终止事件后未中止 SSE 响应体读取的问题，避免资源泄露。

### 4. 模型元数据更新

- OpenRouter 新增 Moonshot Kimi K2.6 模型
- GitLab Duo 自定义 provider 示例更新 Claude 模型列表和 adaptive thinking 配置
- OpenRouter DeepSeek V4 `xhigh` reasoning 修正
