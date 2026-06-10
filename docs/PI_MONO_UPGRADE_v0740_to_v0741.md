# pi-mono v0.74.0 → v0.74.1 升级计划

## 升级概览

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-17（计划） |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.74.0 |
| 目标版本 | v0.74.1 |
| 嵌入目录 | `src/pi-mono/` |

v0.74.1 是一个大版本，新增 Agent Harness（会话管理/压缩/分支摘要）、Image Generation API、`prepareNextTurn` hook、模型目录大幅更新（2317 行）等。

## v0.74.1 上游变更清单

### Agent 层 (packages/agent/src/)

#### 修改文件

| 文件 | 变更行数 | 变更内容 |
|------|---------|---------|
| `agent-loop.ts` | 27 | `prepareNextTurn` hook 调用点：每轮 turn 结束后调用，可动态替换 model/context/thinkingLevel；参数重命名 `currentContext`→`initialContext`、`config`→`initialConfig` |
| `agent.ts` | 19 | 新增 `prepareNextTurn` 可选属性（构造器赋值 + buildConfig 传递）；`QueueMode` 类型移到 types.ts 并重新导出；错误处理改为通过 `processEvents` 发送 `message_start`/`message_end`/`turn_end` 事件 |
| `types.ts` | 29 | 新增 `QueueMode` 类型（`"all" \| "one-at-a-time"`）；新增 `AgentLoopTurnUpdate`、`PrepareNextTurnContext` 接口；`AgentLoopConfig` 新增 `prepareNextTurn` 回调 |
| `index.ts` | 36 | **全部为 harness 相关导出**（见下）。核心 agent/agent-loop 导出无变更 |

#### 新增文件（Agent Harness — 不嵌入）

Harness 是 Agent 的高级封装层，提供会话持久化、上下文压缩、分支摘要、技能调用、prompt 模板等功能。共 20 个源文件 + 1 个入口文件（`node.ts`），约 6100 行代码。

```
harness/agent-harness.ts              — 核心 harness（995 行）
harness/compaction/branch-summarization.ts — 分支摘要（262 行）
harness/compaction/compaction.ts      — 上下文压缩（755 行）
harness/compaction/utils.ts           — 压缩工具（144 行）
harness/env/nodejs.ts                 — Node.js 执行环境（523 行）
harness/messages.ts                   — 消息构建器（164 行）
harness/prompt-templates.ts           — Prompt 模板引擎（267 行）
harness/session/jsonl-repo.ts         — JSONL 仓库（177 行）
harness/session/jsonl-storage.ts      — JSONL 存储（293 行）
harness/session/memory-repo.ts        — 内存仓库（50 行）
harness/session/memory-storage.ts     — 内存存储（131 行）
harness/session/repo-utils.ts         — 仓库工具（51 行）
harness/session/session.ts            — 会话管理（252 行）
harness/session/uuid.ts               — UUID 生成（54 行）
harness/skills.ts                     — 技能系统（375 行）
harness/system-prompt.ts              — 系统提示词（34 行）
harness/types.ts                      — 类型定义（820 行）
harness/utils/shell-output.ts         — Shell 输出处理（143 行）
harness/utils/truncate.ts             — 截断工具（343 行）
node.ts                               — 入口重导出（2 行，全部为 harness 引用）
```

**决策：不嵌入 harness 文件。** 项目直接使用 Agent 类 API，未使用 AgentHarness。嵌入 ~6100 行无用代码徒增维护负担。`agent.ts`/`agent-loop.ts`/`types.ts` 中与 harness 无关的变更（`prepareNextTurn` hook 等）仍需纳入。`agent/index.ts` 和 `node.ts` 的变更全部是 harness 导出，跳过。

### AI 层 (packages/ai/src/)

#### 修改文件

| 文件 | 变更行数 | 变更内容 |
|------|---------|---------|
| `types.ts` | 105 | 新增 `ImagesApi`、`ImagesModel`、`ImagesContext`、`AssistantImages`、`ImagesOptions`、`ProviderImagesOptions`、`KnownImagesProvider` 等图像生成相关类型 |
| `models.generated.ts` | 2317 | 大规模模型目录更新（新增模型、定价调整、参数更新） |
| `index.ts` | +4 | 新增导出：`image-models`、`images`、`images-api-registry`、`providers/images/register-builtins` |
| `env-api-keys.ts` | +1/-2 | 新增 `together` provider API key 映射；github-copilot 环境变量简化为仅 `COPILOT_GITHUB_TOKEN` |
| `providers/openai-completions.ts` | 51 | OpenAI 流式补全改进 |
| `providers/openai-codex-responses.ts` | 56 | Codex Responses 改进 |
| `providers/amazon-bedrock.ts` | 27 | HTTP 代理支持（NodeHttpHandler + createHttpProxyAgentsForTarget） |
| `providers/anthropic.ts` | 24 | Anthropic provider 改进 |
| `providers/simple-options.ts` | 2 | 简单选项微调 |
| `utils/overflow.ts` | 7 | 溢出处理改进 |

