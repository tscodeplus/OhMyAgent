# pi-mono v0.76.0 → v0.77.0 升级实施方案

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-29 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.76.0 |
| 目标版本 | v0.77.0 |
| 目标 tag | `v0.77.0` |
| 升级难度 | **极低** — Agent 层零变更；AI 层 10 个文件全部无本地修改冲突 |

## 上游变更清单

### Agent 层

**零变更**。v0.76.0 到 v0.77.0 的 diff 中 `packages/agent/src/` 核心文件（agent.ts、agent-loop.ts、types.ts、proxy.ts）无任何变动。仅 `harness/` 子目录有变更，项目不嵌入 harness。

→ `fallbackModels`、fallback 循环、cache tracking 等本地修改**完全不受影响**。

### AI 层 — 10 个文件变更 (全部修改，无新增/删除)

| 文件 | 变更量 | 变更内容 | 与本地修改冲突？ |
|------|--------|---------|:---:|
| `models.generated.ts` | 530 行 | Claude Opus 4.8 模型元数据；xiaomi token-plan 模型整理；OpenRouter DeepSeek V4 推理 effort 修正；GPT-5.5 Pro thinking level 修正；Go Kimi K2.6 thinking-off；多个模型 contextWindow/thinking 配置更新 | **无** — 自动生成文件 |
| `utils/oauth/openai-codex.ts` | 343 行 | OpenAI Codex 订阅 device-code 登录 (OAuth) | **无** |
| `providers/anthropic.ts` | 30 行 | `allowEmptySignature` compat 标志支持；Opus 4.8 adaptive-thinking 覆盖；空签名 thinking 块保留（替代纯文本降级） | **无** |
| `utils/oauth/device-code.ts` | 29 行 | Device-code flow 通用增强（超时、轮询改进） | **无** |
| `types.ts` | 14 行 | `thinkingFormat` 新增 `"string-thinking"` 选项；`ModelCompat` 新增 `allowEmptySignature?: boolean` | **无** |
| `utils/oauth/github-copilot.ts` | 10 行 | GitHub Copilot OAuth 适配 device-code 重构 | **无** |
| `utils/oauth/index.ts` | 9 行 | OAuth 模块导出更新 | **无** |
| `providers/amazon-bedrock.ts` | 8 行 | Bedrock 模型元数据更新 (Opus 4.8) | **无** |
| `providers/openai-completions.ts` | 7 行 | `string-thinking` thinkingFormat 支持（用于 OpenCode Go Kimi K2.6 等 `thinking: "none"` 风格） | **无** |
| `providers/openai-responses-shared.ts` | 6 行 | 修复 Codex Responses replay 时 thinking 块的 fallback message item ID 生成（`msg_pi_` 前缀替代 `msg_` 前缀，避免冲突） | **无** |

### 本地修改影响分析

| 文件 | 本地修改内容 | 上游是否变更 | 处理方式 |
|------|-------------|:---:|---------|
| `agent/agent.ts` | `fallbackModels` (4 处) | **否** | 保持不变 |
| `agent/agent-loop.ts` | fallback 多模型循环 + cache 累计追踪 | **否** | 保持不变 |
| `agent/types.ts` | `fallbackModels` in AgentLoopConfig | **否** | 保持不变 |
| `agent/index.ts` | 仅 4 行 core export（无 harness） | **否** | 保持不变 |
| `ai/models.ts` | `registerModel()` 函数 | **否** | 保持不变 |
| `ai/api-registry.ts` | `registerApiProvider()` 函数 | **否** | 保持不变 |
| `ai/stream.ts` | stream 本地适配 | **否** | 保持不变 |
| `ai/providers/amazon-bedrock.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/models.generated.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/types.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/anthropic.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/openai-completions.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/openai-responses-shared.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/utils/oauth/device-code.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/utils/oauth/github-copilot.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/utils/oauth/index.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/utils/oauth/openai-codex.ts` | 无本地修改 | **是** | 直接覆盖 |

**结论：零逻辑冲突。** 所有本地逻辑修改都在未被上游触碰的文件中。升级仅涉及逐文件覆盖 + 扩展名回退。

## 升级步骤

### Step 1: 克隆上游 v0.77.0

```bash
git clone --branch v0.77.0 --depth 1 https://github.com/earendil-works/pi.git /tmp/pi-v0770
```

### Step 2: 复制变更文件

```bash
SRC=/tmp/pi-v0770/packages/ai/src
DST=src/pi-mono/ai

# 全部 10 个文件
cp "$SRC/models.generated.ts" "$DST/"
cp "$SRC/types.ts" "$DST/"
cp "$SRC/providers/anthropic.ts" "$DST/providers/"
cp "$SRC/providers/openai-completions.ts" "$DST/providers/"
cp "$SRC/providers/openai-responses-shared.ts" "$DST/providers/"
cp "$SRC/providers/amazon-bedrock.ts" "$DST/providers/"
cp "$SRC/utils/oauth/device-code.ts" "$DST/utils/oauth/"
cp "$SRC/utils/oauth/github-copilot.ts" "$DST/utils/oauth/"
cp "$SRC/utils/oauth/index.ts" "$DST/utils/oauth/"
cp "$SRC/utils/oauth/openai-codex.ts" "$DST/utils/oauth/"
```

### Step 3: 回退 `.ts` → `.js` 扩展名

```bash
find src/pi-mono -name "*.ts" -exec sed -i 's/from "\([^"]*\)\.ts"/from "\1.js"/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i "s/from '\\([^']*\\)\\.ts'/from '\\1.js'/g" {} +
find src/pi-mono -name "*.ts" -exec sed -i 's/export \* from "\([^"]*\)\.ts"/export * from "\1.js"/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i 's/import("\([^"]*\)\.ts")/import("\1.js")/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i "s/import('\\([^']*\\)\\.ts')/import('\\1.js')/g" {} +
```

