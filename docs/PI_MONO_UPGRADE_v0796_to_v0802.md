# pi-mono v0.79.6 → v0.80.2 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-06-26 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.79.6 |
| 目标版本 | v0.80.2 |
| 升级难度 | **高** — AI 层架构重构：`providers/` → `api/` 目录重命名、新增 `auth/` 和 `providers/` 工厂系统、`models.ts` 完全重写、新增 `compat.ts` 兼容层 |

## 上游变更清单（7 个版本累积）

### 架构重构（v0.80.0 核心变更）

| 变更 | 说明 |
|------|------|
| `providers/` → `api/` | API 实现文件从 `providers/` 迁移到 `api/` |
| 新 `providers/` 目录 | Provider factory + model catalog 系统（与原 providers 语义不同） |
| 新 `auth/` 子系统 | 凭证管理（5 个文件） |
| 新 `compat.ts` | 向后兼容入口点，保留旧全局 API（`stream`、`getModel`、`registerApiProvider` 等） |
| `models.ts` 完全重写 | 函数式 API → Provider/Models 类系统 |
| `legacy-api-aliases.ts` | 临时遗留 API 别名 |
| `images-models.ts` | 新增图像模型系统 |
| 移除 `@earendil-works/pi-ai/base` | 入口点变更 |
| Agent `index.ts` | 新增 harness 导出（我们不使用） |

### 功能改进

| 功能 | 版本 |
|------|------|
| Post-compaction token estimates | v0.79.8 |
| Mistral prompt caching | v0.79.8 |
| Chat-template thinking (vLLM/DeepSeek) | v0.79.9 |
| Extension compaction events (reason/willRetry) | v0.79.10 |
| ApiKeyCredential discriminator 改进 | v0.80.2 |
| Anthropic 兼容自定义模型改进 | v0.80.2 |
| `Ctrl+J` 默认换行键 | v0.80.0 |
| Warp 终端图片支持 | v0.79.7 |

### 修复

- 修复 Anthropic-compatible 自定义模型的 session-affinity header 和 tool-field 遗漏
- 修复 request-scoped apiKey/env 在 provider auth 解析中的参与
- 修复 OpenAI Responses 流的截断问题
- 修复 Amazon Bedrock scoped AWS_PROFILE endpoint 解析
- 修复 Fireworks Anthropic-compatible 请求
- 多种 provider/模型元数据修正

## Agent 层（无变更）

Agent 文件在 v0.79.6 和 v0.80.2 之间完全一致（仅 import 路径从 `@earendil-works/pi-ai` 改为 `@earendil-works/pi-ai/compat`），本地修改直接保留：
- `agent.ts` — 无变更（557 行）
- `agent-loop.ts` — 无变更（748 行）
- `proxy.ts` — 无变更（367 行）
- `types.ts` — 仅 +5 行（`StreamFunction` 类型重写、`agent_start` 事件）
- `index.ts` — 仅 4 个核心导出，去掉 harness 导出

## 本地修改处理

### 已内置上游（无需重新应用）
- **M7**: `ProviderEnv` 类型 — 上游已内置
- **M9**: `cacheWrite1h` 提取 — 上游已内置
- **M10**: OAuth 优雅失败 — 上游已内置
- **M11**: `provider-env.ts` — 上游已内置
- **M12**: ProviderEnv 参数注入 — 上游已内置

### 保留应用
- **M1**: `agent/agent.ts` — fallbackModels、ohmyagent_agentName
- **M2**: `agent/agent-loop.ts` — fallback 模型循环、延迟工具、acceptingUpdates 守卫
- **M3**: `agent/types.ts` — fallbackModels、deferred 标记
- **M4**: `agent/index.ts` — 仅 4 个核心导出
- **M5**: 迁移到 `compat.ts` — registerModel、isSameModel、calculateCost、动态模型解析
- **M6**: `api-registry.ts` — 删除（上游 compat.ts 已包含）
- **M8**: `env-api-keys.ts` — ProviderEnv 重构版本保留

### 删除的本地文件
- `ai/stream.ts` — 功能已被 `compat.ts` 取代
- `ai/api-registry.ts` — 功能已被 `compat.ts` 取代

## 升级步骤

### 1. 获取上游 v0.80.2 源码
- 从 GitHub 下载 Agent 层（5 个文件）和 AI 层（约 100 个文件）

### 2. Agent 层升级
- `types.ts`：覆盖为上游版本 + 添加 `fallbackModels` 和 `deferred`
- `index.ts`：覆盖为上游版本 + 删除 harness 导出
- `agent.ts`、`agent-loop.ts`、`proxy.ts`：保持不变（无上游变更）

### 3. AI 层重构
- 部署新目录：`api/`、`auth/`、新 `providers/`
- 删除旧目录：`providers/`（API 实现）、`utils/`（替换为上游）
- 覆盖核心文件：`models.ts`、`types.ts`、`index.ts` 等
- 保留本地修改文件：`env-api-keys.ts`、`image-models.ts`、`images-api-registry.ts`、`images.ts`
- 删除冗余文件：`api-registry.ts`、`stream.ts`
- 全局 `.ts` → `.js` 扩展名修正

### 4. 适配
- 更新 `tsconfig.json`：`@earendil-works/pi-ai` → `compat.ts`
- 更新 `vitest.config.ts`：别名指向 `compat.ts`
- 添加 `registerModel`/`isSameModel`/`calculateCost` 等自定义函数到 `compat.ts`
- 更新 `config-routes.ts`：import 从 `models.js` 改为 `@earendil-works/pi-ai`
- 更新测试 mock：`config-routes.test.ts`
- 修复 Mistral SDK 类型问题（`promptCacheKey`）

### 5. 验证
- `pnpm build` — 编译通过
- `pnpm test:ai` — 157 文件、2259 测试全部通过

## 回滚方法

```bash
git checkout -- src/pi-mono/ tsconfig.json vitest.config.ts \
  src/app/webui/config-routes.ts tests/app/config-routes.test.ts
pnpm build
```