#### 新增文件

**图像生成（必须嵌入）：**

| 文件 | 说明 |
|------|------|
| `image-models.generated.ts` | 图像模型目录（429 行），通过 OpenRouter 支持 12 个模型 |
| `image-models.ts` | `getImageModel()` / `getImageProviders()` / `getImageModels()` |
| `images-api-registry.ts` | 图像 API provider 注册表：`registerImagesApiProvider()` / `getImagesApiProvider()` |
| `images.ts` | `generateImages()` 主入口函数 |
| `providers/images/openrouter.ts` | OpenRouter 图像生成实现（187 行） |
| `providers/images/register-builtins.ts` | 内置图像 provider 注册（调用 `registerImagesApiProvider`） |

**工具类（必须嵌入）：**

| 文件 | 说明 |
|------|------|
| `utils/node-http-proxy.ts` | Node.js HTTP 代理（被 amazon-bedrock.ts 引用，缺少会导致编译失败） |

## Image Generation 专题分析

### 内置支持

v0.74.1 的内置图像生成通过 **OpenRouter** 作为统一网关，覆盖以下模型：

| 模型 | 来源 | 输出类型 |
|------|------|---------|
| `black-forest-labs/flux.2-flex` | Black Forest Labs | image |
| `black-forest-labs/flux.2-klein-4b` | Black Forest Labs | image |
| `black-forest-labs/flux.2-max` | Black Forest Labs | image |
| `black-forest-labs/flux.2-pro` | Black Forest Labs | image |
| `bytedance-seed/seedream-4.5` | ByteDance | image |
| `google/gemini-2.5-flash-image` | Google（Nano Banana） | image + text |
| `google/gemini-3-pro-image-preview` | Google（Nano Banana Pro） | image + text |
| `google/gemini-3.1-flash-image-preview` | Google（Nano Banana 2） | image + text |
| `openai/gpt-5-image` | OpenAI | image + text |
| `openai/gpt-5-image-mini` | OpenAI | image + text |
| `openai/gpt-5.4-image-2` | OpenAI | image + text |

**API 类型：仅 `openrouter-images` 一种。** 所有模型通过 OpenRouter API 代理调用。

### 是否支持自定义 provider？

**支持。** `registerImagesApiProvider()` 可以注册自定义图像生成 API。签名：

```typescript
registerImagesApiProvider<TApi extends ImagesApi, TOptions extends ImagesOptions>(
  provider: ImagesApiProvider<TApi, TOptions>,
  sourceId?: string,
): void
```

自定义 provider 需实现 `ImagesFunction<TApi, TOptions>` 函数，接收 `ImagesModel`（模型定义）、`ImagesContext`（提示词/参数）、`ImagesOptions`（请求选项），返回 `AssistantImages`（图片数组）。

**重要说明：** `registerImagesApiProvider()` 注册的是 **API 协议实现**（如 `openrouter-images`），而非单个图像模型。如果需要接入 OpenAI DALL-E、Stability AI 等不同于 OpenRouter 协议的 API，需要注册全新的 API 类型。注册后，可以为该 API 类型注册多个模型（通过 `registerModel` 或 `image-models.generated.ts` 定义）。

### 与项目现有 Image Generation 的关系

项目当前有独立的图像生成工具栈：

```
src/tools/builtins/multimodal/
  image-generation-definition.ts  — ToolDefinition（工具描述、参数校验、路径安全检查、文件写入）
  image-generation-provider.ts    — ImageGenerationProvider 接口 + NoOp 实现
```

**结论：保留项目现有实现，不删除。**

原因：

1. **功能层级不同**：pi-mono 的 `generateImages()` 是低层 API 调用（接收模型定义 + 提示词，返回图片数据 buffer），项目的 `image_generation` 是高层工具封装（参数校验 + 路径安全检查 + 本地文件写入 + ToolDefinition 注册）。两者是**互补关系**，不是替代关系。pi-mono 负责"如何调用图像 API"，项目工具负责"工具如何集成到 Agent 系统"。

