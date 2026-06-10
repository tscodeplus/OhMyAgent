# pi-mono v0.73.0 → v0.74.0 升级计划

## 升级概览

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-08（计划） |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)（已从 badlogic/pi-mono 迁移） |
| 源版本 | v0.73.0 |
| 目标版本 | v0.74.0 |
| 中间版本 | v0.73.1（变更已包含在本文档中） |
| 嵌入目录 | `src/pi-mono/` |

### 仓库迁移说明

pi-mono 项目已从 `badlogic/pi-mono` 迁移到 `earendil-works/pi`，npm 包 scope 从 `@mariozechner/*` 更名为 `@earendil-works/*`。v0.74.0 的核心变更就是此次重命名。

本次升级跨越两个版本：v0.73.1（功能性更新）和 v0.74.0（包重命名）。计划一步到位从 v0.73.0 直接升级到 v0.74.0。

## v0.73.1 上游变更清单

### Agent 层 (packages/agent/src/)

**无源代码变更**（仅 `package.json` 和 `CHANGELOG.md` 版本号更新）。

### AI 层 (packages/ai/src/)

#### 修改文件

| 文件 | 变更行数 | 变更内容 |
|------|---------|---------|
| `index.ts` | +2 | 新增导出 `OAuthSelectOption`、`OAuthSelectPrompt` 类型 |
| `models.generated.ts` | 84 | 模型目录更新：移除 `kimi-coding/k2p6`（Anthropic 协议旧版）；OpenRouter 多模型定价与上下文窗口更新（qwen3.5-397b 降价，gemini-2.5-pro 免费期结束恢复定价）；新增 `qwen/qwen3.6-35b-a3b`；Kimi K2.6 模型参数调整 |
| `providers/openai-codex-responses.ts` | +1/-1 | 修复：`systemPrompt` 为空时提供默认值 `"You are a helpful assistant."` |
| `providers/openai-completions.ts` | 254 | **流式内容块处理重构**：将单一 `currentBlock` 追踪拆分为 `textBlock`/`thinkingBlock`/`toolCallBlocksByIndex` 三个独立追踪器，解决 OpenAI 流式补全中 content 与 tool_call 交错出现时的顺序问题。新增 `finishBlock()`、`ensureTextBlock()`、`ensureThinkingBlock()`、`ensureToolCallBlock()` 方法 |
| `providers/openai-responses-shared.ts` | +14 | 新增 `response.reasoning_text.delta` 事件处理（流式 reasoning delta 推送）；改进 reasoning 内容提取（同时读取 `summary` 和 `content` 字段） |
| `utils/oauth/openai-codex.ts` | 45 | 错误处理结构化：`TokenFailure` 从 `{type: "failed"}` 扩展为 `{type, message, status?}`；所有 `console.error` 改为返回结构化错误信息 |
| `utils/oauth/types.ts` | +12 | 新增 `OAuthSelectOption`、`OAuthSelectPrompt` 类型；`OAuthLoginCallbacks` 新增 `onSelect` 回调（交互式多选项登录） |

## v0.74.0 上游变更清单

### 核心变更：包 scope 重命名

所有 `@mariozechner/*` → `@earendil-works/*`。`providers/` 目录无任何变更。

### Agent 层 (packages/agent/src/)

| 文件 | 变更行数 | 变更内容 |
|------|---------|---------|
| `agent-loop.ts` | 1 | import `@mariozechner/pi-ai` → `@earendil-works/pi-ai` |
| `agent.ts` | 1 | 同上 |
| `proxy.ts` | 1 | 同上 |
| `types.ts` | 2 | import + JSDoc 中 `@mariozechner/pi-ai` → `@earendil-works/pi-ai` |

### AI 层 (packages/ai/src/)

| 文件 | 变更行数 | 变更内容 |
|------|---------|---------|
| `cli.ts` | 12 | npx 命令名从 `@mariozechner/pi-ai` → `@earendil-works/pi-ai`（6 处帮助文本字符串） |
| `models.generated.ts` | 271 | opencode `big-pickle` API 类型 anthropic-messages → openai-completions（base URL 同步变更）；opencode-go 移除 `mimo-v2-omni`、`mimo-v2-pro`；openrouter 移除 `allenai/olmo-3.1-32b-instruct`；Kimi K2.6 定价从 3x limits 降为标准定价；opencode 部分模型补充定价信息 |

## 升级策略

### 方案：直接覆盖 + tsconfig paths 迁移

两个版本的变更均为文件内容替换（无逻辑冲突），推荐直接从 v0.73.0 升级到 v0.74.0，一步到位。

### 关键决策：包名迁移

v0.74.0 将 import 从 `@mariozechner/*` 改为 `@earendil-works/*`。需要处理的文件分为两类：

**A. pi-mono 内部文件（5 个，覆盖后自动解决）：**

