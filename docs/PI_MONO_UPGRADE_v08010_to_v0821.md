# pi-mono v0.80.10 → v0.82.1 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-07-29 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.80.10 |
| 目标版本 | v0.82.1 |
| 升级难度 | **中高** — 跨越 4 个版本，包含 Agent streamFn 重构、harness 模块化、新 OAuth provider 等 |

## 上游变更概要

### v0.81.0
- **llama.cpp 模型管理**: 连接 llama.cpp 路由、搜索/下载 HF 模型
- **完整 provider 扩展**: 可注册完整 pi-ai provider（auth + model refresh + filtering + custom streaming）
- **Qwen Token Plan providers**: 内置国内/国际订阅 provider

### v0.81.1
- **可验证的发布源码归档**: 确定性校验和的源码归档
- **弹性 compaction**: 瞬态 provider 错误遵循重试策略

### v0.82.0
- **Constrained tool sampling**: 工具可偏好/要求严格 JSON Schema 采样或 OpenAI Lark/regex grammars
- **OpenRouter/Kimi Code OAuth**: `/login` 授权 OpenRouter 或 Kimi Code 订阅
- **Session-aware streaming bash**: Bash 工具接收 session/model 元数据

### v0.82.1
- **Claude Opus 5**: Anthropic + Bedrock 支持，adaptive thinking（含 xhigh）
- **Anthropic gateway bearer auth**: `ANTHROPIC_AUTH_TOKEN` Bearer 认证
- **更快、更弹性的模型目录**: If-None-Match 304 缓存、llama.cpp 持久化
- **outputPad 设置**: 暴露给自定义消息渲染器
- **Radius OAuth 变更**: 设备授权直接使用配置的网关
- **错误消息改进**: 模型加载错误附带底层原因

## 新增上游文件

### agent 包
- `agent/node.ts` — Node.js 环境入口（harness + agent）
- `agent/stream-fn.ts` — 默认 streamFn 管理（`setDefaultStreamFn` / `getDefaultStreamFn`）
- `agent/harness/` — 完整的交互式 harness（tools/bash/edit/read/write + compaction + session + skills）→ **已删除**

### ai 包
- `ai/api/constrained-sampling.ts` — 约束采样配置
- `ai/auth/oauth/kimi-coding.ts` — Kimi Coding OAuth provider
- `ai/auth/oauth/openrouter.ts` — OpenRouter OAuth provider
- `ai/model-catalog.ts` — 模型目录管理
- `ai/providers/qwen-token-plan*.ts` — Qwen Token Plan providers（国内/国际）
- `ai/providers/data/` — 预构建 provider 数据 JSON
- `ai/utils/provider-retry.ts` — provider 级重试
- `ai/utils/text.ts` — contentText 工具
- `ai/utils/uuid.ts` — uuidv7 实现

## 本地修改处理

### 保留的本地修改

| 编号 | 文件 | 修改内容 |
|------|------|----------|
| M1 | `agent/index.ts` | 剥离 harness 导出，只保留 agent/agent-loop/proxy/types/stream-fn |
| M2 | `agent/types.ts` | `fallbackModels`、`deferred` 工具标记 |
| M3 | `agent/agent.ts` | `fallbackModels`、`ohmyagent_agentName`、`streamFn` getter/setter 向后兼容 |
| M4 | `agent/agent-loop.ts` | `compactToolsForPrompt` 过滤 deferred 工具、fallback model 循环 |
| M5 | `ai/compat.ts` | 自定义 `registerModel` 兼容层、合并 builtin+custom 的 `getModel`/`getModels`/`getProviders` |
| M6 | `ai/types.ts` | 无需修改（v0.82.1 已保留 `ModelCost` + `tiers?`） |
| M7 | `ai/models.ts` | v0.82.1 已重构，兼容层在 compat.ts 处理 |
| M8 | `ai/api/mistral-conversations.ts` | `promptCacheKey` 类型断言 `as any` |
| M9 | `ai/utils/oauth/index.ts` | OAuth 注册表兼容层（包装新 `OAuthAuth` 为旧 `OAuthProviderInterface`） |
| M10 | `ai/utils/oauth/types.ts` | 旧 OAuth 类型定义 |

### v0.82.1 新增适配

1. **`streamFn` → `streamFunction` 重命名**: Agent 类属性更名，但保留 `streamFn` getter/setter 向后兼容
2. **`streamFn` 变为必需参数**: AgentOptions.streamFn 现在是必需的，agent-factory.ts 必须显式传入 `streamSimple`
3. **`node.ts` 修复**: 删除 harness 引用，仅 re-export index
4. **agent/harness/ 目录删除**: OhMyAgent 有自己的 harness 系统，不需要 pi-mono 内置的 harness（会引入 `ignore`/`diff` 等不需要的依赖）
5. **动态 import `.ts` 修复**: 修复所有 `import("./...").ts"` 为 `import("./...").js"`
6. **`BodyInit` 类型断言**: openai-codex-responses.ts 中添加
7. **`deferred` 属性**: AgentTool 接口添加 `deferred?: boolean`

### 向后兼容

- `agent.streamFn` getter/setter 保持旧代码（如 E2E 测试）无需修改
- `registerModel` / `resolveModel` / `resolveModels` / `resolveProviders` 保持可用
- OAuth 兼容层不变

## 对项目的影响分析

### 破坏性风险：低

- `streamFn` → `streamFunction` 通过 getter/setter 完全向后兼容
- `registerModel` 通过 compat.ts 保持可用
- OAuth 通过兼容层保持旧 API 表面
- 所有 2473 个测试通过

### 收益

1. **Claude Opus 5 支持**: Anthropic + Bedrock，adaptive thinking
2. **新 provider**: Qwen Token Plan（国内/国际）、OpenRouter OAuth、Kimi Coding OAuth
3. **约束采样**: JSON Schema / grammar 约束工具采样
4. **模型目录优化**: If-None-Match 304、llama.cpp 持久化
5. **更好的错误消息**: 模型加载错误附带底层原因（有助于调试之前的 OAuth refresh 问题）
6. **Bug 修复**: compaction/branch summary 的 header-only auth、Radius OAuth 改进

## 验证

- `pnpm build` — 编译通过
- `pnpm test:ai` — 163 文件、2473 测试全部通过
