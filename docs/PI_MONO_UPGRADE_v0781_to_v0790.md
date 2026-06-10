# pi-mono v0.78.1 → v0.79.0 升级实施方案

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-06-09 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.78.1 |
| 目标版本 | v0.79.0 |
| 目标 tag | `v0.79.0` |
| 升级难度 | **极低** — Agent 层零变更（仅 harness 子目录）；AI 层 6 个文件全部无本地修改冲突 |

## 破坏性变更评估

**结论：对本项目零破坏性变更。**

| 变更 | 影响 |
|------|------|
| OpenRouter routing 条件放宽 (`v0.78.1: baseUrl.includes("openrouter.ai") && compat` → `v0.79.0: compat only`) | 不影响 — 项目 NVIDIA NIM 等 custom provider 未使用 `openRouterRouting` compat |
| `OpenAIResponsesCompat` 新增 `supportsDeveloperRole?: boolean` (默认 `true`) | 向后兼容 — 默认行为不变 |
| 所有函数签名、类型接口 | 无变更，完全向后兼容 |

v0.79.0 的"Project Trust"等核心新功能全部在 coding-agent 层（`packages/coding-agent/`），pi-mono AI/Agent 层仅有小修小补。

## 上游变更清单

### Agent 层

**零变更**。v0.78.1 到 v0.79.0 的 diff 中 `packages/agent/src/` 仅有 `harness/compaction/compaction.ts` 1 行修改。核心文件（agent.ts、agent-loop.ts、types.ts、proxy.ts）**无任何变动**。

→ `fallbackModels`、fallback 循环、cache tracking 等本地修改**完全不受影响**。

### AI 层 — 6 个文件变更（全部修改，无新增/删除）

| 文件 | 变更量 | 变更内容 | 与本地修改冲突？ |
|------|--------|---------|:---:|
| `models.generated.ts` | 165+/158- | 模型元数据更新：新模型、上下文窗口修正、thinking 配置更新 | **无** |
| `image-models.generated.ts` | 30+/0- | 新增图像模型配置 | **无** |
| `types.ts` | 3+/1- | `OpenRouterRouting` JSDoc 更新；`OpenAIResponsesCompat` 新增 `supportsDeveloperRole?: boolean` | **无** — 本地版本仅扩展名差异 |
| `providers/openai-completions.ts` | 1+/1- | OpenRouter routing 条件简化：移除 `baseUrl.includes("openrouter.ai")` 硬编码检查 | **无** — 本地版本仅扩展名差异 |
| `providers/openai-responses-shared.ts` | 2+/1- | `developer` vs `system` 角色选择支持 `supportsDeveloperRole` compat | **无** — 本地版本仅扩展名差异 |
| `providers/openai-responses.ts` | 1+/0- | `getCompat()` 新增 `supportsDeveloperRole` 默认值 `true` | **无** — 本地版本仅扩展名差异 |

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
| `ai/providers/openai-completions.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/openai-responses-shared.ts` | 无本地修改 | **是** | 直接覆盖 |
| `ai/providers/openai-responses.ts` | 无本地修改 | **是** | 直接覆盖 |

**结论：零逻辑冲突。** 所有本地逻辑修改在未被上游触碰的文件中。

## 升级步骤

### Step 1: 克隆上游 v0.79.0

```bash
git clone --branch v0.79.0 --depth 1 https://github.com/earendil-works/pi.git /tmp/pi-v0790
```

### Step 2: 复制变更文件

```bash
SRC=/tmp/pi-v0790/packages/ai/src
DST=src/pi-mono/ai

cp "$SRC/models.generated.ts" "$DST/"
cp "$SRC/image-models.generated.ts" "$DST/"
cp "$SRC/types.ts" "$DST/"
cp "$SRC/providers/openai-completions.ts" "$DST/providers/"
cp "$SRC/providers/openai-responses-shared.ts" "$DST/providers/"
cp "$SRC/providers/openai-responses.ts" "$DST/providers/"
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
echo "v0.79.0" > src/pi-mono/VERSION
sed -i 's/Built on an embedded fork of \*\*pi-mono v0.78.1\*\*/Built on an embedded fork of **pi-mono v0.79.0**/' CLAUDE.md
```

### Step 6: 编译 + 测试

```bash
pnpm build && pnpm test:ai
```

### Step 7: 提交

```bash
git add src/pi-mono/ docs/PI_MONO_UPGRADE_v0781_to_v0790.md
git commit -m "feat: upgrade embedded pi-mono from v0.78.1 to v0.79.0

- AI layer: 6 files (all direct overwrites, only .js extension diff)
- Agent layer: zero changes, all local modifications preserved
- OpenAI Responses: supportsDeveloperRole compat for custom providers
- OpenRouter routing: generalize to OpenRouter-compatible providers
- Models: metadata refresh, context window corrections
- Zero breaking changes for OhMyAgent"
```

## 验收清单

- [ ] `pnpm build` — 编译通过
- [ ] `pnpm test:ai` — 全量测试无新增失败
- [ ] `grep -rn "fallbackModels\|registerModel" src/pi-mono/` — 本地修改完整
- [ ] `grep -rn '\.ts"' src/pi-mono/agent/ src/pi-mono/ai/ --include="*.ts"` — 无遗漏扩展名
- [ ] `cat src/pi-mono/VERSION` — 显示 v0.79.0
- [ ] `cat src/pi-mono/agent/index.ts` — 仅含 4 行 core export
- [ ] `curl -s http://localhost:9191/health` — 服务正常

## 关键变更说明

### 1. OpenRouter Routing 条件放宽

**之前** (v0.78.1):
```ts
if (model.baseUrl.includes("openrouter.ai") && model.compat?.openRouterRouting) {
```
**之后** (v0.79.0):
```ts
if (model.compat?.openRouterRouting) {
```

自定义 provider 如果配置了 `openRouterRouting` compat 但 base URL 指向其他域名（如 Cloudflare AI Gateway 或其他 OpenAI 兼容代理），现在也会发送 `provider` 路由偏好。对本项目无影响。

### 2. `supportsDeveloperRole` Compat

新增 `OpenAIResponsesCompat.supportsDeveloperRole?: boolean`（默认 `true`）。

某些 OpenAI Responses 兼容 provider 不支持 `developer` role，只能识别 `system`。当 `compat.supportsDeveloperRole: false` 时，即使模型开启 reasoning，系统 prompt 也以 `system` role 发送。

`openai-responses-shared.ts` 的 role 选择逻辑：
```ts
// before
const role = model.reasoning ? "developer" : "system";
// after
const role = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
```

### 3. 自动生成模型更新

- `models.generated.ts`: 165 行新增、158 行删除，模型元数据刷新
- `image-models.generated.ts`: 30 行新增图像模型
