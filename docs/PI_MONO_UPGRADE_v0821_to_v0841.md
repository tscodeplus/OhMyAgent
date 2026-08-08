# pi-mono v0.82.1 → v0.84.1 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-08-08 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.82.1（commit ab9e5e0，2026-07-29 嵌入） |
| 目标版本 | v0.84.1 |
| 升级难度 | **中** — 跨 2 个 minor，含 TypeBox 1.3.7 破坏性变更、新 telemetry 包、新 provider 数据 |

## 上游变更概要

### v0.83.0（破坏性）
- **TypeBox 1.3.7**：移除 `Type.Base`、`Type.Promise`、`Value.Mutate` 等废弃 API（本项目未用到，已验证）
- 停止原因透传：Google/Anthropic/Bedrock/Mistral/OpenAI 流式响应继承原始 provider 停止原因；新增 `"pending"` 停止原因
- 暴露 `ctx.scopedModels`；按请求继承 fetch 注入
- OAuth 凭据在令牌剩余 <5 分钟时即刷新

### v0.84.1
- Qwen Token Plan Individual provider、Baseten provider（本项目不需要，保留无害）
- `pi auth check` 命令、全屏模式改进（TUI，本项目不用）
- **`Agent.reset()` 行为变更**：activeRun 时抛错而非静默清理（本项目不使用 reset）
- 新增 `shouldStopAfterTurn` hook（可选功能，未启用）
- tool_call 事件支持 `terminate`（已合入本地 agent-loop）

## 新增上游包：@earendil-works/pi-telemetry

`ai/types.ts` 新增 `import type { TelemetryContext } from "@earendil-works/pi-telemetry"`，必须嵌入：

1. `src/pi-mono/telemetry/` — 3 个文件（index/noop/memory），纯类型 + noop 实现
2. `tsconfig.json` paths 新增：`"@earendil-works/pi-telemetry": ["./src/pi-mono/telemetry/index.ts"]`
3. 根 `package.json` 新增 `"@opentelemetry/api": "^1.9.0"`（telemetry 类型依赖）

## 依赖升级（对齐上游 v0.84.1）

| 包 | 旧版 | 新版 | 原因 |
|---|---|---|---|
| @mistralai/mistralai | ^2.2.0 → 2.2.1 | ^2.2.6 | 缺 `promptCacheKey` 字段（编译错误） |
| typebox | ^1.1.24 | ^1.3.7 | 上游 TypeBox 1.3.7 |
| @google/genai | ^1.40.0 | ^1.52.0 | 对齐上游 |
| @aws-sdk/client-bedrock-runtime | ^3.1030.0 | ^3.1048.0 | 对齐上游 |
| @smithy/node-http-handler | ^4.6.1 | ^4.7.3 | 对齐上游 |
| yaml | ^2.8.3 | ^2.9.0 | 对齐上游 |
| @opentelemetry/api | — | ^1.9.0 | 新增（telemetry） |

注意：`http-proxy-agent`/`https-proxy-agent` 项目用 9.x（上游 7.x），保持项目版本。

## 升级步骤

### 1. 复制上游源码
```bash
cp -r <upstream>/packages/agent/src/* src/pi-mono/agent/
cp -r <upstream>/packages/ai/src/* src/pi-mono/ai/
rm -rf src/pi-mono/agent/harness/          # 本项目不用 TUI harness
```

### 2. .ts → .js 导入转换（三种形式，缺一不可）
```bash
find src/pi-mono -name "*.ts" -exec sed -i \
  -e 's/from "\([^"]*\)\.ts"/from "\1.js"/g' \
  -e 's/^import "\([^"]*\)\.ts"/import "\1.js"/g' \
  -e 's/import("\([^"]*\)\.ts")/import("\1.js")/g' \
  -e 's/("\([^"]*\)\.ts")/("\1.js")/g' \
  {} +
```
最后一条处理包装函数传路径字符串（`importNodeOnlyApi("./x.ts")`、`importOAuthModule("./x.ts")`）——**v0.80.2 升级时 register-builtins.ts 崩溃就是漏了这类**。

### 3. 嵌入 telemetry 包（见上）

### 4. 重放本地补丁（升级前先备份）

| 文件 | 补丁内容 | 处理方式 |
|---|---|---|
| agent/agent.ts | fallbackModels + streamFn 别名 + ohmyagent_agentName | 合并（上游新增 shouldStopAfterTurn，无重叠） |
| agent/agent-loop.ts | fallback 多模型重试循环 + compactToolsForPrompt | 以补丁版为基础，合入上游 terminate 标记 |
| agent/types.ts | fallbackModels + deferred 类型 | 合并（保留上游 terminate 字段） |
| agent/index.ts | 删除 harness 导出 | 直接覆盖补丁版 |
| agent/node.ts | 删除 NodeExecutionEnv 导出 | 直接覆盖补丁版 |
| ai/compat.ts | registerModel 自定义模型注册表 | 直接覆盖补丁版 |
| ai/providers/images/register-builtins.ts | 动态 import .js | sed 自动处理，无需重放 |
| ai/utils/oauth/{index,types}.ts | 本地独有 OAuth 兼容层 | 保留 + 适配新 API |

### 5. 同步 provider 数据 JSON
上游 `providers/data/*.json` 不在 git 仓库（生成脚本产出）。从 npm 包提取：
```bash
npm pack @earendil-works/pi-ai@0.84.1
tar xzf earendil-works-pi-ai-0.84.1.tgz
cp package/dist/providers/data/*.json src/pi-mono/ai/providers/data/
```
v0.84.1 比 v0.82.1：21 个更新 + 2 个新增（baseten、qwen-token-plan-individual）。

### 6. 上游源码类型修复（本项目 tsc 环境，上游用 tsgo）

| 文件 | 错误 | 修复 |
|---|---|---|
| ai/api/bedrock-converse-stream.ts | AWS SDK 3.1048 middleware 类型不匹配 | `(next) => async (args: any)` + `as BuildMiddleware` + `add(middleware as any, ...)` |
| ai/api/openai-codex-responses.ts | `Uint8Array<ArrayBufferLike>` 不满足 `BodyInit`（TS 5.7+ 泛型化） | `(compressedBody ?? bodyJson) as BodyInit` |
| ai/utils/oauth/index.ts | `ProviderAuthInteraction.signal` 变必填；`refresh` 新增 signal 参数 | signal 默认 `new AbortController().signal`；refresh 传第二参数 |

## 本地修改处理（本次升级验证）

- 编译：`pnpm build` 0 错误
- 测试：`pnpm test:ai` — **170 文件 / 2626 测试通过**（3 跳过，环境相关）

## 后续注意事项

- `Agent.reset()` 行为变更：activeRun 期间调用会抛错（v0.84.1 破坏性变更），若未来需要 reset 语义注意
- `shouldStopAfterTurn` 为新 hook，未接入本项目 agent 工厂
- 上游 harness 持续重构（session 拆分为 jsonl/memory/state/search/testing），本项目保持不嵌入
- 下次升级时 `@opentelemetry/api`、`typebox@1.3.x` 为前置依赖
