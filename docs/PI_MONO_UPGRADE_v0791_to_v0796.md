# pi-mono v0.79.1 → v0.79.6 升级实施方案

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-06-17 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.79.1 |
| 目标版本 | v0.79.6 |
| 跨越版本 | v0.79.2, v0.79.3, v0.79.4, v0.79.5, v0.79.6 (5 个版本) |
| 升级难度 | **中** — Agent 层**首次有核心文件变更**（agent-loop.ts, types.ts），需合并本地修改 |

## 各版本关键变更摘要

| 版本 | 主要变更 |
|------|---------|
| v0.79.2 | Bedrock 数据保留验证错误文档链接 |
| v0.79.3 | OpenAI GPT-5.4/GPT-5.5 Codex contextWindow 修正为 272k |
| v0.79.4 | 独立二进制 SHA256SUMS 校验 |
| v0.79.5 | Provider 作用域 API key 环境变量；全局 HTTP proxy；Vercel AI Gateway attribution |
| v0.79.6 | HTTP dispatcher fetch 覆盖修复；OpenCode Go DeepSeek V4 thinking-off 修复；**Agent 层 executePreparedToolCall 并发安全修复** |

## 上游变更清单 (v0.79.1 → v0.79.6 累计)

### Agent 层 — 2 个文件变更 (⚠️ 均含本地修改)

| 文件 | 变更量 | 变更内容 | 本地修改 | 处理方式 |
|------|--------|---------|:---:|---------|
| `agent-loop.ts` | +6/-0 | `executePreparedToolCall` 新增 `acceptingUpdates` 守卫，防止 tool 回调在 promise settled 后更新 | **是** (fallback 循环 + cache 追踪) | **手动合并补丁** |
| `types.ts` | +6/-1 | `AgentToolUpdateCallback` JSDoc 文档补充 | **是** (fallbackModels) | **手动合并补丁** |

### AI 层 — 21 个文件变更 (1 新增 + 20 修改)

#### 本地修改文件 (需手动合并)

| 文件 | 变更量 | 变更内容 | 本地修改 | 处理方式 |
|------|--------|---------|:---:|---------|
| `models.ts` | +4/-1 | `calculateCost` 支持 `cacheWrite1h` (1h 缓存写 ×2 定价) | **是** (registerModel) | **手动合并补丁** |
| `stream.ts` | +1/-1 | `withEnvApiKey` 传递 `options?.env` 给 `getEnvApiKey` | 仅扩展名 | 直接覆盖 |

#### 无冲突文件 (可直接覆盖)

| 文件 | 变更量 | 变更内容 |
|------|--------|---------|
| `models.generated.ts` | 880+/927- | 模型元数据全面更新 (GPT-5.x contextWindow 修正，新模型等) |
| `providers/amazon-bedrock.ts` | 70+/36- | 数据保留验证错误增强；1h cache write 支持 |
| `providers/anthropic.ts` | 34+/17- | Google Vertex AI Thinking 支持提升；1h cache write |
| `providers/azure-openai-responses.ts` | 12+/5- | Azure 配置增强 |
| `providers/openai-codex-responses.ts` | 25+/18- | Codex 响应处理改进 |
| `providers/openai-completions.ts` | 25+/8- | OpenCode Go DeepSeek V4 thinking-off 修复；`env` 支持 |
| `providers/openai-responses-shared.ts` | 2+/1- | 修复 |
| `providers/openai-responses.ts` | 9+/6- | 增强 |
| `providers/google-vertex.ts` | 18+/4- | Vertex AI Thinking 预算 |
| `providers/google.ts` | 2+/1- | 修复 |
| `providers/cloudflare.ts` | 5+/4- | Cloudflare 增强 |
| `providers/simple-options.ts` | 1+/0- | 修复 |
| `types.ts` | 11+/0- | `ModelCompat` 新增字段；`env` 配置支持 |
| `env-api-keys.ts` | 26+/62- | API key 环境变量重构 |
| `utils/node-http-proxy.ts` | 22+/33- | HTTP proxy 重构 |
| `utils/oauth/anthropic.ts` | 2+/1- | OAuth 修复 |
| `utils/oauth/openai-codex.ts` | 2+/1- | OAuth 修复 |
| `utils/overflow.ts` | 3+/2- | 溢出检测更新 |
| `image-models.generated.ts` | ~12 | 图像模型更新 |

#### 新增文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `utils/provider-env.ts` | 52 | Provider 作用域环境变量解析工具 |

### 本地修改影响分析

| 文件 | 本地修改内容 | 上游是否变更 | 处理方式 |
|------|-------------|:---:|---------|
| `agent/agent.ts` | `fallbackModels` (4 处) | **否** | 保持不变 |
| `agent/agent-loop.ts` | fallback 多模型循环 + cache 追踪 (~60 行) | **是** | **手动合并** — 上游改的是 `executePreparedToolCall`，我们的修改在 fallback 循环，区域不重叠 |
| `agent/types.ts` | `fallbackModels` in AgentLoopConfig | **是** | **手动合并** — 上游仅补充 JSDoc，不影响我们的字段 |
| `agent/index.ts` | 仅 4 行 core export | **否** | 保持不变 |
| `agent/proxy.ts` | 无修改 | **否** | 保持不变 |
| `ai/models.ts` | `registerModel()` 函数 | **是** | **手动合并** — 上游改的是 `calculateCost`，在文件后半部，不冲突 |
| `ai/api-registry.ts` | `registerApiProvider()` | **否** | 保持不变 |
| `ai/stream.ts` | 仅扩展名差异 | **是** | 直接覆盖 |

## 手动合并详细方案

### 1. agent-loop.ts — `executePreparedToolCall` 补丁

