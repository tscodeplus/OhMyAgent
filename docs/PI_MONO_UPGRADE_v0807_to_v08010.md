# pi-mono v0.80.7 → v0.80.10 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-07-17 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.80.7 |
| 目标版本 | v0.80.10 |
| 升级难度 | **中高** — 跨越 3 个版本，包含 ModelRuntime 重构、OAuth 目录重组、prepareNextTurn 签名变更 |

## 上游变更概要

### v0.80.8 — ModelRuntime 重构 (Breaking Changes)
- **ModelRegistry → ModelRuntime**：`registerModel`、`AuthStorage` 不再导出，改用 `createModels()` + `createProvider()` + `models.setProvider()`
- **OAuth 目录重组**：`ai/utils/oauth/` → `ai/auth/oauth/`，OAuth 类型合并入 `auth/types.ts`
- **prepareNextTurn 拆分**：新增 `prepareNextTurnWithContext(context, signal)`，旧版 `prepareNextTurn(signal)` 仅接收 AbortSignal
- `beforeToolCall` / `afterToolCall` 新增第二个参数 `signal?: AbortSignal`

### v0.80.9 — Kimi K3 + xAI 模型更新
- 新增 Kimi K3 支持、deferred tool loading
- xAI 模型目录更新（移除 Grok 3 等旧模型）
- 新增 provider：kimi-coding、moonshotai、opencode、xiaomi、zai 等

### v0.80.10 — Kimi Coding 兼容性修复
- Kimi Coding thinking 兼容性改进
- 价格元数据修复

## 本地修改处理

与 v0.80.7 一致，保留 8 处本地修改：

| 编号 | 文件 | 修改内容 |
|------|------|----------|
| M1 | `agent/index.ts` | 剥离 harness 导出 |
| M2 | `agent/types.ts` | `fallbackModels`、`deferred` 工具标记 |
| M3 | `agent/agent.ts` | `fallbackModels`、`ohmyagent_agentName`、统一 `prepareNextTurn` |
| M4 | `agent/agent-loop.ts` | `compactToolsForPrompt` 过滤 deferred 工具 |
| M5 | `ai/compat.ts` | 自定义 `registerModel` 兼容层、合并 builtin+custom 的 `getModel`/`getModels`/`getProviders` |
| M6 | `ai/types.ts` | 无需修改（v0.80.10 已保留 `ModelCost` + `tiers?`） |
| M7 | `ai/models.ts` | 上游大幅重构（424 行 diff），`createModels()` + `createProvider()` 替代旧 API，接口兼容无需手动适配 |
| M8 | `ai/api/mistral-conversations.ts` | `promptCacheKey` 类型断言 |

### v0.80.10 新增的修改

#### 兼容层文件

- **新增** `ai/utils/oauth/index.ts` — OAuth registry 兼容层，包装新 `OAuthAuth` 为旧 `OAuthProviderInterface`
- **新增** `ai/utils/oauth/types.ts` — 旧 OAuth 类型定义（`OAuthLoginCallbacks`、`OAuthProviderInterface` 等）

#### 导入路径更新

- `tsconfig.json`：新增 `@earendil-works/pi-ai/compat` → `src/pi-mono/ai/compat.ts` 路径映射
- `vitest.config.ts`：同步新增 alias（使用数组格式确保正确解析）
- `.ts` → `.js` 导入修复：所有 pi-mono 源文件的 import 扩展名替换（包括静态 import、动态 import、副作用 import）

#### Breaking Changes 适配

1. **`registerModel` 移除** → `ai/compat.ts` 新增兼容函数：维护自定义模型注册表，`getModel`/`getModels`/`getProviders` 合并 builtin + custom
2. **`prepareNextTurn` 签名变更** → `agent-factory.ts` 改用 `prepareNextTurnWithContext(ctx, signal)`
3. **`beforeToolCall`/`afterToolCall` 新签名** → 无需修改调用方（extra 参数可选）
4. **`openai-codex-responses.ts`** → `BodyInit` 类型断言修复
5. **`agent-loop.ts` 类型收窄** → `ToolCall[]` cast 修复 filter 回调

## 对项目的影响分析

### 破坏性风险：低

- `registerModel` 通过兼容层保持可用，现有配置无需修改
- OAuth 通过兼容层保持旧 API 表面
- 所有 2302 个测试通过

### 收益

1. **新 provider 支持**：Kimi K3、xAI Grok 4.5、Moonshot AI、OpenCode、小米 Token Plan、Z.ai 等 10+ 新 provider
2. **动态工具加载**：cache-friendly 的动态工具扩展（Anthropic/OpenAI Responses 保持 prompt cache 前缀）
3. **Thinking 级别扩展**：Fable 5 的 `xhigh`/`max` thinking 级别
4. **pi-messages API**：新的专用消息协议 API（v0.80.7 已引入，后续版本完善）
5. **模型目录刷新**：`/model` 实时刷新 provider 目录
6. **Bug 修复**：Kimi Coding thinking 兼容性、模型价格元数据修复

## 验证

- `pnpm build` — 编译通过
- `pnpm test:ai` — 158 文件、2302 测试全部通过
