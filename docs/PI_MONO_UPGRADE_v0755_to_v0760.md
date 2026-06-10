# pi-mono v0.75.5 → v0.76.0 升级实施方案

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-28 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.75.5 |
| 目标版本 | v0.76.0 |
| 目标 tag | `v0.76.0` |
| 升级难度 | **极低** — Agent 层零变更；AI 层 11 个文件变更全部无本地修改冲突 |

## 上游变更清单

### Agent 层

**零变更**。v0.75.5 到 v0.76.0 的 diff 中 `packages/agent/src/` 核心文件（agent.ts、agent-loop.ts、types.ts）无任何变动。仅 `harness/compaction/compaction.ts` 有 44 行变更，但项目不嵌入 harness。

→ `fallbackModels`、fallback 循环、cache tracking 等本地修改**完全不受影响**。

### AI 层 — 11 个文件变更 (10 修改 + 1 新增)

| 文件 | 变更量 | 变更内容 | 与本地修改冲突？ |
|------|--------|---------|:---:|
| `utils/abort-signals.ts` | **新增 41 行** | `combineAbortSignals()` 工具函数，用于组合多个 AbortSignal | **无** — 新文件 |
| `providers/openai-codex-responses.ts` | 246 行 | WebSocket/SSE 超时处理重构，引入 `websocketConnectTimeoutMs` 和组合 abort signals | **无** |
| `types.ts` | +6 行 | `RetryOptions` 新增 `websocketConnectTimeoutMs?: number` 字段 | **无** |
| `utils/overflow.ts` | 7 行 | 上下文溢出检测模式更新（Z.AI / Xiaomi MiMo 静默溢出处理） | **无** |
| `providers/anthropic.ts` | 2 行 | `maxRetries` 默认值改为 `0`（之前仅在非 undefined 时传递） | **无** |
| `providers/openai-completions.ts` | 2 行 | 同上 — `maxRetries` 默认 0 | **无** |
| `providers/openai-responses.ts` | 2 行 | 同上 — `maxRetries` 默认 0 | **无** |
| `providers/azure-openai-responses.ts` | 2 行 | 同上 — `maxRetries` 默认 0 | **无** |
| `providers/images/openrouter.ts` | 2 行 | 同上 — `maxRetries` 默认 0 | **无** |
| `providers/simple-options.ts` | 1 行 | `websocketConnectTimeoutMs` 传递到 HTTP options | **无** |
| `models.generated.ts` | 2 行 | OpenCode Zen (`gpt-5.3-codex-spark`) contextWindow 修正: 272000→128000 | **无** |

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
| `ai/providers/amazon-bedrock.ts` | Bedrock 本地适配 | **否** | 保持不变 |
| `ai/utils/oauth/*` | OAuth 本地适配 | **否** | 保持不变 |
| `ai/models.generated.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/types.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/anthropic.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/openai-codex-responses.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/openai-completions.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/openai-responses.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/azure-openai-responses.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/simple-options.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/images/openrouter.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/utils/overflow.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/utils/abort-signals.ts` | 不存在 | **新增** | 复制新文件 |

**结论：零逻辑冲突。** 所有本地逻辑修改都在未被上游触碰的文件中。升级仅涉及逐文件覆盖 + 扩展名回退 + 新增一个文件。

## 升级步骤

### Step 1: 克隆上游 v0.76.0

```bash
git clone --branch v0.76.0 --depth 1 https://github.com/earendil-works/pi.git /tmp/pi-v0760
```

### Step 2: 复制变更文件

```bash
SRC=/tmp/pi-v0760/packages/ai/src
DST=src/pi-mono/ai

# 修改的文件
cp "$SRC/models.generated.ts" "$DST/"
cp "$SRC/types.ts" "$DST/"
cp "$SRC/providers/anthropic.ts" "$DST/providers/"
cp "$SRC/providers/openai-codex-responses.ts" "$DST/providers/"
cp "$SRC/providers/openai-completions.ts" "$DST/providers/"
cp "$SRC/providers/openai-responses.ts" "$DST/providers/"
cp "$SRC/providers/azure-openai-responses.ts" "$DST/providers/"
cp "$SRC/providers/simple-options.ts" "$DST/providers/"
cp "$SRC/providers/images/openrouter.ts" "$DST/providers/images/"
cp "$SRC/utils/overflow.ts" "$DST/utils/"

# 新增文件
cp "$SRC/utils/abort-signals.ts" "$DST/utils/"
```

### Step 3: 回退 `.ts` → `.js` 扩展名

```bash
find src/pi-mono -name "*.ts" -exec sed -i 's/from "\([^"]*\)\.ts"/from "\1.js"/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i "s/from '\\([^']*\\)\\.ts'/from '\\1.js'/g" {} +
find src/pi-mono -name "*.ts" -exec sed -i 's/export \* from "\([^"]*\)\.ts"/export * from "\1.js"/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i 's/import("\([^"]*\)\.ts")/import("\1.js")/g' {} +
find src/pi-mono -name "*.ts" -exec sed -i "s/import('\\([^']*\\)\\.ts')/import('\\1.js')/g" {} +
```