2. **尚未集成**：项目的 `ImageGenerationProvider` 接口是抽象层，目前只有 NoOp 实现。未来优化方向：实现一个 `PiMonoImageGenerationProvider`，内部调用 pi-mono 的 `generateImages()`，将两者桥接。这是独立的后续工作，不在本次升级范围。

3. **项目当前未启用图像生成**：config.yaml 中 `multimodal.imageGeneration.enabled` 未配置，无实际运行依赖，无回归风险。

## 升级步骤

### Step 1: 文件分类

#### 直接覆盖（上游有变更 + 本地无修改）

从 v0.74.1 源码复制到 `src/pi-mono/`：

```
# AI 层 — 修改文件
ai/types.ts
ai/models.generated.ts               — 2317 行模型更新
ai/index.ts
ai/env-api-keys.ts                   — together provider + github-copilot 修正
ai/providers/openai-completions.ts
ai/providers/openai-codex-responses.ts
ai/providers/amazon-bedrock.ts       — HTTP 代理（依赖 node-http-proxy.ts）
ai/providers/anthropic.ts
ai/providers/simple-options.ts
ai/utils/overflow.ts

# AI 层 — 新增文件（需先创建目录 ai/providers/images/）
ai/image-models.generated.ts
ai/image-models.ts
ai/images-api-registry.ts
ai/images.ts
ai/providers/images/openrouter.ts
ai/providers/images/register-builtins.ts

# AI 层 — 新增文件（工具类）
ai/utils/node-http-proxy.ts
```

#### 合并覆盖（上游有变更 + 本地有修改）

| 文件 | 上游变更 | 本地修改 | 合并难度 |
|------|---------|---------|---------|
| `agent/agent.ts` | `prepareNextTurn` 属性 + `QueueMode` 导出 + 错误处理事件化（3 处） | `fallbackModels` 属性声明、构造器赋值、buildConfig 传递（4 处） | **低**：无行级重叠，复制 v0.74.1 后重新插入本地修改即可 |
| `agent/agent-loop.ts` | `prepareNextTurn` hook 调用点 + `runLoop()` 参数重命名（`currentContext`→`initialContext`） | fallback 重试循环 + delta 事件 + 错误日志（整个 LLM 调用块） | **高**：v0.74.1 改变了 `runLoop()` 签名和内部结构，fallback 逻辑需要在新的 `let config`/`let currentContext` 可变变量结构上移植 |
| `agent/types.ts` | `QueueMode` 类型 + `AgentLoopTurnUpdate` 接口 + `PrepareNextTurnContext` 接口 + `prepareNextTurn` callback（4 处新增） | `fallbackModels` in `AgentLoopConfig`（1 处） | **低**：无行级重叠，复制 v0.74.1 后再添加 fallbackModels 行即可 |

#### 保持不变（仅本地有修改，上游无变更）

```
ai/models.ts              — registerModel()
ai/api-registry.ts        — 自定义 API provider 注册（registerApiProvider）
ai/bedrock-provider.ts    — Bedrock 模块声明
ai/stream.ts              — stream() 函数
ai/oauth.ts               — OAuth 支持
agent/proxy.ts            — v0.74.1 无变更（已确认不在上游 diff 中）
```

#### 不嵌入

```
agent/harness/**           — Agent Harness 系统（20 文件，~6100 行）
agent/node.ts              — 仅 harness 重导出
agent/index.ts             — 上游变更全部为 harness 导出，无需更新
```

### Step 2: 重新应用本地修改

#### `agent/agent.ts`（4 处，低难度）

使用 v0.74.1 版本后，在与 v0.74.0 相同的位置添加：
1. `AgentOptions` 接口：`fallbackModels?: Model<any>[]`
2. `Agent` 类属性：`public fallbackModels?: Model<any>[]`
3. 构造器：`this.fallbackModels = options.fallbackModels`
4. `buildConfig()`：`fallbackModels: this.fallbackModels`

#### `agent/agent-loop.ts`（重点合并，高难度）

v0.74.1 的 `runLoop()` 函数结构变化：

```
v0.74.0:  runLoop(currentContext, newMessages, config, ...)
v0.74.1:  runLoop(initialContext, newMessages, initialConfig, ...)
            let currentContext = initialContext
            let config = initialConfig
            // ... 循环内 turn_end 后调用 prepareNextTurn 动态更新 config
```

