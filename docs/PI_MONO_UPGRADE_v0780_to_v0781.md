# pi-mono v0.78.0 → v0.78.1 升级实施方案

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-06-05 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.78.0 |
| 目标版本 | v0.78.1 |
| 目标 tag | `v0.78.1` |
| 升级难度 | **极低** — Agent 层零变更；AI 层 9 个文件全部无本地修改冲突 |

## 上游变更清单

### Agent 层

**零变更**。v0.78.0 到 v0.78.1 的 diff 中 `packages/agent/src/` 核心文件（agent.ts、agent-loop.ts、types.ts、proxy.ts）无任何变动。

→ `fallbackModels`、fallback 循环、cache tracking 等本地修改**完全不受影响**。

### AI 层 — 9 个文件变更（全部修改，无新增/删除）

| 文件 | 变更量 | 变更内容 | 与本地修改冲突？ |
|------|--------|---------|:---:|
| `models.generated.ts` | 1203+/518- | 新增 NVIDIA NIM 模型 (Nemotron 系列)、MiniMax M3 模型、Ant Ling 模型、xAI Grok 4.1 模型；修正 GPT-5.5 minimal thinking、OpenRouter Kimi K2.6 thinking replay、Opus 4.7+ temperature 禁用等 | **无** — 自动生成文件 |
| `providers/amazon-bedrock.ts` | 47+/22- | 修复必填 user/tool-result 空文本 placeholder；跳过空 replay 文本块；Opus 4.7+ temperature 抑制；thinkingLevel "minimal"/"xhigh" 映射 | **无** — 本地版本仅扩展名差异 |
| `providers/openai-completions.ts` | 36+/10- | MiniMax API thinking 参数格式修复；新增 `"ant-ling"` thinkingFormat 支持；HTTP timeout 修复（非 Codex provider 超时传递） | **无** — 本地版本仅扩展名差异 |
| `providers/anthropic.ts` | 5+/10- | Claude Opus 4.7+ 抑制不支持的 temperature 参数；`supportsTemperature` compat 标志 | **无** — 本地版本仅扩展名差异 |
| `types.ts` | 12+/2- | `ApiProvider` 新增 `"ant-ling"`、`"nvidia"`、`"minimax"`、`"minimax-cn"`、`"zai-coding-cn"`；`thinkingFormat` 新增 `"ant-ling"`；`ModelCompat` 新增 `supportsTemperature?: boolean`；`ThinkingLevel` 新增 `"minimal"` 和 `"xhigh"` | **无** — 本地版本仅扩展名差异 |
| `image-models.generated.ts` | 15+/0- | 新增 Minimax Image 2.0 系列图像模型 | **无** — 自动生成文件 |
| `env-api-keys.ts` | 3+/0- | 新增 `ant-ling`、`nvidia`、`zai-coding-cn` 环境变量 key 映射 | **无** — 本地版本仅扩展名差异 |
| `utils/oauth/github-copilot.ts` | 13+/1- | OAuth 流程增强 | **无** — 本地版本仅扩展名差异 |
| `utils/oauth/openai-codex.ts` | 5+/2- | OAuth 流程修复 | **无** — 本地版本仅扩展名差异 |

### 本地修改影响分析

| 文件 | 本地修改内容 | 上游是否变更 | 处理方式 |
|------|-------------|:---:|---------|
| `agent/agent.ts` | `fallbackModels` (4 处) | **否** | 保持不变 |
| `agent/agent-loop.ts` | fallback 多模型循环 + cache 累计追踪 | **否** | 保持不变 |
| `agent/types.ts` | `fallbackModels` in AgentLoopConfig | **否** | 保持不变 |
| `agent/index.ts` | 仅 4 行 core export（无 harness） | **否** | 保持不变 |
| `ai/models.ts` | `registerModel()` 函数 | **否** | 保持不变 |
| `ai/api-registry.ts` | `registerApiProvider()` / `unregisterApiProviders()` | **否** | 保持不变 |
| `ai/stream.ts` | 本地适配 | **否** | 保持不变 |
| `ai/models.generated.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/image-models.generated.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/types.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/env-api-keys.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/amazon-bedrock.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/anthropic.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/openai-completions.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/utils/oauth/github-copilot.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/utils/oauth/openai-codex.ts` | 无本地修改 | **是** | 直接覆盖 |