**注意**：`abort-signals.ts` 内部无 import 语句，sed 对其无实际修改。

### Step 4: 更新版本标记

```bash
echo "v0.76.0" > src/pi-mono/VERSION
sed -i 's/Built on an embedded fork of \*\*pi-mono v0.75.5\*\*/Built on an embedded fork of **pi-mono v0.76.0**/' CLAUDE.md
```

### Step 5: 编译验证

```bash
pnpm build
```

### Step 6: 测试验证

```bash
pnpm test:ai
```

### Step 7: 启动服务验证

```bash
PORT=$(grep -oP 'OHMYAGENT_PORT=\K\d+' .env 2>/dev/null || echo 9191)
fuser -k $PORT/tcp 2>/dev/null
pkill -f "tsx src/index.ts" 2>/dev/null
sleep 1
nohup npx tsx src/index.ts > data/logs/ohmyagent.log 2>&1 &
sleep 2
curl -s http://localhost:$PORT/health
```

### Step 8: 提交

```bash
git add -A
git commit -m "feat: upgrade embedded pi-mono from v0.75.5 to v0.76.0

- AI layer: 11 files (10 modified + 1 new abort-signals.ts)
- Agent layer: zero changes, all local modifications preserved
- Provider retry: maxRetries now defaults to 0 explicitly (was SDK default)
- Codex: WebSocket/SSE timeout handling with combined abort signals
- Models: fix OpenCode Zen contextWindow 272000→128000
- New: combineAbortSignals() utility for multi-signal abort handling"
```

## 验收清单

- [ ] `pnpm build` — 编译通过
- [ ] `pnpm test:ai` — 全量测试无新增失败
- [ ] `grep -rn "fallbackModels\|registerModel" src/pi-mono/` — 本地修改完整
- [ ] `grep -rn '\.ts"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts"` — 确认无遗漏的 `.ts` 扩展名
- [ ] `cat src/pi-mono/VERSION` — 显示 v0.76.0
- [ ] `ls src/pi-mono/ai/utils/abort-signals.ts` — 新文件已添加
- [ ] `head -1 src/pi-mono/ai/utils/abort-signals.ts` — 确认内容正确
- [ ] `curl -s http://localhost:9191/health` — 服务正常启动
- [ ] 确认 `agent/index.ts` 仅含 4 行 core export（未引入 harness）

## 关键变更说明

### 1. Provider 重试控制 (`maxRetries` 默认 0)

v0.76.0 修复了 provider retry 行为：之前 `maxRetries` 仅在显式设置时才传递给 SDK，导致 SDK 可能使用自己的隐藏默认值进行重试。现在所有 provider（Anthropic、OpenAI Completions/Responses、Azure、OpenRouter）统一将 `maxRetries` 默认值设为 `0`，由 Pi 自身的 retry 机制完全控制重试行为。

代码变更（5 个文件，每个 1 行）：
```typescript
// 之前
...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
// 之后
maxRetries: options?.maxRetries ?? 0,
```

### 2. WebSocket 连接超时 (`websocketConnectTimeoutMs`)

`RetryOptions` 新增 `websocketConnectTimeoutMs` 字段，用于控制 Codex Responses WebSocket 连接握手的超时时间，与已有的 `timeoutMs`（流空闲超时）分离。`simple-options.ts` 将此字段传递到 HTTP options。

- `types.ts`: 新增字段定义
- `simple-options.ts`: 传递新字段到 HTTP agent options

### 3. 组合 Abort Signals (`abort-signals.ts`)

新增 `combineAbortSignals()` 工具函数，用于将多个 `AbortSignal`（如用户取消信号 + 超时信号）组合为单个 signal，任一触发时中止操作。Codex Responses provider 使用此机制同时监听 WebSocket 连接超时和用户取消。

### 4. Codex Responses 超时重构

`openai-codex-responses.ts` 有 246 行变更，主要是：
- 引入 `websocketConnectTimeoutMs` 参数
- 使用 `combineAbortSignals` 管理多个中止源
- 改进 WebSocket/SSE 超时错误处理
- 10s SSE response-header 超时

### 5. 上下文溢出检测更新

`overflow.ts` 新增对 Z.AI（静默接受溢出，通过 `usage.input > contextWindow` 检测）和 Xiaomi MiMo（截断到 contextWindow 后返回 `finish_reason: "length"` + 零输出）的溢出检测。

### 6. 模型配置修正

OpenCode Zen (`gpt-5.3-codex-spark`) 的 `contextWindow` 从错误的 272000 修正为 128000。
