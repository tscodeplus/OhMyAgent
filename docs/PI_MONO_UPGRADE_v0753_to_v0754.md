# pi-mono v0.75.3 → v0.75.4 升级实施方案

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-20 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.75.3 (commit `e60a5f8`) |
| 目标版本 | v0.75.4 |
| 升级难度 | **中** — 通用 `.js`→`.ts` 扩展名变更波及所有文件，但逻辑冲突少 |

## 上游变更清单

### 核心变更：导入扩展名 `.js` → `.ts`

v0.75.4 将所有内部相对导入/导出的扩展名从 `.js` 改为 `.ts`，以支持 Node.js `--experimental-strip-types` 模式。这是**仓库级通用变更**，影响每个文件的 import/export 语句。

#### 项目扩展名策略：保持 `.js`

TypeScript 编译器在 emit 模式下不允许 `.ts` 扩展名导入，启用 `allowImportingTsExtensions` 必须同时设置 `noEmit` 或 `emitDeclarationOnly`，与项目的 `tsc` + `tsc-alias` 构建管线不兼容。

**决策**：从上游复制文件后，统一将 `.ts` 扩展名回退为 `.js`。功能上完全等价，差异仅在于 Node.js 原生 strip-types 模式（项目使用 tsx 开发，不受影响）。

**每次升级的通用操作**（不仅是 v0.75.4，后续版本若上游保持 `.ts` 扩展名同样适用）：

```bash
# 回退全部 .ts → .js 扩展名
find src/pi-mono -name "*.ts" -exec sed -i 's/from "\([^"]*\)\.ts"/from "\1.js"/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i "s/from '\([^']*\)\.ts'/from '\1.js'/g" {} +
find src/pi-mono -name "*.ts" -exec sed -i 's/export \* from "\([^"]*\)\.ts"/export * from "\1.js"/g' {} +
# 处理动态 import("...ts")
find src/pi-mono -name "*.ts" -exec sed -i 's/import("\([^"]*\)\.ts")/import("\1.js")/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i "s/import('\([^']*\)\.ts')/import('\1.js')/g" {} +
```

### Agent 层 — 修改文件

| 文件 | 变更行数 | 变更内容 | 与本地修改冲突？ |
|------|---------|---------|:---:|
| `agent-loop.ts` | 26 | `.ts` 扩展名 + `executeToolCalls` abortion 检查（5 处 `signal.aborted` 守卫） | **无** — 不涉及 `streamAssistantResponse()` 中的 fallback 循环 |
| `agent.ts` | 11 | `.ts` 扩展名 + `PendingMessageQueue.mode` 从构造函数参数改为显式属性赋值 | **无** — 不涉及 fallbackModels 代码 |
| `types.ts` | 0 | 无内部变更 | — |
| `index.ts` | 38 | 全部导出 `.js` → `.ts`（含 harness 路径） | 需注意：我们未嵌入 harness，需手动更新 core export 行 |
| `proxy.ts` | 0 | **无变更**（不在 v0.75.4 diff 中） | — |
| `node.ts` | 4 | `.js` → `.ts`（全部为 harness 引用） | 项目不使用，跳过 |

### AI 层 — 修改文件（按重要性）

**所有 AI 源文件**均受 `.js` → `.ts` 扩展名影响。以下为有额外逻辑变更的文件：