```
src/pi-mono/agent/agent-loop.ts   — import 重命名
src/pi-mono/agent/agent.ts        — import 重命名
src/pi-mono/agent/proxy.ts        — import 重命名
src/pi-mono/agent/types.ts        — import + JSDoc 重命名
src/pi-mono/ai/cli.ts             — npx 命令名更新
```

**B. 项目文件（11 个，需手动替换）：**

src/ 目录（7 个）：
```
src/provider/mimo-provider.ts             — registerApiProvider
src/provider/pi-ai-setup.ts               — getModel
src/agent/agent-factory.ts                — Agent, getModel
src/memory/memory-summarizer.ts           — getModel (dynamic import)
src/app/bootstrap.ts                      — registerModel
src/vision-bridge/vision-bridge-config.ts — getModel
src/vision-bridge/vision-bridge-service.ts — streamSimple
```

tests/ 目录（4 个）：
```
tests/w0/pi-mono-import.test.ts           — getModel, getProviders, stream; Agent
tests/agent/agent-factory.test.ts         — Agent
tests/agent/skill-integration.test.ts     — Agent
tests/manual/vision-bridge-test.ts        — getModel, registerModel, streamSimple
```

**推荐方案：更新 tsconfig paths + 全局替换项目文件引用**

1. `tsconfig.json` 路径映射改为：
   ```
   "@earendil-works/pi-ai": ["./src/pi-mono/ai/index.ts"],
   "@earendil-works/pi-agent-core": ["./src/pi-mono/agent/index.ts"]
   ```
2. 11 个项目文件中的 `@mariozechner/pi-ai` → `@earendil-works/pi-ai`，`@mariozechner/pi-agent-core` → `@earendil-works/pi-agent-core`
3. `CLAUDE.md` 中版本号引用更新

此方案与上游保持一致，避免后续升级时反复处理包名冲突。

### 注意：types.ts 中未变更的 @mariozechner 引用

`src/pi-mono/agent/types.ts` 第 266 行有一个 JSDoc 示例中的 `@mariozechner/agent` 引用，v0.74.0 **未**修改它（可能是上游遗漏）。该引用仅出现在文档注释中，不影响编译。处理方式：**与上游保持一致，暂不修改**，后续版本若上游修改则同步。

## 升级步骤

### Step 1: 文件分类

#### 直接覆盖（上游有变更 + 本地无修改）

从 v0.74.0 源码复制到 `src/pi-mono/`：

```
ai/index.ts                               — v0.73.1: OAuth 类型导出新增
ai/models.generated.ts                    — v0.73.1 + v0.74.0: 模型目录更新
ai/providers/openai-codex-responses.ts    — v0.73.1: 默认 system prompt 修复
ai/providers/openai-completions.ts        — v0.73.1: 流式内容块重构
ai/providers/openai-responses-shared.ts   — v0.73.1: reasoning delta 事件
ai/utils/oauth/openai-codex.ts            — v0.73.1: 结构化错误处理
ai/utils/oauth/types.ts                   — v0.73.1: OAuth select 类型
ai/cli.ts                                 — v0.74.0: npx 命令名更新（本地无修改）
agent/proxy.ts                            — v0.74.0: import 重命名（本地无修改）
```

#### 合并覆盖（上游有变更 + 本地有修改）

| 文件 | 上游变更 | 本地修改 | 处理方式 |
|------|---------|---------|---------|
| `agent/agent-loop.ts` | v0.74.0: import 重命名 (1 行) | fallback 重试循环 + delta 事件 + 错误日志 | 使用 v0.74.0，重新应用本地修改 |
| `agent/agent.ts` | v0.74.0: import 重命名 (1 行) | fallbackModels 属性 | 使用 v0.74.0，重新应用本地修改 |
| `agent/types.ts` | v0.74.0: import + JSDoc 重命名 (2 行) | fallbackModels in AgentLoopConfig | 使用 v0.74.0，重新应用本地修改 |

#### 保持不变（仅本地有修改，上游无变更）

```
ai/models.ts          — registerModel() 函数
ai/api-registry.ts    — 自定义 API provider 注册
ai/bedrock-provider.ts — Bedrock 模块声明
ai/stream.ts          — stream() 函数
ai/oauth.ts           — OAuth 支持
```

### Step 2: 重新应用本地修改

| 文件 | 修改点 | 行数估算 |
|------|--------|---------|
| `agent/agent.ts` | `fallbackModels?: Model<any>[]` 属性声明 + 构造函数赋值 + 传递给 AgentLoopConfig | ~5 行 |
| `agent/agent-loop.ts` | 移除 `isLastModel` 条件使所有 fallback 模型的 delta 事件发送给客户端 + 错误日志 | ~10 行 |
| `agent/types.ts` | `fallbackModels` in `AgentLoopConfig` 接口 | ~3 行 |
| `ai/models.ts` | `registerModel()` 函数（保持不变，无需操作） | — |