### Step 4: 验证本地修改完整性

```bash
# 确认 fallbackModels 修改仍在
grep -n "fallbackModels" src/pi-mono/agent/agent.ts src/pi-mono/agent/agent-loop.ts src/pi-mono/agent/types.ts

# 确认 registerModel 修改仍在
grep -n "registerModel" src/pi-mono/ai/models.ts

# 确认 agent/index.ts 仅有 4 行 core export（无 harness 引入）
cat src/pi-mono/agent/index.ts

# 确认无遗漏的 .ts 扩展名
grep -rn '\.ts"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts" | grep -v node_modules | grep -v '.codegraph'
```

### Step 5: 更新版本标记

```bash
echo "v0.77.0" > src/pi-mono/VERSION
sed -i 's/Built on an embedded fork of \*\*pi-mono v0.76.0\*\*/Built on an embedded fork of **pi-mono v0.77.0**/' CLAUDE.md
```

### Step 6: 编译验证

```bash
pnpm build
```

### Step 7: 测试验证

```bash
pnpm test:ai
```

### Step 8: 启动服务验证

```bash
PORT=$(grep -oP 'OHMYAGENT_PORT=\K\d+' .env 2>/dev/null || echo 9191)
fuser -k $PORT/tcp 2>/dev/null
pkill -f "tsx src/index.ts" 2>/dev/null
sleep 1
nohup npx tsx src/index.ts > data/logs/ohmyagent.log 2>&1 &
sleep 2
curl -s http://localhost:$PORT/health
```

### Step 9: 提交

```bash
git add src/pi-mono/VERSION \
  src/pi-mono/ai/models.generated.ts \
  src/pi-mono/ai/types.ts \
  src/pi-mono/ai/providers/anthropic.ts \
  src/pi-mono/ai/providers/openai-completions.ts \
  src/pi-mono/ai/providers/openai-responses-shared.ts \
  src/pi-mono/ai/providers/amazon-bedrock.ts \
  src/pi-mono/ai/utils/oauth/device-code.ts \
  src/pi-mono/ai/utils/oauth/github-copilot.ts \
  src/pi-mono/ai/utils/oauth/index.ts \
  src/pi-mono/ai/utils/oauth/openai-codex.ts \
  docs/PI_MONO_UPGRADE_v0760_to_v0770.md
git commit -m "feat: upgrade embedded pi-mono from v0.76.0 to v0.77.0

- AI layer: 10 files (all direct overwrites, zero local mod conflicts)
- Agent layer: zero changes, all local modifications preserved
- Models: add Claude Opus 4.8, update xiaomi/OpenRouter/Go Kimi metadata
- Anthropic: allowEmptySignature compat for empty thinking signatures
- OpenAI: string-thinking thinkingFormat, fix Codex replay message IDs
- OAuth: Codex subscription device-code login support"
```

## 验收清单

- [ ] `pnpm build` — 编译通过
- [ ] `pnpm test:ai` — 全量测试无新增失败
- [ ] `grep -rn "fallbackModels\|registerModel" src/pi-mono/` — 本地修改完整
- [ ] `grep -rn '\.ts"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts"` — 确认无遗漏的 `.ts` 扩展名
- [ ] `cat src/pi-mono/VERSION` — 显示 v0.77.0
- [ ] `cat src/pi-mono/agent/index.ts` — 仅含 4 行 core export
- [ ] `curl -s http://localhost:9191/health` — 服务正常启动

## 关键变更说明

### 1. Claude Opus 4.8 支持

`models.generated.ts` 新增 Anthropic Claude Opus 4.8 模型元数据，同时更新 `anthropic.ts` 中 Opus adaptive-thinking 覆盖，将 Opus 4.8 纳入推理模型范围。

### 2. `allowEmptySignature` 兼容标志

部分 Anthropic 兼容 provider（如 Xiaomi Token Plan AMS）返回空的 thinking 签名。之前 pi 将空签名的 thinking 块降级为纯文本。v0.77.0 新增 `ModelCompat.allowEmptySignature` 标志，标记为 `true` 的模型会保留原始 thinking 块结构（含空签名），避免 replay 时出错。

代码变更：
- `types.ts`: `ModelCompat` 新增 `allowEmptySignature?: boolean`
- `providers/anthropic.ts`: `convertMessages` 接收 `allowEmptySignature` 参数，空签名时保留 thinking 块而非转为文本

### 3. `string-thinking` thinkingFormat

新增 `"string-thinking"` thinkingFormat，用于需要 `thinking: "none"` / `thinking: "high"` 字符串风格的 provider（如 OpenCode Go Kimi K2.6）。与 `"qwen-chat-template"` 等类似，是一个新的 thinking 参数格式变体。

### 4. Codex Responses Replay 消息 ID 修复

从 Anthropic extended-thinking 会话切换到 Codex Responses 时，转换后的 thinking/text 块需要唯一 message item ID 参与 replay。之前使用 `msg_${index}` 可能与真实消息 ID 冲突，现在改为 `msg_pi_${index}` 前缀。

### 5. OpenAI Codex 订阅 Device-Code 登录

`utils/oauth/openai-codex.ts` 有 343 行重构，新增 device-code OAuth flow 支持。ChatGPT Plus/Pro 订阅用户可在无法使用浏览器登录的头less 环境中通过 `/login` 命令选择 device-code 认证方式。
