# pi-mono v0.75.0 → v0.75.1 升级实施方案

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-18 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.75.0 (commit `8a36b12`) |
| 目标版本 | v0.75.1 |
| 上游变更源文件数 | 6 个 AI 层文件，0 个 Agent 层文件 |
| 升级难度 | **低** — 无 Agent 层变更，无新增文件，无本地修改冲突 |

## 上游变更清单

### Agent 层

**无源文件变更。**

### AI 层 — 修改文件

| 文件 | 变更行数 | 变更内容 | 冲突？ |
|------|---------|---------|:---:|
| `models.generated.ts` | 194 | 移除 OpenAI Codex fast 模型变体（4 个）、多模型 maxTokens 修正、**xiaomi provider 全部 5 个 MiMo 模型从 `anthropic-messages` 切换到 `openai-completions`**（mimo-v2-flash/omni/pro/v2.5/v2.5-pro） | 否 |
| `providers/amazon-bedrock.ts` | 39 | 消息转换跳过未知内容块（修复 stream 中断） | 否 |
| `providers/openai-completions.ts` | 11 | OpenCode Go Kimi reasoning 回放修复：`reasoning` → `reasoning_content` 标准化 | 否 |
| `providers/anthropic.ts` | 1 | `authToken: null` — 阻止 `ANTHROPIC_AUTH_TOKEN` 环境变量干扰 Xiaomi 等非 Anthropic provider 的 API key 认证 | 否 |
| `providers/azure-openai-responses.ts` | 18 | 错误前缀 HTTP 状态码，使 agent 自动重试能匹配 5xx/429 错误 | 否 |
| `providers/openai-responses.ts` | 18 | 同上（OpenAI Responses 错误格式化） | 否 |

### 其他变更（不嵌入）

| 范围 | 说明 |
|------|------|
| coding-agent | 包管理、配置选择器、子进程等修复 |
| tui / web-ui | 版本号更新 |
| 测试 | 新增 bedrock-convert-messages 测试 |

## 升级步骤

### Step 1: 直接覆盖（6 个文件）

从 v0.75.1 源码复制到 `src/pi-mono/`：

```
ai/models.generated.ts              — 194 行：MiMo API 切换 + 模型修正
ai/providers/amazon-bedrock.ts      — 39 行：未知内容块跳过
ai/providers/openai-completions.ts  — 11 行：reasoning 标准化
ai/providers/anthropic.ts           — 1 行：authToken 修复
ai/providers/azure-openai-responses.ts — 18 行：错误格式化
ai/providers/openai-responses.ts    — 18 行：错误格式化
```

### Step 2: 更新版本标记

```bash
echo "v0.75.1" > src/pi-mono/VERSION
```

