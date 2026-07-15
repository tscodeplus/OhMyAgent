# pi-mono v0.80.6 → v0.80.7 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-07-15 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.80.6 |
| 目标版本 | v0.80.7 |
| 升级难度 | **低** — 小版本升级，新增 1 个 API 模块（pi-messages），少量文件变更 |

## 上游变更清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `ai/api/pi-messages.ts` (436 行) | pi-messages API 流实现 — 专有消息协议 API |
| `ai/api/pi-messages.lazy.ts` | pi-messages API 懒加载包装器 |
| `ai/utils/deferred-tools.ts` | 延迟工具支持 — 将工具从 prompt 中排除但仍可通过工具搜索解析 |
| `ai/utils/oauth/radius.ts` (557 行) | RADIUS OAuth 认证流程 |

### 修改的文件

| 文件 | 变更 |
|------|------|
| `ai/compat.ts` | 新增 `piMessagesApi` 注册到 BUILTIN_APIS；新增 `BuiltinProvider` 类型导出；新增 `export * from "./api/pi-messages.lazy.js"` |
| `ai/types.ts` | `OpenAICompletionsCompat` 新增 `sendSessionAffinityHeaders`、`supportsLongCacheRetention` 选项；`provider` 字段调整 |
| `ai/api/anthropic-messages.ts` | Adaptive thinking 改进、temperature 处理改进 |
| Multiple model files | 少量模型元数据更新（OpenRouter、Vercel AI Gateway、各 provider） |
| Agent harness files | 与 v0.80.6 无实质差异 |

## 本地修改处理

所有 8 处本地修改与 v0.80.6 完全一致，无需额外适配：

| M1 | `agent/index.ts` | 剥离 harness 导出 |
| M2 | `agent/types.ts` | `fallbackModels`、`deferred` 工具标记 |
| M3 | `agent/agent.ts` | `fallbackModels`、`ohmyagent_agentName`、统一 `prepareNextTurn` |
| M4 | `agent/agent-loop.ts` | 回退模型循环、`compactToolsForPrompt`、缓存统计 |
| M5 | `ai/compat.ts` | 自定义 `getModel`、`registerModel`、`isSameModel` |
| M6 | `ai/types.ts` | 无需修改（v0.80.7 已保留 `ModelCost` + `tiers?`） |
| M7 | `ai/models.ts` | 简化 `calculateCost` |
| M8 | `ai/api/mistral-conversations.ts` | `promptCacheKey` 类型断言 |

### 仍需删除的 Harness 文件

与 v0.80.6 处理方式完全相同：

```bash
rm -rf src/pi-mono/agent/harness
rm -f src/pi-mono/agent/node.ts
```

**原因不变**：harness `messages.ts` 通过 `declare module` 向 `CustomAgentMessages` 注册 `BashExecutionMessage`（无 `content` 字段），会导致 `src/agent/compress.ts` 等访问 `message.content` 的代码出现 TypeScript 类型错误。OhMyAgent 未使用 `CustomAgentMessages` 扩展机制，因此直接移除最安全。

> **注意**：本次升级未对 v0.80.6 和 v0.80.7 的 harness 做差异对比。harness 的删除是整体策略决定，与版本间变化无关。如果未来需要引入 harness 的部分组件，应当从当前最新版源码独立评估。

### 破坏性变更适配

v0.80.7 有一个 Breaking Change：`sendSessionIdHeader` → `sessionAffinityFormat`。需要同步修改项目文件：

- `src/app/bootstrap.ts`：`sendSessionIdHeader: true` → `sessionAffinityFormat: 'openai'`
- `src/app/config-loader.ts`：`send_session_id_header` 映射 → `session_affinity_format`

## 值得关注的 upstream 新增功能

### pi-messages API

新的 AI 流协议 `ai/api/pi-messages.ts`，通过 `compat.ts` 注册为内置 API。如果后续需要在自定义 provider 中使用，在 `compat.ts` 中已自动可用。

### deferred-tools

`ai/utils/deferred-tools.ts` 提供了上游版本的延迟工具实现。OhMyAgent 已有自己的 `deferred` 标记 + `compactToolsForPrompt` 实现（M2/M4），功能重叠。当前选择保留 OhMyAgent 自己的实现，因为与 Tool Search 扩展和 skill-level 解析深度集成。

## 验证

- `pnpm build` — 编译通过
- `pnpm test:ai` — 158 文件、2302 测试全部通过
