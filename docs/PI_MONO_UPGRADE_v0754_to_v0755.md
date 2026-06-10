# pi-mono v0.75.4 → v0.75.5 升级实施方案

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-23 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.75.4 |
| 目标版本 | v0.75.5 |
| 目标 commit | `89ba72c` |
| 升级难度 | **低** — Agent 层零变更；AI 层变更不与本地逻辑修改冲突 |

## 上游变更清单

### Agent 层

**零变更**。v0.75.4 到 v0.75.5 的 diff 中 `packages/agent/src/` 下无任何文件变动。

→ `fallbackModels` 等本地修改**完全不受影响**，无需任何处理。

### AI 层 — 10 个文件变更 (9 修改 + 1 新增)

| 文件 | 变更量 | 变更内容 | 与本地修改冲突？ |
|------|--------|---------|:---:|
| `index.ts` | +1 行 | 新增 `OAuthDeviceCodeInfo` 导出 | **无** — 追加一行即可 |
| `types.ts` | +11 行 | `ModelCompat` 新增 `forceAdaptiveThinking?: boolean` 字段 | **无** — 仅新增字段 |
| `providers/anthropic.ts` | ~30 行 | 移除 `supportsAdaptiveThinking()` 辅助函数，改用 `model.compat?.forceAdaptiveThinking` 模式；文档改进 | **无** — 本地版本仅扩展名差异 |
| `providers/amazon-bedrock.ts` | +2 行 | Bedrock Claude 模型默认使用 `model.maxTokens` 而非不设上限 | **无** — 本地版本仅扩展名差异 |
| `cli.ts` | +18 行 | 新增 `onDeviceCode` 和 `onSelect` 回调支持 (TUI 层) | **无** — 项目不使用 CLI TUI |
| `models.generated.ts` | ~100 行 | 6 个 Claude 模型新增 `compat: {"forceAdaptiveThinking": true}`；新增 Cloudflare Workers AI 模型 (Granite 4.0 H Micro, Llama 3.3 70B fp8, Mistral Small 3.1 24B, Qwen3 30B A3b fp8)；部分模型 contextWindow 修正 | **无** — 自动生成文件 |
| `utils/oauth/github-copilot.ts` | 重构 (~80 行) | 将 device code 轮询逻辑提取到共享 `device-code.ts` 模块 | **无** — 本地版本仅扩展名差异 |
| `utils/oauth/device-code.ts` | **新增 81 行** | 通用 OAuth device code flow 轮询工具 | **无** — 新文件 |
| `utils/oauth/index.ts` | +1 行 | 新增 `export * from "./device-code.ts"` | **无** — 追加一行即可 |
| `utils/oauth/types.ts` | +8 行 | 新增 `OAuthDeviceCodeInfo` 类型；`OAuthLoginCallbacks.onSelect` 改为必填；新增 `onDeviceCode` 回调 | **无** — 本地版本仅扩展名差异 |

### 本地修改影响分析

| 文件 | 本地修改内容 | 上游 v0.75.4→v0.75.5 是否变更 | 处理方式 |
|------|-------------|:---:|---------|
| `agent/agent.ts` | `fallbackModels` (4 处) | **否** | 保持不变 |
| `agent/agent-loop.ts` | fallback 多模型循环 | **否** | 保持不变 |
| `agent/types.ts` | `fallbackModels` in AgentLoopConfig | **否** | 保持不变 |
| `agent/index.ts` | 仅 4 行 core export（无 harness） | **否** | 保持不变 |
| `ai/models.ts` | `registerModel()` 函数 | **否** | 保持不变 |
| `ai/api-registry.ts` | 无逻辑变更（仅扩展名） | **否** | 保持不变 |
| `ai/stream.ts` | 无逻辑变更（仅扩展名） | **否** | 保持不变 |
| `ai/bedrock-provider.ts` | 无逻辑变更（仅扩展名） | **否** | 保持不变 |
| `ai/oauth.ts` | 无逻辑变更（仅扩展名） | **否** | 保持不变 |
| `ai/providers/anthropic.ts` | 无逻辑变更（仅扩展名） | **是** | 直接覆盖，sed 改扩展名 |
| `ai/providers/amazon-bedrock.ts` | 无逻辑变更（仅扩展名） | **是** | 直接覆盖，sed 改扩展名 |
| `ai/utils/oauth/github-copilot.ts` | 无逻辑变更（仅扩展名） | **是** | 直接覆盖，sed 改扩展名 |
| `ai/utils/oauth/types.ts` | 无逻辑变更（仅扩展名） | **是** | 直接覆盖，sed 改扩展名 |
| `ai/utils/oauth/index.ts` | 无逻辑变更（仅扩展名） | **是** | 直接覆盖，sed 改扩展名 |
| `ai/index.ts` | 无逻辑变更（仅扩展名） | **是** | 覆盖 + `.js` → `.ts` + 追加 OAuthDeviceCodeInfo |
| `ai/types.ts` | 无逻辑变更（仅扩展名） | **是** | 直接覆盖，sed 改扩展名 |
| `ai/cli.ts` | 无逻辑变更（仅扩展名） | **是** | 直接覆盖，sed 改扩展名 |
| `ai/models.generated.ts` | 无本地修改 | **是** | 直接覆盖，sed 改扩展名 |
| `ai/utils/oauth/device-code.ts` | 不存在 | **新增** | 复制新文件，sed 改扩展名 |