| 文件 | 变更行数 | 额外逻辑变更 |
|------|---------|-------------|
| `simple-options.ts` | 22 | vLLM 兼容：maxTokens 覆盖 contextWindow 时 cap 更保守 (issue #4675) |
| `openai-completions.ts` | 25 | HTTP idle timeout + 流式处理改进 |
| `providers/anthropic.ts` | 28 | Anthropic provider 改进 |
| `openai-codex-responses.ts` | 23 | Codex 响应处理 |
| `openai-responses.ts` | 21 | 错误处理 |
| `providers/amazon-bedrock.ts` | 20 | Bedrock 处理 |
| `providers/mistral.ts` | 18 | Mistral provider |
| `providers/google.ts` | 16 | Google provider |
| `models.generated.ts` | 102 | 模型目录更新 |
| `image-models.generated.ts` | 17 | 图像模型更新 |
| `types.ts` | 6 | 类型扩展 |
| `providers/openai-prompt-cache.ts` | **新增** | OpenAI prompt 缓存工具（8 行） |

### 本地修改文件的影响分析

| 文件 | 本地修改 | 上游变更 | 处理方式 |
|------|---------|---------|---------|
| `agent/agent.ts` | `fallbackModels` (4 处) | `.ts` + 构造函数 | 覆盖后重新应用 |
| `agent/agent-loop.ts` | fallback 循环 + delta 事件 + 错误日志 | `.ts` + abort 检查 | 覆盖后重新应用 |
| `agent/types.ts` | `fallbackModels` in AgentLoopConfig | **无变更** | 保持不变 |
| `agent/index.ts` | 仅 4 行 core export（无 harness） | 全部 `.js`→`.ts` + harness | sed 改 4 行 `.js`→`.ts`，不引入 harness |
| `ai/models.ts` | `registerModel()` | `.ts` (4 处 import) | sed 改扩展名，保留本地修改 |
| `ai/api-registry.ts` | `registerApiProvider()` | `.ts` (2 处 import) | sed 改扩展名，保留本地修改 |
| `ai/bedrock-provider.ts` | Bedrock 声明 | `.ts` (2 处 import) | sed 改扩展名，保留本地修改 |
| `ai/stream.ts` | `stream()` 函数 | `.ts` (8 处) | sed 改扩展名，保留本地修改 |
| `ai/oauth.ts` | OAuth 支持 | `.ts` (2 处 export) | sed 改扩展名，保留本地修改 |
| `ai/cli.ts` | 无本地修改 | `.ts` (4 处) + 逻辑 | 直接覆盖 |

## 升级步骤

### Step 1: 复制 AI 层全部文件

AI 层有 60 个文件变更，逐个覆盖繁琐易错。全量复制最高效：

```bash
SRC=/tmp/pi-upstream/packages/ai/src
DST=src/pi-mono/ai
cp -r "$SRC/"* "$DST/"
```

### Step 2: 复制 Agent 层核心文件（排除 harness）

Agent 层不能全量复制（会引入不需要的 harness 文件）：

```bash
SRC=/tmp/pi-upstream/packages/agent/src
DST=src/pi-mono/agent
cp "$SRC/agent-loop.ts" "$DST/"
cp "$SRC/agent.ts" "$DST/"
# proxy.ts, types.ts 无变更，不复制
# index.ts, node.ts 含 harness 引用，手动处理
```

### Step 3: 重新应用本地修改

#### `agent/agent.ts` — 4 处添加

在覆盖后的 v0.75.4 版本上：
1. `AgentOptions` 接口末尾：`fallbackModels?: Model<any>[]`
2. `Agent` 类属性区：`public fallbackModels?: Model<any>[]`
3. 构造器末尾：`this.fallbackModels = options.fallbackModels`
4. `buildConfig()` 中 `toolExecution` 后：`fallbackModels: this.fallbackModels`

#### `agent/agent-loop.ts` — fallback 循环

在 `streamAssistantResponse()` 函数中，将单模型调用替换为多模型 fallback 循环（与 v0.74.1 升级相同的合并逻辑）。

#### `agent/index.ts` — 手动更新扩展名

仅修改 4 行核心 export，不引入 harness 导出：

```bash
sed -i 's|from "./agent.js"|from "./agent.ts"|' src/pi-mono/agent/index.ts
sed -i 's|from "./agent-loop.js"|from "./agent-loop.ts"|' src/pi-mono/agent/index.ts
sed -i 's|from "./proxy.js"|from "./proxy.ts"|' src/pi-mono/agent/index.ts
sed -i 's|from "./types.js"|from "./types.ts"|' src/pi-mono/agent/index.ts
```

#### AI 层本地修改文件 — sed 改扩展名

以下文件保留本地修改版本，仅将内部 import/export 扩展名 `.js` → `.ts`：

```bash
for f in models.ts api-registry.ts bedrock-provider.ts stream.ts oauth.ts; do
  sed -i 's/from "\(.*\)\.js"/from "\1.ts"/g' src/pi-mono/ai/$f
  sed -i "s/from '\(.*\)\.js'/from '\1.ts'/g" src/pi-mono/ai/$f
done
```

### Step 4: 更新版本标记

```bash
echo "v0.75.4" > src/pi-mono/VERSION
sed -i 's/v0.75.3/v0.75.4/g' CLAUDE.md
```

### Step 5: 编译验证

```bash
pnpm build
```

### Step 6: 测试验证

```bash
pnpm test:ai
```

### Step 7: 提交

```bash
git add -A
git commit -m "feat: upgrade embedded pi-mono from v0.75.3 to v0.75.4"
```

## 验收清单

- [ ] `pnpm build` — 编译通过
- [ ] `pnpm test:ai` — 全量测试无新增失败
- [ ] `grep -rn "fallbackModels\|registerModel" src/pi-mono/` — 本地修改完整
- [ ] `grep -rn '\.js"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts"` — 确认无遗漏的 `.js` 扩展名
- [ ] `cat src/pi-mono/VERSION` — 显示 v0.75.4
- [ ] 确认 `agent/index.ts` 仅含 4 行 core export（未引入 harness）
