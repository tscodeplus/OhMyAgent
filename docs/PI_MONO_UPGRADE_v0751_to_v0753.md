# pi-mono v0.75.1 → v0.75.3 升级实施方案

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-18 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.75.1 (commit `5fd12ed`) |
| 目标版本 | v0.75.3 |
| 中间版本 | v0.75.2 |
| 上游变更源文件数 | **1 个**（`models.generated.ts`） |
| 升级难度 | **低** — 单文件覆盖，无 Agent 层变更，无新增文件 |

## v0.75.2 上游变更

### 文件变更

| 文件 | 说明 |
|------|------|
| `models.generated.ts` | **Xiaomi token-plan 全部切换到 `openai-completions`** + 新增 `compat` 字段 |

### 核心变更：Token Plan 提供商协议切换

v0.75.1 仅切换了 `xiaomi`（api.xiaomimimo.com，API 计费域名）。v0.75.2 **补全了所有 token-plan 域名**：

| Provider | v0.75.1 API | v0.75.3 API | 域名变更 |
|----------|-------------|-------------|---------|
| `xiaomi` | `openai-completions` | `openai-completions` | 已切换 (v0.75.1) |
| `xiaomi-token-plan-cn` | `anthropic-messages` ❌ | **`openai-completions`** ✅ | `/anthropic` → `/v1` |
| `xiaomi-token-plan-ams` | `anthropic-messages` ❌ | **`openai-completions`** ✅ | `/anthropic` → `/v1` |
| `xiaomi-token-plan-sgp` | `anthropic-messages` ❌ | **`openai-completions`** ✅ | `/anthropic` → `/v1` |

### 新增 `compat` 兼容性字段

为所有小米 MiMo 模型新增兼容性元数据：

```typescript
compat: {
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek"
}
```

作用：告诉 `openai-completions` provider 在 multi-turn 请求时，协助理消息的 `reasoning_content` 字段，修复 thinking 模式下的多轮对话。这是 v0.75.1 切换到 `openai-completions` 后遗留的问题（issue #4678）。

该字段也添加到了 DeepSeek、OpenCode 等使用 DeepSeek 风格 thinking 的模型。

### 其他修复（不嵌入）

| 修复项 | 说明 |
|------|------|
| Bun 编译二进制 | undici shim 兼容 |
| Windows 编辑器 | vim/nvim 输入修复 |
| Windows 自更新 | pnpm/npm 包管理 |
| Windows 命令执行 | cross-spawn 替换 |

## v0.75.3 上游变更

### 文件变更

**无 `packages/ai/src/` 或 `packages/agent/src/` 变更。**

仅修复了 undici 8 HTTP/2 destroyed-session 问题（Node CLI 层）。

## 升级步骤

### Step 1: 直接覆盖（1 个文件）

从 v0.75.3 源码复制到 `src/pi-mono/`：

```
ai/models.generated.ts   — Token Plan API 切换 + compat 字段
```

### Step 2: 更新版本标记

```bash
echo "v0.75.3" > src/pi-mono/VERSION
```

`CLAUDE.md`：`v0.75.1` → `v0.75.3`。

### Step 3: 编译验证

```bash
pnpm build
```

### Step 4: 测试验证

```bash
pnpm test:ai
```

### Step 5: 提交

```bash
git add -A
git commit -m "feat: upgrade embedded pi-mono from v0.75.1 to v0.75.3"
```

---

## 专题：自定义 MiMo Provider 去留评估（更新）

### 背景变化

v0.75.2 将 **全部 4 个 xiaomi 提供商**（包括 token-plan 系列）切换到 `openai-completions` 协议。此前 v0.75.1 仅切换了 `xiaomi`（API 计费域名），token-plan 仍使用 `anthropic-messages`。这一变化消除了我们保留自定义 MiMo provider 的最大理由。

### 当前对比（v0.75.3）

| 维度 | 内置 `xiaomi-token-plan-cn` | 自定义 `mimo` |
|------|:---:|:---:|
| API 协议 | ✅ `openai-completions` | ✅ `openai-completions` |
| 域名 | `token-plan-cn.xiaomimimo.com/v1` | `token-plan-cn.xiaomimimo.com/v1` |
| Auth header | `Authorization: Bearer` | `api-key` |
| reasoning_content | ✅ `compat.requiresReasoningContentOnAssistantMessages` | ✅ 自定义实现 |
| thinking 注入 | ✅ `compat.thinkingFormat: deepseek` | ✅ 自定义 `thinking: { type: 'enabled' }` |
| session 亲和性 | 不支持 | ✅ `prompt_cache_key` |
| 代码量 | 0（内置） | ~300 行 |

### 结论：可移除，需验证

**协议和域名已完全匹配。** 移除自定义 MiMo provider 的前置条件已满足。

唯一待验证项：**认证 header 格式**。内置 `openai-completions` 使用 `Authorization: Bearer <key>`，自定义使用 `api-key: <key>`。需要实测 token-plan 端点是否接受 Bearer 格式的 token plan key。

### 迁移操作清单

若实测验证通过，按以下步骤移除：

**Step 1 — config.yaml 变更：**

```yaml
# fallback_models: 将 mimo/mimo-v2.5 改为 xiaomi-token-plan-cn/mimo-v2.5
fallback_models:
  - xiaomi-token-plan-cn/mimo-v2.5    # 替换 mimo/mimo-v2.5
  - deepseek/deepseek-v4-flash
```

**Step 2 — .env 变更：**

```bash
# 删除 MIMO_API_KEY=tp-...
# 添加（如果 .env 尚不存在此变量）：
# XIAOMI_TOKEN_PLAN_CN_API_KEY=tp-...   # 将原 MIMO_API_KEY 的值迁移到此处
```

**Step 3 — 代码删除：**

```bash
rm src/provider/mimo-provider.ts
```

清理 `src/app/bootstrap.ts`：
```diff
- import { registerMimoProvider, createMimoModel } from '../provider/mimo-provider.js';
// ...
- registerMimoProvider(config.mimo, logger);
- const mimoModel = config.mimo ? createMimoModel(config.mimo) : undefined;
- if (mimoModel) {
-   registerModel(mimoModel.provider, mimoModel.id, mimoModel);
- }
```

清理 `src/provider/index.ts`：
```diff
- export { registerMimoProvider, createMimoModel } from './mimo-provider.js';
- export type { MimoConfig } from './mimo-provider.js';
```

清理 `src/app/config.ts`（移除 `mimo` schema 块）。

**Step 4 — 验证：**

```bash
pnpm build && pnpm test:ai
# 启动服务，实测 MiMo 模型调用是否正常
```

### 本次升级不纳入 MiMo 迁移

升级仅更新 `models.generated.ts` 单文件。MiMo 迁移作为独立工作项留待实测通过后执行。

---

## 验收清单

- [ ] `pnpm build` — 编译通过
- [ ] `pnpm test:ai` — 全量测试无新增失败
- [ ] `cat src/pi-mono/VERSION` — 显示 v0.75.3
- [ ] `grep -rn "fallbackModels\|registerModel" src/pi-mono/` — 本地修改完整
- [ ] 确认 `src/provider/mimo-provider.ts` 保留不变（本次不迁移）
- [ ] 确认 `config.yaml` 中 `mimo:` 配置块保留不变（本次不迁移）