合并策略：以 v0.74.1 的 `runLoop()` 为基础，在其 LLM 调用段（`streamFunction(config.model, ...)`）中嵌入 fallback 循环：

```
const models = [config.model, ...(config.fallbackModels ?? [])];
const baseLen = currentContext.messages.length;  // 注意：v0.74.1 使用 currentContext
let lastError: AssistantMessage | null = null;

for (let attempt = 0; attempt < models.length; attempt++) {
  const model = models[attempt];
  currentContext.messages.length = baseLen;  // 回滚到尝试前状态
  // ... 原有 streamFunction + event 处理 + error fallback 逻辑
}
// 所有模型耗尽，emit lastError
```

#### `agent/types.ts`（1 处，低难度）

在 v0.74.1 版本的 `AgentLoopConfig` 接口中，于 `model: Model<any>` 后添加：
```typescript
fallbackModels?: Model<any>[];
```

### Step 3: 创建新目录

```bash
mkdir -p src/pi-mono/ai/providers/images
```

### Step 4: 更新 VERSION 和 CLAUDE.md

```bash
echo "v0.74.1" > src/pi-mono/VERSION
```

`CLAUDE.md` 中 `v0.74.0` → `v0.74.1`。

### Step 5: 编译验证

```bash
pnpm build   # tsc && tsc-alias
```

### Step 6: 测试验证

```bash
pnpm test:ai
```

重点关注：
- `tests/agent/agent-factory.test.ts` — Agent 工厂（验证 fallbackModels 传递）
- `tests/e2e/approval-flow.test.ts` — 审批流集成（验证 beforeToolCall hook + agent-loop 流程）
- `tests/w0/pi-mono-import.test.ts` — pi-mono 包导入（验证新导出无冲突）

### Step 7: 启动服务验证

```bash
pnpm dev
curl http://localhost:9191/health
```

## 风险评估

| 风险 | 等级 | 说明 |
|------|------|------|
| agent-loop.ts 合并冲突 | **高** | v0.74.1 改变了 `runLoop()` 签名（参数重命名 + `let config` 可变变量），与 fallback 循环在同一函数内。必须以 v0.74.1 为基础逐行移植，合并后重点测试 agent 创建→prompt→fallback 全链路 |
| models.generated.ts 2317 行更新 | 低 | 项目使用 `registerModel()` + `custom_providers` 注册自定义模型，不依赖内置模型目录 |
| amazon-bedrock HTTP 代理 | 低 | 新增 `utils/node-http-proxy.ts` 依赖，需确认编译通过。项目未使用 Bedrock，运行时无影响 |
| 图像生成新文件 | 低 | 7 个新增文件，与项目现有代码无交互。现有 `image_generation` 工具通过独立接口运作，互不干扰 |
| Harness 导出缺失 | 低 | `agent/index.ts` 上游新增了 30+ 行 harness 导出，我们不嵌入 harness 意味着这些导出在编译后的 `dist/` 中会找不到模块。但由于项目不 import 任何 harness 符号，`tsc` 编译不会触发模块解析错误（TypeScript 只解析实际 import 的模块） |
| types.ts 新增类型 | 低 | `ImagesApi`、`AgentLoopTurnUpdate` 等为纯类型定义，与现有代码无命名冲突 |
| github-copilot 环境变量 | 低 | `env-api-keys.ts` 移除了 `GH_TOKEN`/`GITHUB_TOKEN` 回退，仅保留 `COPILOT_GITHUB_TOKEN`。项目未使用 GitHub Copilot，无影响 |

## 验证清单

```bash
# 1. 确认所有本地修改仍存在
grep -rn "fallbackModels\|registerModel" src/pi-mono/

# 2. 确认图像生成文件到位
ls src/pi-mono/ai/image-models.generated.ts
ls src/pi-mono/ai/image-models.ts
ls src/pi-mono/ai/images-api-registry.ts
ls src/pi-mono/ai/images.ts
ls src/pi-mono/ai/providers/images/openrouter.ts
ls src/pi-mono/ai/providers/images/register-builtins.ts
ls src/pi-mono/ai/utils/node-http-proxy.ts

# 3. 确认包名引用无 @mariozechner 残留
grep -rn "@mariozechner" src/ tests/ --include="*.ts"

# 4. 编译验证
pnpm build

# 5. 全量测试
pnpm test:ai

# 6. 启动服务验证
pnpm dev
```