我们的本地修改区域：fallback 重试循环 (行 ~300-400)、cache 追踪日志 (行 ~370-400)

上游变更区域：`executePreparedToolCall` 函数 (行 ~630-660)

**不重叠**。在两个不同位置应用：
5行4列
```diff
+	let acceptingUpdates = true;
```
在 `(partialResult) => {` 回调前插入
10行11/13列
```diff
+	if (!acceptingUpdates) return;
```
在 updateEvents.push 前插入
15行17列
```diff
+		acceptingUpdates = false;
```
在 `await Promise.all(updateEvents)` 前插入
20行21列
```diff
+	} finally {
+		acceptingUpdates = false;
 	}
```

### 2. agent/types.ts — JSDoc 补丁

我们的修改：`AgentLoopConfig.fallbackModels` 字段 (行 138)

上游变更：`AgentToolUpdateCallback` 的 JSDoc (行 ~354)

**不重叠**。直接用上游版本替换，保留我们的 `fallbackModels` 字段。

### 3. ai/models.ts — `calculateCost` 补丁

我们的修改：`registerModel()` 函数 (行 39-51)

上游变更：`calculateCost` 函数 (行 ~42-48)

**不重叠**。取 upstream 的 `calculateCost` 替换本地版本，保留 `registerModel`。

## 升级步骤

### Step 1: 下载 v0.79.6 文件

```bash
# 从 raw.githubusercontent.com 下载所有变更文件到临时目录
BASE="https://raw.githubusercontent.com/earendil-works/pi/v0.79.6/packages"
# ... 下载 AI 层 21 个文件 + Agent 层 2 个文件
```

### Step 2: 复制无冲突文件 (直接覆盖)

```bash
DST=src/pi-mono/ai
SRC=/tmp/pi-v0796-ai

# 14 个 AI 文件直接覆盖
cp "$SRC/models.generated.ts" "$DST/"
cp "$SRC/types.ts" "$DST/"
cp "$SRC/env-api-keys.ts" "$DST/"
cp "$SRC/image-models.generated.ts" "$DST/"
cp "$SRC/stream.ts" "$DST/"
cp "$SRC/providers/amazon-bedrock.ts" "$DST/providers/"
cp "$SRC/providers/anthropic.ts" "$DST/providers/"
cp "$SRC/providers/azure-openai-responses.ts" "$DST/providers/"
cp "$SRC/providers/cloudflare.ts" "$DST/providers/"
cp "$SRC/providers/google-vertex.ts" "$DST/providers/"
cp "$SRC/providers/google.ts" "$DST/providers/"
cp "$SRC/providers/openai-codex-responses.ts" "$DST/providers/"
cp "$SRC/providers/openai-completions.ts" "$DST/providers/"
cp "$SRC/providers/openai-responses-shared.ts" "$DST/providers/"
cp "$SRC/providers/openai-responses.ts" "$DST/providers/"
cp "$SRC/providers/simple-options.ts" "$DST/providers/"
cp "$SRC/utils/overflow.ts" "$DST/utils/"
cp "$SRC/utils/node-http-proxy.ts" "$DST/utils/"
cp "$SRC/utils/oauth/anthropic.ts" "$DST/utils/oauth/"
cp "$SRC/utils/oauth/openai-codex.ts" "$DST/utils/oauth/"
cp "$SRC/utils/provider-env.ts" "$DST/utils/"  # 新文件
```

### Step 3: 手动合并 3 个冲突文件

- `agent/agent-loop.ts` — 应用 `acceptingUpdates` 补丁
- `agent/types.ts` — 用上游版本替换 JSDoc 区域
- `ai/models.ts` — 用上游 `calculateCost` 替换

### Step 4: 回退 `.ts` → `.js` 扩展名

```bash
find src/pi-mono -name "*.ts" -exec sed -i 's/from "\([^"]*\)\.ts"/from "\1.js"/g' {} +
# ... 5 条命令
```

### Step 5: 验证

```bash
grep -rn '\.ts"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts" | grep -v '.codegraph'
grep -rn "fallbackModels\|registerModel" src/pi-mono/
cat src/pi-mono/agent/index.ts
```

### Step 6: 更新版本标记

```bash
echo "v0.79.6" > src/pi-mono/VERSION
sed -i 's/v0\.79\.1/v0.79.6/' CLAUDE.md
```

### Step 7: 编译 + 测试

```bash
pnpm build && pnpm test:ai
```

### Step 8: 提交

```bash
git add src/pi-mono/ docs/PI_MONO_UPGRADE_v0791_to_v0796.md
git commit -m "feat: upgrade embedded pi-mono from v0.79.1 to v0.79.6

- AI layer: 21 files (1 new provider-env.ts)
- Agent layer: 2 files merged (agent-loop.ts acceptingUpdates guard,
  types.ts JSDoc)
- Models: Anthropic 1h cache write cost (2x input pricing)
- Providers: Bedrock 1h cache, Vertex AI thinking, Codex improvements
- Config: env overrides for provider-scoped API key environments
- Fixed: OpenCode Go DeepSeek V4 thinking-off, executePreparedToolCall
  concurrent safety"
```

## 验收清单

- [ ] `pnpm build` — 编译通过
- [ ] `pnpm test:ai` — 全量测试无新增失败
- [ ] `grep -rn "fallbackModels\|registerModel" src/pi-mono/` — 本地修改完整
- [ ] `grep -rn '\.ts"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts"` — 无遗漏扩展名
- [ ] `cat src/pi-mono/VERSION` — 显示 v0.79.6
- [ ] `cat src/pi-mono/agent/index.ts` — 仅含 4 行 core export
- [ ] `curl -s http://localhost:9191/health` — 服务正常