**结论：零逻辑冲突。** 所有本地逻辑修改都在未被上游触碰的文件中。升级仅涉及逐文件覆盖 + 扩展名回退。

## NVIDIA NIM 内置 Provider 说明

v0.78.1 新增了 `nvidia` 作为内置 provider（此前在 `ApiProvider` 联合类型中不存在）。关键变更：

### 内置 NVIDIA 模型
`models.generated.ts` 新增 4 个 NVIDIA Nemotron 模型：
- `nvidia.nemotron-nano-12b-v2` — Nemotron Nano 12B v2 VL BF16
- `nvidia.nemotron-nano-3-30b` — Nemotron Nano 3 30B
- `nvidia.nemotron-nano-9b-v2` — Nemotron Nano 9B v2
- `nvidia.nemotron-super-3-120b` — Nemotron 3 Super 120B A12B

### 内置 provider 配置方式
```yaml
# 方式一：环境变量
# export NVIDIA_API_KEY=nvapi-...

# 方式二：provider_keys 段
provider_keys:
  nvidia:
    api_key: nvapi-...
    # base_url 默认 https://integrate.api.nvidia.com/v1
```

### 请求归因头
内置 NVIDIA provider 自动发送 `X-BILLING-INVOKE-ORIGIN: Pi` header。

### config.yaml 影响分析

当前项目将 NVIDIA NIM 作为 **第三方模型网关**（通过 `custom_providers.nvidia` 访问 minimaxai/minimax-m2.7、moonshotai/kimi-k2.6、deepseek-ai/deepseek-v4-flash 等模型）。这种用法与内置 `nvidia` provider 不冲突：

- **内置 `nvidia` provider**：用于访问 NVIDIA 自有 Nemotron 模型（`nvidia.nemotron-*`）
- **`custom_providers.nvidia`**：用于通过 NVIDIA NIM API 网关访问第三方模型

**推荐方案：保持现有 `custom_providers.nvidia` 配置不变。** 无需修改 config.yaml。

如果将来想使用内置 NVIDIA Nemotron 模型，只需在 `provider_keys` 中添加：
```yaml
provider_keys:
  nvidia:
    api_key: ${NVIDIA_API_KEY}
```
然后用模型引用 `nvidia/nemotron-super-3-120b` 即可。

### 同时新增的其他内置 Provider

| Provider | 环境变量 | 用途 |
|----------|---------|------|
| `ant-ling` | `ANT_LING_API_KEY` | 蚂蚁灵川 API |
| `minimax` | `MINIMAX_API_KEY` | MiniMax 官方 API（国际版） |
| `minimax-cn` | `MINIMAX_CN_API_KEY` | MiniMax 官方 API（中国版） |
| `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` | Z.AI Coding 中国版 |

注意：`minimax`/`minimax-cn` 是 MiniMax 官方 API 直连，与通过 NVIDIA NIM 网关访问 `minimaxai/minimax-m2.7` 不同。

## 升级步骤

### Step 1: 克隆已完成（/tmp/pi-v0781）

```bash
git clone --branch v0.78.1 --depth 1 https://github.com/earendil-works/pi.git /tmp/pi-v0781
```

### Step 2: 复制变更文件

```bash
SRC=/tmp/pi-v0781/packages/ai/src
DST=src/pi-mono/ai

cp "$SRC/models.generated.ts" "$DST/"
cp "$SRC/image-models.generated.ts" "$DST/"
cp "$SRC/types.ts" "$DST/"
cp "$SRC/env-api-keys.ts" "$DST/"
cp "$SRC/providers/amazon-bedrock.ts" "$DST/providers/"
cp "$SRC/providers/anthropic.ts" "$DST/providers/"
cp "$SRC/providers/openai-completions.ts" "$DST/providers/"
cp "$SRC/utils/oauth/github-copilot.ts" "$DST/utils/oauth/"
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

### Step 4: 验证

```bash
# 确认无遗漏的 .ts 扩展名
grep -rn '\.ts"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts" | grep -v '.codegraph'
# 确认 fallbackModels / registerModel 完整
grep -rn "fallbackModels\|registerModel" src/pi-mono/
# 确认 agent/index.ts 仅有 4 行 core export
cat src/pi-mono/agent/index.ts
```

### Step 5: 更新版本标记

```bash
echo "v0.78.1" > src/pi-mono/VERSION
sed -i 's/Built on an embedded fork of \*\*pi-mono v0.78.0\*\*/Built on an embedded fork of **pi-mono v0.78.1**/' CLAUDE.md
```

### Step 6: 编译 + 测试

```bash
pnpm build && pnpm test:ai
```

### Step 7: 提交

```bash
git add src/pi-mono/ docs/PI_MONO_UPGRADE_v0780_to_v0781.md
git commit -m "feat: upgrade embedded pi-mono from v0.78.0 to v0.78.1