**结论：零逻辑冲突。** 所有本地逻辑修改都在未被上游触碰的文件中。升级仅涉及逐文件覆盖 + 扩展名回退。

## 升级步骤

### Step 1: 克隆上游 v0.75.5

```bash
git clone --branch v0.75.5 --depth 1 https://github.com/earendil-works/pi.git /tmp/pi-v0755
```

### Step 2: 复制变更文件

```bash
SRC=/tmp/pi-v0755/packages/ai/src
DST=src/pi-mono/ai

# 有变更的现有文件
cp "$SRC/index.ts" "$DST/"
cp "$SRC/types.ts" "$DST/"
cp "$SRC/cli.ts" "$DST/"
cp "$SRC/models.generated.ts" "$DST/"
cp "$SRC/providers/anthropic.ts" "$DST/providers/"
cp "$SRC/providers/amazon-bedrock.ts" "$DST/providers/"
cp "$SRC/utils/oauth/github-copilot.ts" "$DST/utils/oauth/"
cp "$SRC/utils/oauth/index.ts" "$DST/utils/oauth/"
cp "$SRC/utils/oauth/types.ts" "$DST/utils/oauth/"

# 新增文件
cp "$SRC/utils/oauth/device-code.ts" "$DST/utils/oauth/"
```

### Step 3: 回退 `.ts` → `.js` 扩展名

项目策略：保持 `.js` 扩展名以兼容 TypeScript emit 模式。

```bash
find src/pi-mono -name "*.ts" -exec sed -i 's/from "\([^"]*\)\.ts"/from "\1.js"/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i "s/from '\\([^']*\\)\\.ts'/from '\\1.js'/g" {} +
find src/pi-mono -name "*.ts" -exec sed -i 's/export \* from "\([^"]*\)\.ts"/export * from "\1.js"/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i 's/import("\([^"]*\)\.ts")/import("\1.js")/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i "s/import('\\([^']*\\)\\.ts')/import('\\1.js')/g" {} +
```

**注意**：`device-code.ts` 是全新文件，内部无 `from "..."` 导入语句，sed 命令执行后对其无实际修改。

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
echo "v0.75.5" > src/pi-mono/VERSION
# 仅更新项目当前版本声明（第 9 行），不动 "since v0.75.4" 历史陈述
sed -i 's/Built on an embedded fork of \*\*pi-mono v0.75.4\*\*/Built on an embedded fork of **pi-mono v0.75.5**/' CLAUDE.md
```

### Step 6: 编译验证

```bash
pnpm build
```

### Step 7: 测试验证

```bash
pnpm test:ai
```

### Step 8: 提交

```bash
git add -A
git commit -m "feat: upgrade embedded pi-mono from v0.75.4 to v0.75.5"
```

## 验收清单

- [ ] `pnpm build` — 编译通过
- [ ] `pnpm test:ai` — 全量测试无新增失败
- [ ] `grep -rn "fallbackModels\|registerModel" src/pi-mono/` — 本地修改完整
- [ ] `grep -rn '\.ts"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts"` — 确认无遗漏的 `.ts` 扩展名
- [ ] `cat src/pi-mono/VERSION` — 显示 v0.75.5
- [ ] `ls src/pi-mono/ai/utils/oauth/device-code.ts` — 新文件已添加
- [ ] 确认 `agent/index.ts` 仅含 4 行 core export（未引入 harness）

## 关键变更说明

### 1. `forceAdaptiveThinking` 机制

v0.75.5 将自适应思考判定从硬编码的模型 ID 匹配改为声明式配置：

- **之前**：`supportsAdaptiveThinking(model.id)` 检查模型 ID 是否包含 `opus-4-6`/`sonnet-4-6` 等字符串
- **之后**：检查 `model.compat?.forceAdaptiveThinking === true`
- 6 个 Claude 模型（Opus 4.6/4.7、Sonnet 4.6）在 `models.generated.ts` 中通过 `compat` 字段声明此能力
- 自定义 Anthropic 兼容 provider 可通过配置 `compat.forceAdaptiveThinking: true` 启用

这对使用 Claude 模型的场景**无行为变更**，仅是实现方式从硬编码匹配改为配置驱动。

### 2. OAuth Device Code 流程重构

GitHub Copilot OAuth 的 device code 轮询逻辑被提取为通用工具 `device-code.ts`：

- `pollOAuthDeviceCodeFlow()` — 通用轮询函数，基于 RFC 8628
- GitHub Copilot provider 从内联轮询改为调用此工具
- 不影响现有的 MiMo 或 Anthropic provider 集成

### 3. Bedrock Claude 默认 maxTokens

v0.75.4 中 Bedrock Claude 模型不设 `maxTokens` 时使用 API 默认值 (4096)，可能导致截断。v0.75.5 改为使用模型定义的 `model.maxTokens` 作为默认值。

### 4. 依赖变更（无需操作）

上游 `packages/ai/package.json` 中 `@smithy/node-http-handler` 从 `4.6.1` 升至 `4.7.3`。项目 package.json 中已有 `"@smithy/node-http-handler": "^4.6.1"`，semver 覆盖此范围，无需执行 `pnpm install`。Agent 包仅有自身版本号变更，无新增依赖。
