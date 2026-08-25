# pi-mono v0.84.1 → v0.84.3 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-08-25 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.84.1（2026-08-08 嵌入） |
| 目标版本 | v0.84.3 |
| 升级难度 | **低** — 跨 patch 版本：agent 核心无破坏性变更、本地补丁无冲突、仅 3 处 tsc 断言 |

## 上游变更概要

### v0.84.2 / v0.84.3

- **Breaking（不影响本项目）**：`GoogleThinkingLevel` → `GoogleApiThinkingLevel`，新增 `ResolvedGoogleThinkingLevel`（google-shared.ts）。本项目 `src/`（非 pi-mono）零引用，无需适配。
- **agent 包**：`session/search` 从 `harness/session/search.ts` 重构为独立 `src/search/`（`index.ts` + `scanning.ts`，类型仍依赖 harness）；`proxy.ts` 的 `toolcall_end` 事件新增 `toolCall` 字段；telemetry 类型改为从 `@earendil-works/pi-telemetry` 直接导出。
- **ai 包**：适配器批量修复（Anthropic/OpenAI-compatible/Bedrock/Google/Kimi/Copilot/Z.AI/DeepSeek/llama.cpp 等——reasoning replay、fallback 计费、usage 统计、toolChoice）；新增 `openai-responses` 的 `additional_tools` deferred-tools 模式（依赖 openai 6.40.0 类型）、`thinking.budget` 变量与 `thinkingTokenBudgetField`（vLLM/Qwen/SGLang/llama.cpp）；新增 `session-resources.ts` 资源清理注册表、`utils/sleep.ts`、`utils/pi-user-agent.ts`、`cloudflare-gateway-binding.ts`。
- **telemetry 包**：src 与 v0.84.1 一致（仅 CHANGELOG/package.json 版本号变化）。

## 依赖升级（对齐上游 v0.84.3）

| 包 | 旧版 | 新版 | 原因 |
|---|---|---|---|
| openai | 6.26.0 | 6.40.0 | `ResponsesInputItem` 新增 `additional_tools` 类型（编译错误驱动），上游 v0.84.3 即 6.40.0 |

其余依赖（mistralai 2.2.6、@opentelemetry/api 1.9.0、typebox 1.3.7 等）与 v0.84.3 对齐，无变化。项目 `@types/node` 保持 ^22（上游 ai 包 devDep 24→22 反向调低，无影响）。

## 升级步骤

### 1. 本地补丁盘点（归一化 .ts→.js 后 diff）

| 文件 | 补丁内容 | v0.84.3 处理方式 |
|---|---|---|
| agent/agent.ts | fallbackModels + streamFn 别名 + ohmyagent_agentName | 上游未变，直接恢复本地版 |
| agent/agent-loop.ts | fallback 多模型重试循环 + compactToolsForPrompt + terminate | 上游未变，直接恢复本地版 |
| agent/types.ts | fallbackModels + deferred | 上游未变，直接恢复本地版 |
| agent/index.ts | 删除 harness/search 导出 | 上游有变，按本地策略重写 |
| agent/node.ts | 删除 NodeExecutionEnv 导出 | 上游未变，直接恢复本地版 |
| ai/compat.ts | registerModel 自定义注册表 | 上游未变，直接恢复本地版 |
| ai/api/bedrock-converse-stream.ts | tsc middleware 断言 | 上游已改 tsc 友好写法，仅需 `add(middleware as any, ...)` ×2 |
| ai/api/openai-codex-responses.ts | tsc BodyInit 断言 | 同前，`body: sseBody as BodyInit` |
| ai/providers/xai.ts | （上游 v0.84.3 回归）`Provider<"openai-responses">` 声明过窄 | 恢复为 `Provider<"openai-completions" | "openai-responses">` |
| ai/utils/oauth/* | 本地独有 OAuth 兼容层 | 保留（不在上游） |
| ai/providers/data/* | 生成产物（39 个 JSON） | 从 npm pack v0.84.3 提取覆盖 |

### 2. 复制与转换

```bash
cp -r <upstream>/packages/agent/src/* src/pi-mono/agent/   # 然后 rm -rf harness search
cp -r <upstream>/packages/ai/src/*    src/pi-mono/ai/      # 保留本地 utils/oauth、providers/data
cp -r <upstream>/packages/telemetry/src/* src/pi-mono/telemetry/  # 然后 rm -rf testing
# 四形式 sed（静态/副作用/动态/包装路径 .ts→.js）
find src/pi-mono -name "*.ts" -exec sed -i \
  -e 's/from "\([^"]*\)\.ts"/from "\1.js"/g' \
  -e 's/^import "\([^"]*\)\.ts"/import "\1.js"/g' \
  -e 's/import("\([^"]*\)\.ts")/import("\1.js")/g' \
  -e 's/("\([^"]*\)\.ts")/("\1.js")/g' {} +
```

### 3. 决策：不嵌入 search/（v0.84.3 新增）

上游 v0.84.3 将 session search 重构到 `src/search/`，但其类型仍依赖 `harness/session/types.ts`（`Entry`、`SessionStorage`）。本项目不嵌入 harness，故一并放弃 `search/` 与 `export * from "./search/index.js"`，agent 产物恢复到 v0.84.1 时的精简面。

### 4. 编译修复（少量）

- bedrock-converse-stream.ts: `middlewareStack.add(middleware as any, ...)` ×2（SDK 泛型与 .add 重载不匹配，tsc 严格，tsgo 宽松）
- openai-codex-responses.ts: `sseBody as BodyInit`（`Uint8Array<ArrayBufferLike>` 泛型化问题，同 v0.84.1）
- xai.ts: 函数返回类型恢复宽声明（上游 v0.84.3 收窄声明但实现为宽，tsc 报错）

## 验证

- `pnpm build` — 0 错误
- `pnpm test:ai` — **187 文件 / 2893 测试通过**（3 跳过，环境相关）
- 实测：DevServer + WebUI 后台 Agent 聊天/工具调用

## 后续注意事项

- `search/`（session 搜索）与 `session-resources.ts` 未接入本项目；接入会话服务时再评估
- 下次升级前置依赖：openai >= 6.40.0（additional_tools 类型）
- 上游 harness 仍在演进（v0.84.3 新增 events.ts、search.test.ts 等），维持不嵌入策略
