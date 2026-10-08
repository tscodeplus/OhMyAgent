# pi-mono v1.0.4 → v1.1.0 升级实施记录

## 版本信息

| 项目     | 内容                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 日期     | 2026-10-08                                                                                                                                                                   |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)                                                                                                                                   |
| 源版本   | v1.0.4                                                                                                                                                                       |
| 目标版本 | v1.1.0（2026-10-07 发布）                                                                                                                                                    |
| 升级难度 | **高** — 小版本但变更面大：23 个 ai 文件 + 3 个 agent 文件 + 4 个 mcp 文件 + 5 个 telemetry 文件；其中 3 个三方合并文件、1 个上游已原生吸收的本地方案、1 个 judge 内核适配点 |

## 上游变更概要

- **agent**：`durationMs` 加入 tool result / `AgentToolCallOutcome` / `tool_execution_end`；`streamProxy()` 改返回 `AssistantMessageEventStream`。
- **ai — Breaking**：流式函数必须返回 `AssistantMessageEventStream`（手写 `EventStream<AssistantMessageEvent, AssistantMessage>` 子类不再能通过类型检查）。**本项目无手写子类**（`src/agent/retrying-stream.ts` 本来就用 `AssistantMessageEventStream`），app 侧零改动。
- **ai — 新增**：`durationMs`（monotonic，从请求起点到最终消息）+ ToolResultMessage 可选 `durationMs`；`openai-decisions` 分类器 API（OpenAI Decisions，`gpt-6-luna`）；Claude Haiku 5.5；`LoginOptions.agentName`；`ClassifierContext.images`。
- **ai — 修复**：`server_busy` 等 provider 错误改为重试；Anthropic 浏览器登录端口 53692 被占（Hyper-V/WSL 保留端口）时自动回退空闲 loopback 端口；Mistral `finish_reason: "error"` 重试；Bedrock Converse 给 OpenAI 模型发 reasoning effort（#9331）；输入估算 3.5 chars/token；成本目录补 prompt-length 阶梯定价等。
- **mcp**：OAuth 全链路（dynamic 注册 / token / discovery）支持 `signal` 取消；被中止的 refresh 不再回落到重新授权；`close()` 不再在 DELETE 前刷新 token。
- **telemetry**：新增 `testing/` 目录（conformance 等），index/memory/noop 更新。

## 升级步骤（实际执行）

1. **三方合并 3 个补丁文件**（ours = vendored v1.0.4 + 本地补丁, theirs = v1.1.0）：
   - `agent/types.ts`：1 处冲突（`tool_execution_end` 多行版 + `durationMs`）取 theirs，
     **注意**：机械取 theirs 会把冲突区里 ours 的 `stream_retry` 事件成员一并吞掉
     （本次就丢了，tsc 后才发现），补回后 5 处 `OhMyAgent` 标记齐全。
   - `agent/agent-loop.ts`：1 处冲突，ours 注释 + theirs `durationMs` 合体。
   - `ai/types.ts`、`ai/api/openai-codex-responses.ts`：0 冲突。
   - `ai/api/bedrock-converse-stream.ts`：**上游 v1.1.0 已原生包含本项目全部本地补丁**
     （block_binding replay drop、`as any` 严格性修正），整文件取 theirs。
2. aisync 整树替换 `ai` / `agent` / `mcp` / `telemetry`；还原上游未动的
   `compat.ts`、`xai.ts`、`agent.ts`、`agent/index.ts`。
3. **`.js` 导入后缀注意**：上游 strip-types 风格的部分文件导入是**无扩展名**形式
   （不只是 `.ts` 形式），4 条 `.ts→.js` sed 抓不到；需要额外补一层
   `from "…"` → `from "….js"`，且注意二次运行会产生 `.js.js`（本次踩了）。
   本地补丁文件最终统一用「先补 `.js` 再全局 `.js.js→.js` 清理」的顺序执行。
4. **本地非标记 `as any` 补丁重新落上**：bedrock 两处 `middlewareStack.add`
   （上游类型缩窄在 _本项目_ 的 `@aws-sdk` 版本/严格度下仍报错）。
5. `providers/data` 从 `@earendil-works/pi-ai@1.1.0` tarball 重同步。
6. 依赖：仅内部 `pi-telemetry` 版本字串变化，无三方依赖更新。

## app 侧适配（1 处）

- `src/judge/protocol-map.ts`：v1.1.0 把 `isRecord` / `parseClassifierUsage` /
  `postClassifierRequest` / `requiredNumber` 从 `api/system-one-shared.ts`
  迁出到新的 `api/classifier-shared.ts`，且 `SystemOneTransport.output` 收窄为
  `Record<string, unknown>`（原 `unknown` 直接兼容）。只需把 `isRecord` 的导入
  指到 `classifier-shared.js`。

## 验证（含判断内核专项）

- 归一化 diff：vendored vs 上游 v1.1.0 仅剩 **5 个补丁文件**（27 处 `OhMyAgent`
  标记 + 2 处 `as any`）；`mcp` / `telemetry` 与上游逐字节一致。
- `npx tsc --noEmit` 0 错误（circular/extension 问题的关键排查路径见上）。
- **`npx vitest run tests/judge`：24 文件 / 287 测试通过**，覆盖 7 个 contract
  契约测试（cloudflare-workers-ai / custom-relay / llama-cpp / opencode /
  openrouter-hidden-slug / typesafe / vercel-ai-gateway）—— 正好压住 v1.1.0
  重构的 classifier 共享层。
- **`pnpm test` 全量：273 文件 / 4105 通过**（4114 含 skip；数量较上一版 +29
  文件为 beta3 release 之后团队新增的测试）。
- lsp 0 errors（557 条既有 `no-explicit-any` + 2 条外部 null 类 warning，均为
  升级前已有）。
- **判断内核实弹**（dev server 重启后）：`POST /api/judge/test` 金样本经
  `opencode/jev-1.13-free` → `ok: true`，三个回答类别正确
  （q1 choice→code p=1、q2 noul p=0.98、q3 score 0.05 c=0.91），台账
  `data/judge-ledger` 记录 shadow 模式 verdict；`GET /api/judge/status` 12 个
  决策点配置完整。
- WebUI es/excel-mcp 重启后 `connected`；`/api/health` 正常。

## 遗留 / 注意

- 升级时**勿盲信取 theirs**：冲突块里同时夹着 ours 独有成员时（如
  `stream_retry`）要先核对整块内容。
- 上游无扩展名导入形式今后会常态化，升级 sed 记得覆盖 `from "../x"` 模式。