`CLAUDE.md`：`v0.75.0` → `v0.75.1`。

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
git commit -m "feat: upgrade embedded pi-mono from v0.75.0 to v0.75.1"
```

---

## 专题：自定义 MiMo Provider 去留评估

### 背景

v0.75.1 的一项重要变更是将内置 `xiaomi` provider 的全部 5 个 MiMo 模型从 `anthropic-messages` 切换到 `openai-completions` API 协议。这缩小了内置 provider 与我们自定义 MiMo provider 之间的差距，需要重新评估自定义 provider 的必要性。

### 内置 xiaomi Provider 现状（v0.75.1）

v0.75.1 中有 4 个内置 xiaomi 相关 provider，使用了不同的域名和 API 协议：

| Provider | 域名 | API 协议 | API key 环境变量 |
|----------|------|---------|----------------|
| `xiaomi` | `api.xiaomimimo.com/v1` | **`openai-completions`** ✅ (v0.75.1 新切换) | `XIAOMI_API_KEY` |
| `xiaomi-token-plan-cn` | `token-plan-cn.xiaomimimo.com/anthropic` | **`anthropic-messages`** | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| `xiaomi-token-plan-ams` | `token-plan-ams.xiaomimimo.com/anthropic` | **`anthropic-messages`** | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| `xiaomi-token-plan-sgp` | `token-plan-sgp.xiaomimimo.com/anthropic` | **`anthropic-messages`** | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |

**v0.75.1 仅将 `xiaomi`（API 计费域名）切换到 `openai-completions`。** 3 个 Token Plan 变体仍使用 `anthropic-messages`。

### 自定义 MiMo Provider 现状

| 维度 | 值 |
|------|-----|
| 域名 | `token-plan-cn.xiaomimimo.com/v1` |
| API 协议 | `mimo-openai-completions`（自定义，兼容 OpenAI Completions） |
| API key 环境变量 | `MIMO_API_KEY` |
| 认证方式 | `api-key` header（非标准 `Authorization: Bearer`） |
| 特殊功能 | `prompt_cache_key` 会话亲和性、`thinking` 注入 |
| 代码量 | ~300 行（`src/provider/mimo-provider.ts`） |

### 差异矩阵

| 维度 | 内置 `xiaomi` | 内置 `xiaomi-token-plan-cn` | 自定义 `mimo` |
|------|:---:|:---:|:---:|
| API 协议 | ✅ `openai-completions` | ❌ `anthropic-messages` | ✅ `openai-completions` |
| 域名 | `api.xiaomimimo.com` | `token-plan-cn.xiaomimimo.com` | `token-plan-cn.xiaomimimo.com` |
| Auth header | `Authorization: Bearer` | `x-api-key` | `api-key` |
| 计费方式 | API 计费 | Token Plan | Token Plan |
| 代码量 | 0（内置） | 0（内置） | ~300 行（需维护） |

### 结论：保留自定义 MiMo Provider

**当前无法移除。** 原因：

1. **域名不同**：内置 `xiaomi-token-plan-cn` 仍使用 `anthropic-messages` 协议。虽然 `token-plan-cn` 域名有 `/v1` 端点（OpenAI Completions 兼容），但内置模型元数据指向 `/anthropic` 端点。内置 `xiaomi`（api.xiaomimimo.com/v1）已切换到 `openai-completions`，但这是 API 计费域名，不是 Token Plan。

2. **项目使用 Token Plan 计费**：`.env` 中 `MIMO_API_KEY` 是 Token Plan 密钥（`tp-...`），对应 `token-plan-cn.xiaomimimo.com` 域名。切换到 `api.xiaomimimo.com` 意味着更换计费方式。

3. **认证方式不同**：自定义 provider 使用 `api-key` header，内置 `openai-completions` 使用 `Authorization: Bearer`。如果 `token-plan-cn` 端点同时接受两种 header，理论上可以无需自定义 provider——但这需要实测验证。

### 迁移路径（后续版本）

待上游将 `xiaomi-token-plan-cn` 也切换到 `openai-completions`（或实测确认 token-plan 端点支持 Bearer auth），可按以下步骤移除自定义 MiMo：

```bash
# 1. 配置变更 — config.yaml
# 将 fallback_models 中的 mimo/mimo-v2.5 改为 xiaomi/mimo-v2.5（使用 API 计费域名）
# 删除 mimo: 配置块

# 2. 环境变量 — .env
# MIMO_API_KEY → 可删除（或保留给内置 provider 回退使用）

# 3. 代码删除
# rm src/provider/mimo-provider.ts
# 清理 src/app/bootstrap.ts 中的 registerMimoProvider() / createMimoModel() 调用
# 清理 src/provider/index.ts 中的导出
# 清理 config.ts / config.yaml 中的 mimo 配置 schema

# 4. 验证
# pnpm build && pnpm test:ai
```

### 本次升级不纳入 MiMo 迁移

本次升级仅更新 pi-mono 内核文件，不修改项目配置或 MiMo 相关代码。MiMo 迁移作为独立工作项留待后续版本处理。

---

## 验收清单

- [ ] `pnpm build` — 编译通过
- [ ] `pnpm test:ai` — 全量测试无新增失败
- [ ] `grep -rn "fallbackModels\|registerModel" src/pi-mono/` — 本地修改完整
- [ ] `grep -rn "@mariozechner" src/ tests/ --include="*.ts"` — 无旧包名残留
- [ ] `cat src/pi-mono/VERSION` — 显示 v0.75.1
- [ ] 确认 `config.yaml` 中 `mimo:` 配置块保留不变
- [ ] 确认 `src/provider/mimo-provider.ts` 保留不变