### Step 3: tsconfig paths 更新

`tsconfig.json` 第 18-19 行：

```diff
-      "@mariozechner/pi-ai": ["./src/pi-mono/ai/index.ts"],
-      "@mariozechner/pi-agent-core": ["./src/pi-mono/agent/index.ts"]
+      "@earendil-works/pi-ai": ["./src/pi-mono/ai/index.ts"],
+      "@earendil-works/pi-agent-core": ["./src/pi-mono/agent/index.ts"]
```

**同时更新 `vitest.config.ts` 第 9-10 行**（Vite 不直接使用 tsconfig paths，需要独立配置）：

```diff
-      '@mariozechner/pi-ai': path.resolve(__dirname, 'src/pi-mono/ai/index.ts'),
-      '@mariozechner/pi-agent-core': path.resolve(__dirname, 'src/pi-mono/agent/index.ts'),
+      '@earendil-works/pi-ai': path.resolve(__dirname, 'src/pi-mono/ai/index.ts'),
+      '@earendil-works/pi-agent-core': path.resolve(__dirname, 'src/pi-mono/agent/index.ts'),
```

### Step 4: 项目文件包名替换

11 个文件中的 `@mariozechner/pi-ai` → `@earendil-works/pi-ai`，`@mariozechner/pi-agent-core` → `@earendil-works/pi-agent-core`：

**src/ (7 个):**
- `src/provider/mimo-provider.ts`
- `src/provider/pi-ai-setup.ts`
- `src/agent/agent-factory.ts`
- `src/memory/memory-summarizer.ts`
- `src/app/bootstrap.ts`
- `src/vision-bridge/vision-bridge-config.ts`
- `src/vision-bridge/vision-bridge-service.ts`

**tests/ (4 个):**
- `tests/w0/pi-mono-import.test.ts`
- `tests/agent/agent-factory.test.ts`
- `tests/agent/skill-integration.test.ts`
- `tests/manual/vision-bridge-test.ts`

### Step 5: 更新 VERSION 和 CLAUDE.md

```bash
echo "v0.74.0" > src/pi-mono/VERSION
```

`CLAUDE.md` 中 `v0.73.0` → `v0.74.0`。

### Step 6: 编译验证

```bash
pnpm build   # tsc && tsc-alias — 验证路径别名重写正确
```

### Step 7: 测试验证

```bash
pnpm test:ai   # 全量测试，确认无回归
```

重点观察：
- `tests/e2e/approval-flow.test.ts` — 审批流集成测试
- `tests/skills/` — 技能系统测试
- `tests/agent/agent-factory.test.ts` — Agent 工厂测试（确认 fallbackModels 正常）

## 风险评估

| 风险 | 等级 | 说明 |
|------|------|------|
| 包名替换遗漏 | 中 | tsconfig paths 更新后，遗漏的文件会导致编译错误，容易发现和修复 |
| openai-completions 流式重构 | **无影响** | 项目自定义 MiMo provider 使用独立的 `mimo-openai-completions` API 类型和自定义 `streamMimo`/`streamSimpleMimo` 函数，**不走** `streamOpenAICompletions` 路径，完全不受此次重构影响 |
| models.generated.ts 模型变更 | 低 | 项目使用 `registerModel()` 注册自定义模型，不依赖 models.generated.ts 中的模型定义。opencode-go 移除的 `mimo-v2-omni`/`mimo-v2-pro` 与项目使用的 `xiaomi-token-plan-cn/mimo-v2.5` 无关 |
| fallbackModels 冲突 | 低 | v0.74.0 agent 文件仅有一行 import 变更，与本地 fallbackModels 修改无逻辑冲突，合并时只需注意保留 fallback 相关代码 |
| tsc-alias 路径重写 | 低 | 变更后 tsc-alias 需要将新的 `@earendil-works/pi-ai` 路径重写为相对路径。tsconfig paths 配置正确即可自动处理 |

## 自定义 MiMo Provider 状态

继续保留，无需变更：
- v0.73.1 的 `openai-completions.ts` 流式重构不影响自定义 MiMo provider（使用独立的 API 类型和 stream 函数）
- v0.74.0 的 `providers/` 目录无变更
- 内置 `xiaomi-token-plan-cn` provider 无变更

## 验证清单

```bash
# 1. 确认所有本地修改仍存在
grep -rn "fallbackModels\|registerModel" src/pi-mono/

# 2. 确认包名引用全部更新（应无 @mariozechner 残留，除 types.ts:266 的 JSDoc 示例）
grep -rn "@mariozechner" src/ tests/ --include="*.ts"

# 3. 确认编译通过
pnpm build

# 4. 确认测试通过
pnpm test:ai

# 5. 启动服务验证
pnpm dev
```
