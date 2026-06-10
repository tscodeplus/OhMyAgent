# pi-mono v0.72.1 → v0.73.0 升级记录

## 升级概览

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-05 |
| 上游仓库 | [pi-mono](https://github.com/badlogic/pi-mono) |
| 源版本 | v0.72.1 (commit `036bde0`) |
| 目标版本 | v0.73.0 (commit `dbcb473`) |
| 嵌入目录 | `src/pi-mono/` |
| 测试结果 | 58 test files, 903 tests — 全部通过 |

## v0.73.0 上游变更清单

### Agent 层 (packages/agent/src/)

**无变更。**

### AI 层 (packages/ai/src/)

#### 修改文件

| 文件 | 变更内容 |
|------|---------|
| `types.ts` | 新增 `xiaomi-token-plan-cn/ams/sgp` 三个 provider 类型；`AssistantMessage` 增加 `diagnostics` 字段 |
| `env-api-keys.ts` | 新增 `XIAOMI_TOKEN_PLAN_{CN,AMS,SGP}_API_KEY` 环境变量映射 |
| `index.ts` | 移除旧的 Codex WebSocket debug 导出（改为内部模块）；新增 `session-resources` 和 `utils/diagnostics` 导出 |
| `models.generated.ts` | Xiaomi 内置 provider 从 Token Plan AMS 切换到 API 计费（base URL 变更为 `api.xiaomimimo.com`）；新增 3 个区域 Token Plan provider（`xiaomi-token-plan-{cn,ams,sgp}`），每个包含 6 个模型；opencode 模型 api 类型修正（anthropic-messages → openai-completions） |
| `providers/openai-codex-responses.ts` | 大幅重构：WebSocket 连接失败时自动 fallback 到 SSE；错误分类（`CodexApiError`/`CodexProtocolError`/`WebSocketCloseError`）；session 资源清理注册；失败诊断信息（`diagnostics`）追加到 assistant message；WebSocket SSE fallback 按 session 记录 |
| `providers/amazon-bedrock.ts` | 修复 Bedrock Claude Opus 4.7 的 `xhigh` thinking 请求 |

#### 新增文件

| 文件 | 说明 |
|------|------|
| `session-resources.ts` | Session 资源清理注册表，支持 `registerSessionResourceCleanup()` 和 `cleanupSessionResources()` |
| `utils/diagnostics.ts` | Provider 诊断信息工具：`AssistantMessageDiagnostic` 类型、错误提取、诊断追加 |

## 升级步骤

### 1. 文件分类

#### 直接覆盖（本地无修改）

所有 6 个变更文件均无本地修改，从 v0.73.0 直接复制：

```
ai/types.ts
ai/env-api-keys.ts
ai/index.ts
ai/models.generated.ts
ai/providers/openai-codex-responses.ts
ai/providers/amazon-bedrock.ts
```

#### 新增文件

从 v0.73.0 复制到嵌入目录：

```
ai/session-resources.ts
ai/utils/diagnostics.ts
```

#### 保持不变（仅本地有修改，上游无变更）

```
agent/agent.ts       — fallbackModels 属性
agent/agent-loop.ts  — fallback 重试循环 + delta 事件 + 错误日志
agent/types.ts       — fallbackModels in AgentLoopConfig
ai/models.ts         — registerModel()
ai/api-registry.ts   — 项目自定义 API 注册
ai/bedrock-provider.ts — Bedrock 模块声明
ai/cli.ts            — CLI 入口
ai/stream.ts         — stream() 函数
ai/oauth.ts          — OAuth 支持
```

#### 本地修改保留清单

| 文件 | 功能 | 用途 |
|------|------|------|
| `agent/agent.ts` | `fallbackModels` 属性 | 主模型失败时自动切换到备用模型 |
| `agent/types.ts` | `fallbackModels` in `AgentLoopConfig` | 传递 fallback 配置到 agent loop |
| `agent/agent-loop.ts` | 移除 `isLastModel` 条件 + 错误日志 | 所有 fallback 模型的 delta 事件都发送给客户端 |
| `ai/models.ts` | `registerModel()` | 运行时注册自定义模型 |
| `src/provider/mimo-provider.ts` | 整个文件 | 自定义 MiMo provider（OpenAI Completions 协议） |

### 2. 编译验证

```bash
pnpm build   # tsc 编译通过
```

### 3. 运行测试

```bash
pnpm test:ai   # 58 files, 903 tests — 全部通过
```

## 自定义 MiMo Provider 评估

### 背景

v0.73.0 新增了内置的 `xiaomi-token-plan-cn` provider，base URL 为 `https://token-plan-cn.xiaomimimo.com/anthropic`，使用 Anthropic Messages API 协议。

### 与自定义 MiMo provider 的差异

| 维度 | 内置 `xiaomi-token-plan-cn` | 自定义 MiMo |
|------|--------------------------|------------|
| API 协议 | **Anthropic Messages** | **OpenAI Completions** |
| Base URL | `token-plan-cn.xiaomimimo.com/anthropic` | `token-plan-cn.xiaomimimo.com/v1` |
| 认证 header | `x-api-key`（通过 anthropic provider） | `api-key`（自定义） |
| 环境变量 | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `MIMO_API_KEY` |
| 默认模型 | `mimo-v2.5-pro` | `mimo-v2.5` |
| 模型注册方式 | `getModel('xiaomi-token-plan-cn', '...')` | `registerModel()` + `registerApiProvider()` |
| 代码量 | 0（内置） | ~300 行 |
| 上游维护 | 自动跟随 pi-mono 更新 | 需手动维护 |

### 结论：暂时保留自定义 MiMo provider

**原因：API 协议不同。** 内置 `xiaomi-token-plan-cn` 使用 Anthropic Messages API，而项目当前使用 OpenAI Completions API。切换协议意味着：

1. 消息格式转换路径改变（tool call、thinking 格式不同）
2. 可能影响 reasoning 行为
3. 工具调用参数序列化方式不同
4. 需要全链路回归测试（Feishu → Agent → MiMo → 回复）

**迁移建议（后续版本）：**
1. 在 staging 环境使用 `xiaomi-token-plan-cn` 进行对比测试
2. 验证 reasoning、工具调用、多模态等核心路径
3. 确认无误后，将 `MIMO_API_KEY` 迁移为 `XIAOMI_TOKEN_PLAN_CN_API_KEY`
4. 移除 `src/provider/mimo-provider.ts` 及相关代码

## 关键注意事项

### 1. Xiaomi 内置 provider 破坏性变更

v0.73.0 中内置 `xiaomi` provider 的 base URL 从 `token-plan-ams.xiaomimimo.com` 改为 `api.xiaomimimo.com`（API 计费）。**此变更不影响项目的自定义 MiMo provider**，因为自定义 provider 使用独立的 `mimo-openai-completions` API 协议，不走 pi-mono 内置的 anthropic-messages 路径。

### 2. Codex WebSocket 变更

`openai-codex-responses.ts` 在 v0.73.0 中进行了大幅重构。由于项目未使用 Codex WebSocket transport，这些变更对项目无影响。

### 3. 后续升级检查清单

```bash
# 确认所有本地修改仍存在
grep -rn "fallbackModels\|registerModel" src/pi-mono/

# 确认编译通过
pnpm build

# 确认测试全部通过
pnpm test:ai
```