- AI layer: 9 files (all direct overwrites, only .js extension diff)
- Agent layer: zero changes, all local modifications preserved
- NVIDIA NIM: built-in provider with Nemotron models, attribution headers
- MiniMax: built-in minimax/minimax-cn providers, MiniMax-M3 image models
- Ant Ling: new provider and thinkingFormat support
- Bedrock: fix empty user/tool-result text, Opus 4.7+ temperature suppression
- Anthropic: Claude Opus 4.7+ temperature field suppression
- OpenAI: HTTP timeout for non-Codex providers, MiniMax thinking fix
- Models: xAI Grok 4.1, NVIDIA Nemotron, MiniMax M3, GPT-5.5 minimal thinking"
```

## 验收清单

- [ ] `pnpm build` — 编译通过
- [ ] `pnpm test:ai` — 全量测试无新增失败
- [ ] `grep -rn "fallbackModels\|registerModel" src/pi-mono/` — 本地修改完整
- [ ] `grep -rn '\.ts"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts"` — 无遗漏扩展名
- [ ] `cat src/pi-mono/VERSION` — 显示 v0.78.1
- [ ] `cat src/pi-mono/agent/index.ts` — 仅含 4 行 core export
- [ ] `curl -s http://localhost:9191/health` — 服务正常

## 关键变更说明

### 1. NVIDIA NIM 内置 Provider

`nvidia` 从无到有成为内置 provider：
- `types.ts`: `ApiProvider` 联合类型新增 `"nvidia"`
- `env-api-keys.ts`: 新增 `nvidia: "NVIDIA_API_KEY"` 映射
- `models.generated.ts`: 新增 4 个 NVIDIA Nemotron 模型
- `provider-attribution.ts`: 新增 NIM 请求归因头 `X-BILLING-INVOKE-ORIGIN: Pi`

### 2. Claude Opus 4.7+ Temperature 抑制

Anthropic Claude Opus 4.7+ 拒绝非默认 temperature 值。修复在两个层面：
- `types.ts`: `ModelCompat` 新增 `supportsTemperature?: boolean` 标志
- `providers/anthropic.ts`: 对 `supportsTemperature: false` 的模型抑制 temperature 参数
- `providers/amazon-bedrock.ts`: Bedrock Claude 模型同步修复

### 3. MiniMax API Thinking 修复

`openai-completions.ts` 修复 MiniMax API（非 NVIDIA NIM 网关）的 thinking 参数：
- 内网版 API (`api.minimax.chat`) 使用 `reasoning_effort` 参数
- 国际版 API (`api.minimaxi.com`) 使用 `thinking: { type: "enabled" }` 对象
- 国际版 API 需要 `token_index` 映射处理

### 4. HTTP Timeout 修复（非 Codex Provider）

修复了 HTTP timeout 设置不对非 Codex provider 生效的 bug。`httpIdleTimeoutMs` 现在作为所有支持 timeout 的 provider 的默认 SDK 请求超时。禁用 timeout 时发送最大 int32 值而非 0（SDK 将 timeout=0 视为立即超时）。

### 5. Bedrock 空文本修复

修复 Bedrock 请求中必填 user/tool-result 文本字段为空时的问题，使用 placeholder 文本替代空白内容，并跳过空的 replay 文本块。

### 6. 新增 Provider 和 thinkingFormat

- `ant-ling`: 蚂蚁灵川 provider，`thinkingFormat: "ant-ling"` 发送 `reasoning: { effort }`（仅在 mapped effort 非 null 时）
- `minimax` / `minimax-cn`: 内置 MiniMax 官方 API provider
- `ThinkingLevel` 新增 `"minimal"` 和 `"xhigh"` 两个级别
